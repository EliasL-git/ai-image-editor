import { config, isLocalFallback } from './config.js';
import { readFileByUrl } from './uploads.js';
import type { EditJobInput, SegmentJobInput } from '@aie/types';

/**
 * Thin HTTP client for the Modal-deployed SAM 2 and FLUX Kontext services.
 * Falls back to deterministic local behavior when MODAL_*_URL is unset so the
 * whole canvas flow is testable without GPU credentials.
 */

export interface SegmentResponse {
  maskUrl: string;
  maskWidth: number;
  maskHeight: number;
  latencyMs: number;
}

export interface EditResponse {
  imageUrl: string;
  width: number;
  height: number;
  latencyMs: number;
}

async function postJson<T>(url: string, body: unknown, tokenId?: string, tokenSecret?: string): Promise<T> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (tokenId && tokenSecret) {
    headers.authorization = `Basic ${Buffer.from(`${tokenId}:${tokenSecret}`).toString('base64')}`;
  }
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Modal request failed (${res.status}): ${text.slice(0, 300)}`);
  }
  return (await res.json()) as T;
}

/** Local fallback: build a deterministic mask image (PNG data URL) from the hint. */
function fallbackMask(input: SegmentJobInput): { url: string; width: number; height: number } {
  const width = 512;
  const height = 512;
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D context unavailable');

  // Center-ish ellipse sized from the hint so the overlay visibly tracks the selection.
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  let rx = 0.3 * width;
  let ry = 0.3 * height;
  let cx = 0.5 * width;
  let cy = 0.5 * height;
  if (input.mode === 'point' && input.point) {
    cx = input.point.x * width;
    cy = input.point.y * height;
    rx = 0.15 * width;
    ry = 0.15 * height;
  } else if (input.mode === 'box' && input.box) {
    const [x0, y0, x1, y1] = input.box;
    cx = ((x0 + x1) / 2) * width;
    cy = ((y0 + y1) / 2) * height;
    rx = Math.max(10, ((x1 - x0) / 2) * width);
    ry = Math.max(10, ((y1 - y0) / 2) * height);
  } else if (input.mode === 'brush' && input.points && input.points.length > 0) {
    const xs = input.points.map((p) => p.x);
    const ys = input.points.map((p) => p.y);
    cx = (Math.min(...xs) + Math.max(...xs)) / 2 * width;
    cy = (Math.min(...ys) + Math.max(...ys)) / 2 * height;
    rx = Math.max(20, ((Math.max(...xs) - Math.min(...xs)) / 2 + 0.05) * width);
    ry = Math.max(20, ((Math.max(...ys) - Math.min(...ys)) / 2 + 0.05) * height);
  }
  ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
  ctx.fill();
  const url = canvas.convertToBlob ? '' : canvas.toDataURL('image/png');
  // OffscreenCanvas has no toDataURL; encode via a blob read.
  const blobUrl = url || canvasToDataUrl(canvas);
  return { url: blobUrl, width, height };
}

async function canvasToDataUrl(canvas: OffscreenCanvas): Promise<string> {
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  const buf = Buffer.from(await blob.arrayBuffer());
  return `data:image/png;base64,${buf.toString('base64')}`;
}

/** Local fallback: echo the input image back (the flow is fully testable offline). */
async function fallbackEdit(input: EditJobInput & { imageUrl: string }): Promise<EditResponse> {
  // Try to read the actual stored upload so the client sees a real image.
  const local = readFileByUrl(input.imageUrl);
  const imageUrl = local
    ? `data:image/png;base64,${local.toString('base64')}`
    : input.imageUrl;
  return { imageUrl, width: 1024, height: 1024, latencyMs: 80 };
}

export async function requestSegment(input: SegmentJobInput): Promise<SegmentResponse> {
  if (isLocalFallback() || !config.modalSamUrl) {
    const mask = await fallbackMask(input);
    return { ...mask, latencyMs: 120 };
  }
  const res = await postJson<SegmentResponse>(
    `${config.modalSamUrl.replace(/\/$/, '')}/segment`,
    { ...input },
    config.modalTokenId,
    config.modalTokenSecret,
  );
  return res;
}

export async function requestEdit(input: EditJobInput & { imageUrl: string }): Promise<EditResponse> {
  if (isLocalFallback() || !config.modalFluxUrl) {
    return fallbackEdit(input);
  }
  const res = await postJson<EditResponse>(
    `${config.modalFluxUrl.replace(/\/$/, '')}/edit`,
    {
      imageUrl: input.imageUrl,
      prompt: input.prompt,
      mask: input.mask,
      strength: input.strength ?? 0.85,
      seed: input.seed,
    },
    config.modalTokenId,
    config.modalTokenSecret,
  );
  return res;
}
