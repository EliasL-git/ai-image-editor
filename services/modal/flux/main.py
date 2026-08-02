from __future__ import annotations

import time
from datetime import datetime, timezone
from typing import Optional

import modal

from .shared import decode_mask, encode_data_url, image_to_png_bytes, load_image

app = modal.App("flux-kontext")


def log(msg: str) -> None:
    ts = datetime.now(timezone.utc).strftime("%H:%M:%S.%f")[:-3]
    print(f"[flux {ts}] {msg}", flush=True)

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

    log(f"{label}: {e}")
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


def download_flux_schnell() -> None:
    """Ensure the FLUX.1-schnell (text-to-image) weights are cached on the volume."""
    import os

    os.makedirs("/models/hf", exist_ok=True)
    from huggingface_hub import snapshot_download

    snapshot_download(
        "black-forest-labs/FLUX.1-schnell",
        local_dir="/models/hf/FLUX.1-schnell",
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
            FluxKontextInpaintPipeline,
            FluxTransformer2DModel,
        )
        from transformers import CLIPTextModel, CLIPTokenizer, T5EncoderModel, T5TokenizerFast

        base = "/models/hf/FLUX.1-Kontext-dev"
        t0 = time.time()
        log("container starting — loading FLUX.1 Kontext Dev…")
        self._dtype = torch.bfloat16

        self._scheduler = FlowMatchEulerDiscreteScheduler.from_pretrained(base, subfolder="scheduler")
        self._text_encoder = CLIPTextModel.from_pretrained(base, subfolder="text_encoder", torch_dtype=self._dtype)
        log("  CLIP text encoder loaded")
        self._tokenizer = CLIPTokenizer.from_pretrained(base, subfolder="tokenizer")
        self._text_encoder_2 = T5EncoderModel.from_pretrained(base, subfolder="text_encoder_2", torch_dtype=self._dtype)
        self._tokenizer_2 = T5TokenizerFast.from_pretrained(base, subfolder="tokenizer_2")
        log("  T5 text encoder loaded")
        self._vae = AutoencoderKL.from_pretrained(base, subfolder="vae", torch_dtype=self._dtype)
        log("  VAE loaded")
        self._transformer = FluxTransformer2DModel.from_pretrained(base, subfolder="transformer", torch_dtype=self._dtype)
        log("  transformer loaded")

        self._pipe = FluxKontextInpaintPipeline(
            scheduler=self._scheduler,
            text_encoder=self._text_encoder,
            tokenizer=self._tokenizer,
            text_encoder_2=self._text_encoder_2,
            tokenizer_2=self._tokenizer_2,
            vae=self._vae,
            transformer=self._transformer,
        ).to("cuda")
        log(f"model loaded in {time.time() - t0:.1f}s")

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

        # Decode mask (already 0..1 float at source resolution, white = edit region)
        mask_np = decode_mask(mask, (src_w, src_h))
        if mask_np.shape != (h, w):
            mask_img = PILImage.fromarray((mask_np * 255).astype(np.uint8)).resize((w, h), PILImage.NEAREST)
            mask_np = np.asarray(mask_img, dtype=np.float32) / 255.0

        coverage = float((mask_np > 0.5).mean()) * 100
        log(
            f"edit prompt={prompt!r} image={src_w}x{src_h}→{w}x{h} "
            f"mask_coverage={coverage:.1f}% strength={strength} seed={seed} steps=50 guidance=3.5"
        )

        # FluxKontextInpaintPipeline expects a PIL mask image (white = edit region).
        mask_pil = PILImage.fromarray((mask_np * 255).astype(np.uint8), mode="L")
        gen = torch.Generator(device="cuda").manual_seed(seed if seed is not None else int(time.time()))

        t_gen = time.time()
        result = self._pipe(
            prompt=prompt,
            image=src_resized,
            mask_image=mask_pil,
            strength=strength,
            num_inference_steps=50,
            guidance_scale=3.5,
            max_sequence_length=512,
            generator=gen,
            output_type="pil",
        ).images[0]
        log(f"inference took {time.time() - t_gen:.1f}s")

        png = image_to_png_bytes(result.convert("RGB"))
        latency = (time.time() - started) * 1000
        log(f"edit done in {latency:.0f}ms → {result.width}x{result.height} ({len(png)} bytes)")
        return {
            "imageUrl": encode_data_url(png),
            "width": result.width,
            "height": result.height,
            "latencyMs": int(latency),
        }


@app.function(image=FLUX_IMAGE, volumes={"/models": volume}, secrets=[modal.Secret.from_name("hf-token")])
def _warm() -> None:
    download_flux()
    download_flux_schnell()


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
class FluxGenerate:
    @modal.enter()
    def load(self) -> None:
        import torch
        from diffusers import FluxPipeline

        t0 = time.time()
        log("container starting — loading FLUX.1-schnell…")
        self._pipe = FluxPipeline.from_pretrained(
            "/models/hf/FLUX.1-schnell",
            torch_dtype=torch.bfloat16,
        ).to("cuda")
        log(f"schnell loaded in {time.time() - t0:.1f}s")

    @modal.method()
    def generate(self, prompt: str, seed: Optional[int] = None) -> dict:
        import time

        import torch

        started = time.time()
        log(f"generate prompt={prompt!r} seed={seed} steps=4 guidance=0")

        t_gen = time.time()
        gen = torch.Generator(device="cuda").manual_seed(seed if seed is not None else int(time.time()))

        result = self._pipe(
            prompt=prompt,
            num_inference_steps=4,
            guidance_scale=0.0,
            generator=gen,
            output_type="pil",
        ).images[0]
        log(f"inference took {time.time() - t_gen:.1f}s")

        png = image_to_png_bytes(result.convert("RGB"))
        latency = (time.time() - started) * 1000
        log(f"generate done in {latency:.0f}ms → {result.width}x{result.height} ({len(png)} bytes)")
        return {
            "imageUrl": encode_data_url(png),
            "width": result.width,
            "height": result.height,
            "latencyMs": int(latency),
        }


@app.function(image=FLUX_IMAGE, volumes={"/models": volume}, secrets=[modal.Secret.from_name("hf-token")])
@modal.fastapi_endpoint(method="POST")
def web_generate(payload: dict) -> dict:
    """HTTP endpoint used by the Express API: POST /generate (JSON body)"""
    try:
        svc = FluxGenerate()
        return svc.generate.remote(prompt=payload["prompt"], seed=payload.get("seed"))
    except Exception as e:
        _http_error(e, "FLUX generate failed")
