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

/** Text-to-image response shape (same as edit). */
export type GenerateResponse = EditResponse;

/** One event from the FLUX streaming endpoints (SSE `data:` frames). */
export interface FluxStreamEvent {
  type: 'progress' | 'result' | 'error';
  progress?: number;
  stage?: string;
  step?: number;
  total?: number;
  preview?: string;
  imageUrl?: string;
  width?: number;
  height?: number;
  latencyMs?: number;
  message?: string;
}

async function postJson<T>(url: string, body: unknown, tokenId?: string, tokenSecret?: string): Promise<T> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (tokenId && tokenSecret) {
    headers.authorization = `Basic ${Buffer.from(`${tokenId}:${tokenSecret}`).toString('base64')}`;
  }
  const started = Date.now();
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  const elapsed = Date.now() - started;
  if (!res.ok) {
    let message = `Modal request failed (${res.status})`;
    try {
      const parsed = (await res.json()) as { detail?: string; error?: string };
      if (parsed?.detail) message = parsed.detail;
      else if (parsed?.error) message = parsed.error;
    } catch {
      /* keep default */
    }
    console.log(`[modal] POST ${url} → ${res.status} (${elapsed}ms): ${message}`);
    throw new Error(message);
  }
  const data = (await res.json()) as T;
  console.log(`[modal] POST ${url} → ${res.status} (${elapsed}ms) OK`);
  return data;
}

/**
 * POST to a Modal streaming (SSE) endpoint and dispatch each `data:` frame to
 * `onEvent`. If the endpoint responds with plain JSON (local fallback / old
 * deploy), the whole body is dispatched as a single event. Events are awaited
 * so handlers can do async work (saving previews) without racing.
 */
async function streamSse(
  url: string,
  body: unknown,
  onEvent: (ev: FluxStreamEvent) => void | Promise<void>,
  tokenId?: string,
  tokenSecret?: string,
): Promise<void> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (tokenId && tokenSecret) {
    headers.authorization = `Basic ${Buffer.from(`${tokenId}:${tokenSecret}`).toString('base64')}`;
  }
  const started = Date.now();
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!res.ok) {
    let message = `Modal request failed (${res.status})`;
    try {
      const parsed = (await res.json()) as { detail?: string; error?: string };
      if (parsed?.detail) message = parsed.detail;
      else if (parsed?.error) message = parsed.error;
    } catch {
      /* keep default */
    }
    console.log(`[modal] POST ${url} → ${res.status} (${Date.now() - started}ms): ${message}`);
    throw new Error(message);
  }
  const contentType = res.headers.get('content-type') ?? '';
  console.log(`[modal] POST ${url} → ${res.status} stream (${contentType})`);

  if (!contentType.includes('text/event-stream')) {
    // Non-streaming response: single JSON object (fallback / legacy deploy).
    const data = (await res.json()) as FluxStreamEvent;
    await onEvent(data);
    return;
  }

  const reader = res.body?.getReader();
  if (!reader) {
    await onEvent({ type: 'error', message: 'Modal stream body unavailable' });
    return;
  }
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      const chunk = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      for (const line of chunk.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload) continue;
        try {
          await onEvent(JSON.parse(payload) as FluxStreamEvent);
        } catch {
          /* skip malformed frame */
        }
      }
    }
  }
}

/** Local fallback: build a deterministic mask image (PNG data URL) from the hint. */
async function fallbackMask(input: SegmentJobInput): Promise<{ url: string; width: number; height: number }> {
  const width = 512;
  const height = 512;
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D context unavailable');

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
    cx = ((Math.min(...xs) + Math.max(...xs)) / 2) * width;
    cy = ((Math.min(...ys) + Math.max(...ys)) / 2) * height;
    rx = Math.max(20, ((Math.max(...xs) - Math.min(...xs)) / 2 + 0.05) * width);
    ry = Math.max(20, ((Math.max(...ys) - Math.min(...ys)) / 2 + 0.05) * height);
  }
  ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
  ctx.fill();

  const blob = await canvas.convertToBlob({ type: 'image/png' });
  const buf = Buffer.from(await blob.arrayBuffer());
  const url = `data:image/png;base64,${buf.toString('base64')}`;
  return { url, width, height };
}

