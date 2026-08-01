import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { nanoid } from 'nanoid';
import { dirs } from './store.js';
import { config, publicUrl } from './config.js';
import { fitWithin } from '@aie/shared';
import type { ImageAsset } from '@aie/types';

/**
 * Accept an uploaded buffer, normalize metadata, downscale if needed, and
 * persist to the uploads dir. Returns the public asset descriptor.
 */
export async function saveUpload(buffer: Buffer, originalName: string, mimeType: string): Promise<ImageAsset> {
  const id = nanoid(12);
  const ext = mimeToExt(mimeType);
  const filename = `${id}.${ext}`;
  const absPath = path.join(dirs.uploadsDir, filename);

  const image = sharp(buffer, { limitInputPixels: 60_000_000 });
  const meta = await image.metadata();
  const srcW = meta.width ?? 0;
  const srcH = meta.height ?? 0;

  // Downscale huge images to keep canvas + SAM/FLUX happy
  const { width, height, scale } = fitWithin(srcW, srcH);
  let pipeline = image.rotate().removeAlpha().flatten({ background: '#ffffff' });
  if (scale < 1) pipeline = pipeline.resize({ width, height, fit: 'inside', withoutEnlargement: true });
  await pipeline.toFormat('jpeg', { quality: 90 }).toFile(absPath);

  const sizeBytes = fs.statSync(absPath).size;
  return {
    id,
    url: publicUrl(`/uploads/${filename}`),
    width: Math.round(srcW * scale),
    height: Math.round(srcH * scale),
    mimeType: 'image/jpeg',
    sizeBytes,
    createdAt: new Date().toISOString(),
  };
}

/** Persist a data-URL mask to the masks dir. */
export async function saveMask(maskDataUrl: string): Promise<{ url: string; width: number; height: number }> {
  const id = nanoid(12);
  const filename = `${id}.png`;
  const absPath = path.join(dirs.masksDir, filename);
  const base64 = maskDataUrl.replace(/^data:image\/\w+;base64,/, '');
  const buffer = Buffer.from(base64, 'base64');
  const meta = await sharp(buffer).metadata();
  fs.writeFileSync(absPath, buffer);
  return {
    url: publicUrl(`/masks/${filename}`),
    width: meta.width ?? 0,
    height: meta.height ?? 0,
  };
}

/** Save a generated result image buffer (from Modal or local). */
export async function saveResult(buffer: Buffer, ext = 'png'): Promise<{ url: string; width: number; height: number }> {
  const id = nanoid(12);
  const filename = `${id}.${ext}`;
  const absPath = path.join(dirs.resultsDir, filename);
  fs.writeFileSync(absPath, buffer);
  const meta = await sharp(absPath).metadata();
  return {
    url: publicUrl(`/results/${filename}`),
    width: meta.width ?? 0,
    height: meta.height ?? 0,
  };
}

/** Save an exported render. */
export async function saveExport(buffer: Buffer, ext: string): Promise<string> {
  const id = nanoid(12);
  const filename = `${id}.${ext}`;
  fs.writeFileSync(path.join(dirs.exportsDir, filename), buffer);
  return publicUrl(`/exports/${filename}`);
}

export function mimeToExt(mime: string): string {
  switch (mime) {
    case 'image/png':
      return 'png';
    case 'image/webp':
      return 'webp';
    default:
      return 'jpg';
  }
}

export function fileExists(relativeUrl: string): boolean {
  const clean = relativeUrl.replace(/^\//, '');
  const parts = clean.split('/');
  if (parts.length !== 2) return false;
  const [kind, name] = parts;
  const dir = (dirs as Record<string, string>)[`${kind}Dir`];
  if (!dir) return false;
  return fs.existsSync(path.join(dir, path.basename(name)));
}

export function readFileByUrl(relativeUrl: string): Buffer | null {
  const clean = relativeUrl.replace(/^\//, '');
  const parts = clean.split('/');
  if (parts.length !== 2) return null;
  const [kind, name] = parts;
  const dir = (dirs as Record<string, string>)[`${kind}Dir`];
  if (!dir) return null;
  const abs = path.join(dir, path.basename(name));
  return fs.existsSync(abs) ? fs.readFileSync(abs) : null;
}

// Multer memory storage with a size guard
import multer from 'multer';

export const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.maxUploadBytes, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (['image/png', 'image/jpeg', 'image/webp'].includes(file.mimetype)) cb(null, true);
    else cb(new Error('Only PNG, JPEG and WebP images are supported'));
  },
});
