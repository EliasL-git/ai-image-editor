import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// dotenv's default cwd is the package dir (apps/api), but the canonical config
// lives at the repo root (.env.example -> .env). No-op if it doesn't exist.
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

function int(value: string | undefined, fallback: number): number {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
}

export const config = {
  port: int(process.env.PORT, 8080),
  env: process.env.NODE_ENV ?? 'development',
  isProd: (process.env.NODE_ENV ?? 'development') === 'production',

  jwtSecret: process.env.JWT_SECRET ?? 'dev-secret-change-me',
  tokenTtl: '30d',

  /** Base directory for uploads/history/projects. */
  dataDir: process.env.DATA_DIR ?? path.resolve(__dirname, '../../../data'),

  maxUploadBytes: int(process.env.MAX_UPLOAD_MB, 15) * 1024 * 1024,

  // Modal endpoints (empty => local fallback mode)
  modalSamUrl: process.env.MODAL_SAM_URL ?? '',
  modalFluxUrl: process.env.MODAL_FLUX_URL ?? '',
  // Text-to-image endpoint; derived from the flux URL when unset.
  modalGenerateUrl:
    process.env.MODAL_GENERATE_URL ??
    (process.env.MODAL_FLUX_URL ? process.env.MODAL_FLUX_URL.replace(/web-edit/, 'web-generate') : ''),
  modalTokenId: process.env.MODAL_TOKEN_ID ?? '',
  modalTokenSecret: process.env.MODAL_TOKEN_SECRET ?? '',

  corsOrigin: process.env.CORS_ORIGIN ?? '*',
  webOrigin: process.env.WEB_ORIGIN ?? '',
  apiInternalUrl: process.env.API_INTERNAL_URL ?? '',
} as const;

export function isLocalFallback(): boolean {
  return !config.modalSamUrl && !config.modalFluxUrl && !config.modalGenerateUrl;
}

/**
 * Build an absolute URL for a stored asset. When API_INTERNAL_URL is set the
 * API is proxied behind the web app, so assets must be absolute to the API
 * origin; otherwise assets are served from the same origin (relative path).
 */
export function publicUrl(relativePath: string): string {
  const base = config.apiInternalUrl;
  if (!base) return relativePath;
  return `${base.replace(/\/$/, '')}${relativePath}`;
}
