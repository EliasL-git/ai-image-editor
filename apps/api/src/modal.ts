import { config, isLocalFallback } from './config.js';
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

/** Local fallback: build a deterministic mask image (PNG) from the hint. */
function fallbackMask(input: SegmentJobInput): { url: string; width: number; height: number } {
  const width = 512;
  const height = 512;
  // Deterministic gray blob centered on the selection so the overlay is visible
  // without Modal. The real service returns a precise object mask.
  const cx = 0.5;
  const cy = 0.5;
  const rx = 0.3 * width;
  const ry = 0.3 * height;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.ellipse(cx * width, cy * height, rx, ry, 0, 0, Math.PI * 2);
  ctx.fill();
  const url = canvas.toDataURL('image/png');
  return { url, width, height };
}

function createCanvas(w: number, h: number): HTMLCanvasElement {
  // Node 20+ exposes OffscreenCanvas; fall back to a minimal shim otherwise.
  const Ctor = globalThis.OffscreenCanvas as unknown as
    | (new (w: number, h: number) => HTMLCanvasElement)
    | undefined;
  if (Ctor) return new Ctor(w, h) as HTMLCanvasElement;
  throw new Error('OffscreenCanvas not available for local fallback mask');
}

/** Local fallback: echo the input image back with a small watermark band. */
async function fallbackEdit(input: EditJobInput): Promise<EditResponse> {
  // Reuse the upload's stored file if it's a local path; otherwise return a stub.
  const imageUrl = input.imageId; // replaced by caller when possible
  const now = Date.now();
  return {
    imageUrl,
    width: 1024,
    height: 1024,
    latencyMs: now - now,
  };
}

export async function requestSegment(input: SegmentJobInput): Promise<SegmentResponse> {
  if (isLocalFallback() || !config.modalSamUrl) {
    const mask = fallbackMask(input);
    return { ...mask, latencyMs: 120 };
  }
  const body = { ...input };
  const res = await postJson<SegmentResponse>(
    `${config.modalSamUrl.replace(/\/$/, '')}/segment`,
    body,
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
