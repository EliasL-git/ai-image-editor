from __future__ import annotations

import time
from datetime import datetime, timezone
from typing import Optional

import modal

from .shared import (
    decode_mask,
    encode_data_url,
    image_to_png_bytes,
    load_image,
    mask_to_png_bytes,
)


def log(msg: str) -> None:
    ts = datetime.now(timezone.utc).strftime("%H:%M:%S.%f")[:-3]
    print(f"[sam2 {ts}] {msg}", flush=True)

app = modal.App("sam2-segment")

# Model weights are downloaded once to a shared volume and reused across
# warm containers — GPUs idle-shrink to zero when no requests are in flight.
volume = modal.Volume.from_name("aie-models", create_if_missing=True)

SAM2_IMAGE = (
    modal.Image.debian_slim(python_version="3.11")
    .pip_install(
        "torch>=2.3",
        "torchvision>=0.18",
        "opencv-python-headless>=4.9",
        "pillow>=10.4",
        "numpy>=1.26",
        "requests>=2.32",
        "fastapi>=0.115",
        "uvicorn>=0.32",
    )
    .apt_install("git")
    .run_commands(
        # Clone into /opt (not /root) so the repo directory name "sam2" can never
        # shadow the installed `sam2` package or the app package at /root/sam2service.
        "git clone --depth 1 https://github.com/facebookresearch/sam2.git /opt/sam2-repo",
        "pip install -e /opt/sam2-repo",
    )
)


def download_sam2() -> None:
    """Fetch SAM 2 checkpoint (and hydra configs) into the shared volume."""
    import os

    os.makedirs("/models/sam2", exist_ok=True)
    checkpoint_dir = "/models/sam2"
    ckpt = os.path.join(checkpoint_dir, "sam2.1_hiera_large.pt")
    if not os.path.exists(ckpt):
        # SAM 2.1 large from the official release bucket
        url = (
            "https://dl.fbaipublicfiles.com/segment_anything_2/092824/"
            "sam2.1_hiera_large.pt"
        )
        import urllib.request

        print("[sam2] downloading checkpoint…")
        urllib.request.urlretrieve(url, ckpt)
        print("[sam2] checkpoint downloaded")


