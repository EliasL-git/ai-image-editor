from __future__ import annotations

import base64
import io
from typing import Any

import numpy as np
import requests
from PIL import Image


MAX_EDGE = 1536


def load_image(source: str | bytes) -> Image.Image:
    """Load an image from a URL, data URL, or raw bytes."""
    if isinstance(source, bytes):
        data = source
    elif source.startswith("data:"):
        _, b64 = source.split(",", 1)
        data = base64.b64decode(b64)
    elif source.startswith("http://") or source.startswith("https://"):
        resp = requests.get(source, timeout=120)
        resp.raise_for_status()
        data = resp.content
    else:
        raise ValueError("Unsupported image source")

    img = Image.open(io.BytesIO(data))
    img = img.convert("RGB")
    # Downscale to keep SAM/FLUX fast
    img.thumbnail((MAX_EDGE, MAX_EDGE), Image.LANCZOS)
    return img


def image_to_png_bytes(img: Image.Image) -> bytes:
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def encode_data_url(data: bytes, mime: str = "image/png") -> str:
    return f"data:{mime};base64,{base64.b64encode(data).decode()}"


def decode_mask(source: str | bytes, size: tuple[int, int]) -> np.ndarray:
    """Decode a mask (URL/data URL/bytes) into a binary float32 array 0..1."""
    img = load_image(source)
    img = img.resize(size, Image.NEAREST).convert("L")
    arr = np.asarray(img, dtype=np.float32) / 255.0
    return arr


def mask_to_png_bytes(mask: np.ndarray) -> bytes:
    """Convert a float32 mask (0..1) to grayscale PNG bytes."""
    arr = np.clip(mask * 255.0, 0, 255).astype(np.uint8)
    img = Image.fromarray(arr, mode="L")
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def dict_response(**kwargs: Any) -> dict[str, Any]:
    return kwargs
