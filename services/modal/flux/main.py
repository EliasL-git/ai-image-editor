from __future__ import annotations

import math
import os
import shutil
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

# Shared progress store: GPU containers write per-job progress here; the Express
# API polls it via web_status. Xet is disabled because its lazy symlinks don't
# survive a Modal volume commit.
progress_store = modal.Dict.from_name("flux-progress", create_if_missing=True)

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
    .env({"HF_HOME": "/models/hf", "HF_HUB_DISABLE_XET": "1"})
)


def download_flux() -> None:
    """Ensure the FLUX Kontext Dev weights are cached on the volume."""
    os.makedirs("/models/hf", exist_ok=True)
    from huggingface_hub import snapshot_download

    snapshot_download(
        "black-forest-labs/FLUX.1-Kontext-dev",
        local_dir="/models/hf/FLUX.1-Kontext-dev",
    )


def download_flux_dev() -> None:
    """Ensure the FLUX.1-dev (text-to-image) weights are cached on the volume.

    We wipe any prior partial/broken download first (a previous Xet-backed
    download left symlinks that don't survive a Modal volume commit).
    """
    os.makedirs("/models/hf", exist_ok=True)
    dest = "/models/hf/FLUX.1-dev"
    if os.path.exists(dest):
        log("clearing previous FLUX.1-dev download…")
        shutil.rmtree(dest)
    from huggingface_hub import snapshot_download

    snapshot_download(
        "black-forest-labs/FLUX.1-dev",
        local_dir=dest,
    )


def _decode_latents(pipe, latents, max_size: int = 288):
    """Decode denoising latents into a small PIL preview (mirrors final pipeline decode)."""
    import torch
    from PIL import Image as PILImage

    with torch.no_grad():
        image = pipe.vae.decode(latents / pipe.vae.config.scaling_factor, return_dict=False)[0]
    pil = pipe.image_processor.postprocess(image, output_type="pil")[0].convert("RGB")
    if max(pil.size) > max_size:
        pil = pil.resize((max_size, max_size), PILImage.LANCZOS)
    return pil