@app.cls(
    image=SAM2_IMAGE,
    gpu="A10G",
    timeout=600,
    volumes={"/models": volume},
    secrets=[modal.Secret.from_name("hf-token")],
)
# A container is recycled (terminated) after a single request, so it never
# lingers after a job finishes or fails.
@modal.concurrent(max_inputs=1)
class Sam2Service:
    @modal.enter()
    def load(self) -> None:
        from sam2.build_sam import build_sam2
        from sam2.sam2_image_predictor import SAM2ImagePredictor

        t0 = time.time()
        log("container starting — loading SAM 2.1 Large…")
        download_sam2()
        checkpoint = "/models/sam2/sam2.1_hiera_large.pt"
        # Absolute path to the hydra config inside the cloned repo; hydra resolves
        # relative config names against the working dir, which won't contain configs.
        cfg = "/opt/sam2-repo/configs/sam2.1/sam2.1_hiera_l.yaml"
        self._model = build_sam2(cfg, checkpoint, device="cuda")
        self._predictor = SAM2ImagePredictor(self._model)
        log(f"model loaded in {time.time() - t0:.1f}s")

    @modal.method()
    def segment(
        self,
        image: str | bytes,
        mode: str = "brush",
        point: Optional[dict] = None,
        box: Optional[list] = None,
        points: Optional[list] = None,
    ) -> dict:
        import numpy as np
        import torch

        started = time.time()
        log(f"segment mode={mode} image_bytes={len(image) if isinstance(image, (bytes, bytearray)) else len(image)}")
        if mode == "point":
            log(f"  point={point}")
        elif mode == "box":
            log(f"  box={box}")
        elif mode == "brush":
            log(f"  brush_points={len(points or [])}")

        img = load_image(image)
        w, h = img.size
        log(f"image {w}x{h}")

        t_set = time.time()
        self._predictor.set_image(np.asarray(img))
        log(f"set_image in {(time.time() - t_set) * 1000:.0f}ms")

        if mode == "point" and point is not None:
            x = int(point["x"] * w)
            y = int(point["y"] * h)
            log(f"  prompt point=({x},{y})")
            masks, scores, _ = self._predictor.predict(
                point_coords=np.array([[x, y]]),
                point_labels=np.array([1]),
                multimask_output=True,
            )
        elif mode == "box" and box is not None:
            x0, y0, x1, y1 = box
            log(f"  prompt box=({x0:.3f},{y0:.3f},{x1:.3f},{y1:.3f}) → px=({x0*w:.0f},{y0*h:.0f},{x1*w:.0f},{y1*h:.0f})")
            masks, scores, _ = self._predictor.predict(
                point_coords=None,
                box=np.array([[x0 * w, y0 * h, x1 * w, y1 * h]]),
                multimask_output=False,
            )
        elif mode == "brush" and points is not None:
            coords = np.array([[p["x"] * w, p["y"] * h] for p in points])
            labels = np.ones(len(coords), dtype=np.int32)
            log(f"  prompt brush coords={coords.tolist()}")
            masks, scores, _ = self._predictor.predict(
                point_coords=coords,
                point_labels=labels,
                multimask_output=True,
            )
        else:
            raise ValueError("Invalid selection mode or missing coordinates")

        # Pick highest-scoring mask
        best = int(np.argmax(scores))
        mask = masks[best].astype(np.float32)
        coverage = float((mask > 0.5).mean()) * 100
        log(f"predict done — {len(scores)} masks, best score={float(scores[best]):.3f}, mask coverage={coverage:.1f}%")

        # Feather edges slightly for natural blending
        mask = _feather(mask, radius=2)

        mask_img = mask_to_png_bytes(mask)
        latency = (time.time() - started) * 1000
        log(f"segment done in {latency:.0f}ms → mask {w}x{h} ({len(mask_img)} bytes)")
        return {
            "maskUrl": encode_data_url(mask_img),
            "maskWidth": w,
            "maskHeight": h,
            "latencyMs": int(latency),
        }


def _feather(mask: np.ndarray, radius: int = 2) -> np.ndarray:
    import cv2

    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (radius * 2 + 1, radius * 2 + 1))
    dilated = cv2.dilate(mask, kernel, iterations=1)
    blurred = cv2.GaussianBlur(dilated, (0, 0), sigmaX=1.0)
    return blurred


@app.function(image=SAM2_IMAGE, volumes={"/models": volume}, secrets=[modal.Secret.from_name("hf-token")])
def _warm() -> None:
    download_sam2()


@app.local_entrypoint()
def warm() -> None:
    """Pre-download model weights: modal run sam2service.main:warm"""
    _warm.remote()


@app.function()
def segment(
    image: str,
    mode: str = "brush",
    point: Optional[dict] = None,
    box: Optional[list] = None,
    points: Optional[list] = None,
) -> dict:
    """Standalone entry for direct calls: modal run sam2service.main:segment …"""
    svc = Sam2Service()
    return svc.segment.remote(image, mode, point, box, points)


@app.function(image=SAM2_IMAGE, volumes={"/models": volume}, secrets=[modal.Secret.from_name("hf-token")])
@modal.fastapi_endpoint(method="POST")
def web_segment(payload: dict) -> dict:
    """HTTP endpoint used by the Express API: POST /segment (JSON body)"""
    try:
        svc = Sam2Service()
        return svc.segment.remote(
            image=payload["image"],
            mode=payload.get("mode", "brush"),
            point=payload.get("point"),
            box=payload.get("box"),
            points=payload.get("points"),
        )
    except Exception as e:
        from fastapi import HTTPException

        raise HTTPException(status_code=500, detail=f"SAM 2 segmentation failed: {e}")