/** Local fallback: echo the input image back (the flow is fully testable offline). */
async function fallbackEdit(input: EditJobInput & { imageUrl: string }): Promise<EditResponse> {
  const local = readFileByUrl(input.imageUrl);
  const imageUrl = local
    ? `data:image/png;base64,${local.toString('base64')}`
    : input.imageUrl;
  return { imageUrl, width: 1024, height: 1024, latencyMs: 80 };
}

/** Local fallback: a deterministic placeholder so the flow is testable offline. */
function fallbackGenerate(prompt: string): GenerateResponse {
  // 1x1 transparent PNG (data URL) is cheap and lets the canvas load it.
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
    'base64',
  );
  return { imageUrl: `data:image/png;base64,${png.toString('base64')}`, width: 1024, height: 1024, latencyMs: 80 };
}

/** Read a stored asset as a base64 data URL so Modal can fetch it remotely. */
async function assetToDataUrl(urlOrId: string): Promise<string> {
  // Already a data URL or a fully qualified http(s) URL — pass through.
  if (urlOrId.startsWith('data:') || /^https?:\/\//.test(urlOrId)) return urlOrId;
  const local = readFileByUrl(urlOrId);
  if (local) {
    const mime = urlOrId.endsWith('.webp') ? 'image/webp' : urlOrId.endsWith('.png') ? 'image/png' : 'image/jpeg';
    return `data:${mime};base64,${local.toString('base64')}`;
  }
  return urlOrId;
}

/** Resolve an upload id (or stored-asset URL) to its data URL (Modal containers can't reach localhost). */
async function uploadIdToDataUrl(imageId: string): Promise<string> {
  if (imageId.startsWith('data:') || /^https?:\/\//.test(imageId)) return imageId;
  // Already a stored-asset URL like /uploads/<id>.png (edit flow passes sourceUrl).
  const direct = readFileByUrl(imageId);
  if (direct) {
    const mime = imageId.endsWith('.webp') ? 'image/webp' : imageId.endsWith('.png') ? 'image/png' : 'image/jpeg';
    return `data:${mime};base64,${direct.toString('base64')}`;
  }
  for (const ext of ['jpg', 'png', 'webp']) {
    const local = readFileByUrl(`/uploads/${imageId}.${ext}`);
    if (local) {
      const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
      return `data:${mime};base64,${local.toString('base64')}`;
    }
  }
  throw new Error(`Upload not found: ${imageId}`);
}

export async function requestSegment(input: SegmentJobInput): Promise<SegmentResponse> {
  if (isLocalFallback() || !config.modalSamUrl) {
    const mask = await fallbackMask(input);
    return { maskUrl: mask.url, maskWidth: mask.width, maskHeight: mask.height, latencyMs: 120 };
  }
  const image = await uploadIdToDataUrl(input.imageId);
  const res = await postJson<SegmentResponse>(
    config.modalSamUrl.replace(/\/$/, ''),
    { image, mode: input.mode, point: input.point, box: input.box, points: input.points },
    config.modalTokenId,
    config.modalTokenSecret,
  );
  return res;
}

export async function requestEditStream(
  input: EditJobInput & { imageUrl: string },
  onEvent: (ev: FluxStreamEvent) => void | Promise<void>,
): Promise<void> {
  if (isLocalFallback() || !config.modalFluxUrl) {
    const r = await fallbackEdit(input);
    await onEvent({ type: 'result', ...r });
    return;
  }
  const image = await uploadIdToDataUrl(input.imageUrl);
  const mask = await assetToDataUrl(input.mask);
  await streamSse(
    config.modalFluxUrl.replace(/\/$/, ''),
    {
      image,
      prompt: input.prompt,
      mask,
      strength: input.strength ?? 0.85,
      seed: input.seed,
    },
    onEvent,
    config.modalTokenId,
    config.modalTokenSecret,
  );
}

export async function requestGenerateStream(
  input: { prompt: string; seed?: number },
  onEvent: (ev: FluxStreamEvent) => void | Promise<void>,
): Promise<void> {
  if (isLocalFallback() || !config.modalGenerateUrl) {
    const r = fallbackGenerate(input.prompt);
    await onEvent({ type: 'result', ...r });
    return;
  }
  await streamSse(
    config.modalGenerateUrl.replace(/\/$/, ''),
    { prompt: input.prompt, seed: input.seed },
    onEvent,
    config.modalTokenId,
    config.modalTokenSecret,
  );
}