def _progress(pipe, job_id: str, step_index: int, total: int, sample_every: int, callback_kwargs: dict) -> dict:
    """Store a progress frame for the job when the step should be sampled."""
    if step_index % sample_every == 0:
        try:
            pil = _decode_latents(pipe, callback_kwargs["latents"])
            png = image_to_png_bytes(pil)
            progress = round(35 + 60 * ((step_index + 1) / total))
            progress_store[job_id] = {
                "type": "progress",
                "progress": progress,
                "stage": f"step {step_index + 1}/{total}",
                "preview": encode_data_url(png),
            }
        except Exception as e:
            log(f"preview decode failed: {e}")
    return callback_kwargs


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
    def edit(self, job_id: str, image: str | bytes, prompt: str, mask: str, strength: float = 0.85, seed: Optional[int] = None) -> dict:
        import numpy as np
        import torch
        from PIL import Image as PILImage

        try:
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
                f"edit job={job_id} prompt={prompt!r} image={src_w}x{src_h}→{w}x{h} "
                f"mask_coverage={coverage:.1f}% strength={strength} seed={seed} steps=50 guidance=3.5"
            )

            # FluxKontextInpaintPipeline expects a PIL mask image (white = edit region).
            mask_pil = PILImage.fromarray((mask_np * 255).astype(np.uint8), mode="L")
            gen = torch.Generator(device="cuda").manual_seed(seed if seed is not None else int(time.time()))

            num_steps = 50
            denoise_steps = math.ceil(strength * num_steps)
            sample_every = max(1, denoise_steps // 5)
            t_gen = time.time()

            result = self._pipe(
                prompt=prompt,
                image=src_resized,
                mask_image=mask_pil,
                strength=strength,
                num_inference_steps=num_steps,
                guidance_scale=3.5,
                max_sequence_length=512,
                generator=gen,
                output_type="pil",
                callback_on_step_end=lambda pipe, i, t, kw: _progress(pipe, job_id, i, denoise_steps, sample_every, kw),
                callback_on_step_end_tensor_inputs=["latents"],
            ).images[0]
            log(f"inference took {time.time() - t_gen:.1f}s")

            png = image_to_png_bytes(result.convert("RGB"))
            latency = (time.time() - started) * 1000
            log(f"edit done in {latency:.0f}ms → {result.width}x{result.height} ({len(png)} bytes)")
            progress_store[job_id] = {
                "type": "result",
                "imageUrl": encode_data_url(png),
                "width": result.width,
                "height": result.height,
                "latencyMs": int(latency),
            }
            return {"ok": True}
        except Exception as e:
            log(f"edit FAILED: {e}")
            progress_store[job_id] = {"type": "error", "message": f"{e}"}
            raise


@app.function(image=FLUX_IMAGE, volumes={"/models": volume}, secrets=[modal.Secret.from_name("hf-token")])
def _warm() -> None:
    download_flux()
    download_flux_dev()


@app.local_entrypoint()
def warm() -> None:
    """Pre-download model weights: modal run -m flux.main::warm"""
    _warm.remote()


@app.function(image=FLUX_IMAGE, volumes={"/models": volume}, secrets=[modal.Secret.from_name("hf-token")])
@modal.fastapi_endpoint(method="POST")
def web_edit(payload: dict) -> dict:
    """Start a FLUX Kontext edit asynchronously. Returns immediately; progress is polled via web_status."""
    from fastapi import HTTPException

    job_id = payload.get("jobId")
    if not job_id:
        raise HTTPException(status_code=400, detail="jobId is required")
    try:
        svc = FluxKontext()
        svc.edit.spawn(
            job_id,
            payload["image"],
            payload["prompt"],
            payload["mask"],
            payload.get("strength", 0.85),
            payload.get("seed"),
        )
        log(f"edit started job={job_id}")
        return {"accepted": True, "jobId": job_id}
    except Exception as e:
        log(f"FLUX edit start failed: {e}")
        progress_store[job_id] = {"type": "error", "message": f"FLUX edit start failed: {e}"}
        raise HTTPException(status_code=500, detail=f"FLUX edit start failed: {e}")


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
        log("container starting — loading FLUX.1-dev…")
        self._pipe = FluxPipeline.from_pretrained(
            "/models/hf/FLUX.1-dev",
            torch_dtype=torch.bfloat16,
        ).to("cuda")
        log(f"FLUX.1-dev loaded in {time.time() - t0:.1f}s")

    @modal.method()
    def generate(self, job_id: str, prompt: str, seed: Optional[int] = None) -> dict:
        import torch

        try:
            started = time.time()
            total_steps = 30
            log(f"generate job={job_id} prompt={prompt!r} seed={seed} steps={total_steps} guidance=3.5 (FLUX.1-dev)")

            gen = torch.Generator(device="cuda").manual_seed(seed if seed is not None else int(time.time()))
            sample_every = max(1, total_steps // 6)
            t_gen = time.time()

            result = self._pipe(
                prompt=prompt,
                num_inference_steps=total_steps,
                guidance_scale=3.5,
                max_sequence_length=512,
                generator=gen,
                output_type="pil",
                callback_on_step_end=lambda pipe, i, t, kw: _progress(pipe, job_id, i, total_steps, sample_every, kw),
                callback_on_step_end_tensor_inputs=["latents"],
            ).images[0]
            log(f"inference took {time.time() - t_gen:.1f}s")

            png = image_to_png_bytes(result.convert("RGB"))
            latency = (time.time() - started) * 1000
            log(f"generate done in {latency:.0f}ms → {result.width}x{result.height} ({len(png)} bytes)")
            progress_store[job_id] = {
                "type": "result",
                "imageUrl": encode_data_url(png),
                "width": result.width,
                "height": result.height,
                "latencyMs": int(latency),
            }
            return {"ok": True}
        except Exception as e:
            log(f"generate FAILED: {e}")
            progress_store[job_id] = {"type": "error", "message": f"{e}"}
            raise


@app.function(image=FLUX_IMAGE, volumes={"/models": volume}, secrets=[modal.Secret.from_name("hf-token")])
@modal.fastapi_endpoint(method="POST")
def web_generate(payload: dict) -> dict:
    """Start FLUX.1-dev text-to-image asynchronously. Progress is polled via web_status."""
    from fastapi import HTTPException

    job_id = payload.get("jobId")
    if not job_id:
        raise HTTPException(status_code=400, detail="jobId is required")
    try:
        svc = FluxGenerate()
        svc.generate.spawn(job_id, payload["prompt"], payload.get("seed"))
        log(f"generate started job={job_id}")
        return {"accepted": True, "jobId": job_id}
    except Exception as e:
        log(f"FLUX generate start failed: {e}")
        progress_store[job_id] = {"type": "error", "message": f"FLUX generate start failed: {e}"}
        raise HTTPException(status_code=500, detail=f"FLUX generate start failed: {e}")


@app.function(image=FLUX_IMAGE)
@modal.fastapi_endpoint(method="POST")
def web_status(payload: dict):
    """Return the current progress frame for a job (or null while it warms up)."""
    return progress_store.get(payload.get("jobId"))


@app.function(image=FLUX_IMAGE)
@modal.fastapi_endpoint(method="POST")
def web_clear(payload: dict) -> dict:
    """Drop a job's progress frame from the store once the API is done with it."""
    job_id = payload.get("jobId")
    if job_id and job_id in progress_store:
        del progress_store[job_id]
    return {"cleared": True}
