/**
 * Pure 2D helpers for the editor canvas: mask rasterization, geometry utilities
 * and mask compositing. Framework-agnostic — apps/web wires these into Fabric.
 */

import { fitWithin } from '@aie/shared';
import type { Point, Rect } from '@aie/types';

export interface RasterOptions {
  width: number;
  height: number;
}

/** Normalized [0..1] coordinates for the current tool stroke. */
export interface StrokeHint {
  kind: 'point' | 'box' | 'brush';
  point?: Point;
  box?: [number, number, number, number];
  points?: Point[];
}

/** Convert a normalized [0..1] point to pixel coords. */
export function denormalize(p: Point, w: number, h: number): Point {
  return { x: Math.round(p.x * w), y: Math.round(p.y * h) };
}

/** Build a normalized box from two pixel points. */
export function boxFromPoints(a: Point, b: Point, w: number, h: number): [number, number, number, number] {
  const x0 = Math.min(a.x, b.x) / w;
  const y0 = Math.min(a.y, b.y) / h;
  const x1 = Math.max(a.x, b.x) / w;
  const y1 = Math.max(a.y, b.y) / h;
  return [x0, y0, x1, y1];
}

/**
 * Rasterize a normalized stroke hint into an RGBA mask image (Uint8ClampedArray).
 * White (255) = selected/editable region, transparent elsewhere.
 * Used locally for instant feedback and to build the mask payload for FLUX.
 */
export function rasterizeHint(hint: StrokeHint, opts: RasterOptions): Uint8ClampedArray {
  const { width, height } = opts;
  const data = new Uint8ClampedArray(width * height * 4);
  const setPx = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const i = (y * width + x) * 4;
    data[i] = 255;
    data[i + 1] = 255;
    data[i + 2] = 255;
    data[i + 3] = 255;
  };

  if (hint.kind === 'point' && hint.point) {
    const p = denormalize(hint.point, width, height);
    const r = Math.max(8, Math.round(Math.min(width, height) * 0.04));
    for (let y = -r; y <= r; y++) {
      for (let x = -r; x <= r; x++) {
        if (x * x + y * y <= r * r) setPx(p.x + x, p.y + y);
      }
    }
  }

  if (hint.kind === 'box' && hint.box) {
    const [x0, y0, x1, y1] = hint.box;
    const px0 = Math.round(x0 * width);
    const py0 = Math.round(y0 * height);
    const px1 = Math.round(x1 * width);
    const py1 = Math.round(y1 * height);
    for (let y = py0; y <= py1; y++) {
      for (let x = px0; x <= px1; x++) setPx(x, y);
    }
  }

  if (hint.kind === 'brush' && hint.points && hint.points.length > 0) {
    const r = Math.max(4, Math.round(Math.min(width, height) * 0.012));
    for (const pt of hint.points) {
      const p = denormalize(pt, width, height);
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (dx * dx + dy * dy <= r * r) setPx(p.x + dx, p.y + dy);
        }
      }
    }
  }

  return data;
}

/** Convert a Uint8ClampedArray RGBA mask to a PNG data URL (white = selected). */
export function maskToDataUrl(mask: Uint8ClampedArray, width: number, height: number): string {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D not available');
  const img = ctx.createImageData(width, height);
  img.data.set(mask);
  ctx.putImageData(img, 0, 0);
  return canvas.toDataURL('image/png');
}

/** Feather (blur) a binary mask so edits blend naturally at the edges. */
export function featherMask(mask: Uint8ClampedArray, width: number, height: number, radius = 3): Uint8ClampedArray {
  const out = new Uint8ClampedArray(mask.length);
  const k = 2 * radius + 1;
  const kernel = new Float32Array(k);
  for (let i = 0; i < k; i++) kernel[i] = 1 / k;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let acc = 0;
      for (let dx = -radius; dx <= radius; dx++) {
        const sx = Math.min(width - 1, Math.max(0, x + dx));
        const si = (y * width + sx) * 4;
        acc += (mask[si] / 255) * kernel[dx + radius];
      }
      const oi = (y * width + x) * 4;
      out[oi] = out[oi + 1] = out[oi + 2] = acc * 255;
      out[oi + 3] = 255;
    }
  }
  return out;
}

/** Compute the bounding box (in pixels) of a binary mask. Returns null if empty. */
export function maskBounds(mask: Uint8ClampedArray, width: number, height: number): Rect | null {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (mask[i] > 32) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

/** Resize an image data URL, returning a new data URL (used to build FLUX inputs). */
export async function resizeImageDataUrl(
  url: string,
  maxEdge: number,
): Promise<{ url: string; width: number; height: number }> {
  const img = await loadImage(url);
  const { width, height, scale } = fitWithin(img.naturalWidth || img.width, img.naturalHeight || img.height, maxEdge);
  if (scale >= 1) return { url, width: img.naturalWidth || img.width, height: img.naturalHeight || img.height };
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D not available');
  ctx.drawImage(img, 0, 0, width, height);
  return { url: canvas.toDataURL('image/png'), width, height };
}

export function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Failed to load image'));
    img.src = url;
  });
}

/** Composite a mask overlay onto a base canvas at a given opacity. */
export function drawMaskOverlay(
  ctx: CanvasRenderingContext2D,
  mask: Uint8ClampedArray,
  width: number,
  height: number,
  color = '34, 211, 238',
  alpha = 0.35,
): void {
  ctx.save();
  const img = ctx.createImageData(width, height);
  for (let i = 0; i < mask.length; i += 4) {
    const a = mask[i] / 255;
    img.data[i] = Number(color.split(',')[0]);
    img.data[i + 1] = Number(color.split(',')[1]);
    img.data[i + 2] = Number(color.split(',')[2]);
    img.data[i + 3] = Math.round(a * alpha * 255);
  }
  ctx.putImageData(img, 0, 0);
  ctx.restore();
}

export type { Point, Rect };
