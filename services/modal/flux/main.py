from __future__ import annotations

import time
from typing import Optional

import modal

from .shared import decode_mask, encode_data_url, image_to_png_bytes, load_image

app = modal.App("flux-kontext")

# Shared model volume (same one SAM uses) so weights are downloaded once.
volume = modal.Volume.from_name("aie-models", create_if_missing=True)

FLUX_IMAGE = (
    modal.Image.debian_slim(python_version="3.11")
    .pip_install(
        "torch>=2.3",
        "diffusers>=0.31",
        "transformers>=4.44",
        "accelerate>=0.34",
        "sentencepiece>=0.2",
        "protobuf>=4.25",
        "pillow>=10.4",
        "numpy>=1.26",
        "requests>=2.32",
        "fastapi>=0.115",
        "uvicorn>=0.32",
    )
    .env({"HF_HOME": "/models/hf", "HF_HUB_ENABLE_HF_TRANSFER": "1"})
)


def _http_error(e: Exception, label: str) -> None:
    """Raise a FastAPI error carrying the underlying failure so the API can show it."""
    from fastapi import HTTPException

    raise HTTPException(status_code=500, detail=f"{label}: {e}")


def download_flux() -> None:
    """Ensure the FLUX Kontext Dev weights are cached on the volume."""
    import os

    os.makedirs("/models/hf", exist_ok=True)
    from huggingface_hub import snapshot_download

    snapshot_download(
        "black-forest-labs/FLUX.1-Kontext-dev",
        local_dir="/models/hf/FLUX.1-Kontext-dev",
    )


@app.cls(
    image=FLUX_IMAGE,
    gpu="A100-40GB",
    timeout=900,
    volumes={"/models": volume},
    secrets=[modal.Secret.from_name("hf-token")],
)
# A container is recycled (terminated) after a single generation, so it never
# lingers after a job finishes or fails.
@modal.concurrent(max_inputs=1)
class FluxKontext:
    @modal.enter()
    def load(self) -> None:
        import torch
        from diffusers import (
            AutoencoderKL,
            FlowMatchEulerDiscreteScheduler,
            FluxPipeline,
            FluxTransformer2DModel,
        )
        from transformers import CLIPTextModel, CLIPTokenizer, T5EncoderModel, T5TokenizerFast

        base = "/models/hf/FLUX.1-Kontext-dev"
        print("[flux] loading Kontext Dev…")
        self._dtype = torch.bfloat16

        self._scheduler = FlowMatchEulerDiscreteScheduler.from_pretrained(base, subfolder="scheduler")
        self._text_encoder = CLIPTextModel.from_pretrained(base, subfolder="text_encoder", torch_dtype=self._dtype)
        self._tokenizer = CLIPTokenizer.from_pretrained(base, subfolder="tokenizer")
        self._text_encoder_2 = T5EncoderModel.from_pretrained(base, subfolder="text_encoder_2", torch_dtype=self._dtype)
        self._tokenizer_2 = T5TokenizerFast.from_pretrained(base, subfolder="tokenizer_2")
        self._vae = AutoencoderKL.from_pretrained(base, subfolder="vae", torch_dtype=self._dtype)
        self._transformer = FluxTransformer2DModel.from_pretrained(base, subfolder="transformer", torch_dtype=self._dtype)

        self._pipe = FluxPipeline(
            scheduler=self._scheduler,
            text_encoder=self._text_encoder,
            tokenizer=self._tokenizer,
            text_encoder_2=self._text_encoder_2,
            tokenizer_2=self._tokenizer_2,
            vae=self._vae,
            transformer=self._transformer,
        ).to("cuda")
        print("[flux] model loaded")

    @modal.method()
    def edit(self, image: str | bytes, prompt: str, mask: str, strength: float = 0.85, seed: Optional[int] = None) -> dict:
        import numpy as np
        import torch
        from PIL import Image as PILImage

        started = time.time()

        src = load_image(image)
        src_w, src_h = src.size

        # Standard FLUX edit sizing (divisible by 16)
        w = max(256, min(1024, (src_w // 16) * 16))
        h = max(256, min(1024, (src_h // 16) * 16))

        src_resized = src.resize((w, h), PILImage.LANCZOS)

        # Decode mask (already 0..1 float at source resolution), resize to target
        mask_np = decode_mask(mask, (src_w, src_h))
        if mask_np.shape != (h, w):
            mask_img = PILImage.fromarray((mask_np * 255).astype(np.uint8)).resize((w, h), PILImage.NEAREST)
            mask_np = np.asarray(mask_img, dtype=np.float32) / 255.0

        mask_t = torch.from_numpy(mask_np).float().unsqueeze(0).unsqueeze(0)  # 1,1,h,w
        gen = torch.Generator(device="cuda").manual_seed(seed if seed is not None else int(time.time()))

        result = self._pipe(
            prompt=prompt,
            image=src_resized,
            mask_image=mask_t,
            strength=strength,
            num_inference_steps=28,
            guidance_scale=7.0,
            generator=gen,
            output_type="pil",
        ).images[0]

        png = image_to_png_bytes(result.convert("RGB"))
        return {
            "imageUrl": encode_data_url(png),
            "width": result.width,
            "height": result.height,
            "latencyMs": int((time.time() - started) * 1000),
        }


@app.function(image=FLUX_IMAGE, volumes={"/models": volume}, secrets=[modal.Secret.from_name("hf-token")])
def _warm() -> None:
    download_flux()


@app.local_entrypoint()
def warm() -> None:
    """Pre-download model weights: modal run flux.main:warm"""
    _warm.remote()


@app.function(image=FLUX_IMAGE, volumes={"/models": volume}, secrets=[modal.Secret.from_name("hf-token")])
@modal.fastapi_endpoint(method="POST")
def web_edit(payload: dict) -> dict:
    """HTTP endpoint used by the Express API: POST /edit (JSON body)"""
    try:
        svc = FluxKontext()
        return svc.edit.remote(
            image=payload["image"],
            prompt=payload["prompt"],
            mask=payload["mask"],
            strength=payload.get("strength", 0.85),
            seed=payload.get("seed"),
        )
    except Exception as e:
        _http_error(e, "FLUX edit failed")
