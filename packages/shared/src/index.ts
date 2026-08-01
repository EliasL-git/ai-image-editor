import type { SelectionTool } from '@aie/types';

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------
export const MAX_UPLOAD_MB = 15;
export const MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024;
export const MAX_IMAGE_DIMENSION = 4096; // longest edge, downscaled on upload

export const ALLOWED_MIME = new Set(['image/png', 'image/jpeg', 'image/webp']);

export const JOB_POLL_INTERVAL_MS = 1200;
export const JOB_MAX_POLL_MS = 5 * 60 * 1000; // give cold starts room

// ---------------------------------------------------------------------------
// Canvas
// ---------------------------------------------------------------------------
export const DEFAULT_CANVAS_WIDTH = 1024;
export const DEFAULT_CANVAS_HEIGHT = 1024;
export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 8;

export const DRAWING_COLOR = '#22d3ee'; // user strokes
export const MASK_OVERLAY_COLOR = 'rgba(34, 211, 238, 0.35)'; // SAM result
export const CHECKER_A = '#1e1e24';
export const CHECKER_B = '#26262e';

// ---------------------------------------------------------------------------
// Selection tools
// ---------------------------------------------------------------------------
export const SELECTION_TOOLS: SelectionTool[] = [
  'brush',
  'rect',
  'ellipse',
  'lasso',
  'magic',
  'pan',
];

export const TOOL_LABELS: Record<SelectionTool, string> = {
  brush: 'Brush',
  rect: 'Rectangle',
  ellipse: 'Ellipse',
  lasso: 'Lasso',
  magic: 'Magic Select',
  pan: 'Pan',
};

// ---------------------------------------------------------------------------
// Edit presets (quick prompts for the MVP feature set)
// ---------------------------------------------------------------------------
export interface EditPreset {
  id: string;
  label: string;
  prompt: string;
  hint: string;
}

export const EDIT_PRESETS: EditPreset[] = [
  {
    id: 'remove',
    label: 'Remove object',
    prompt: 'Remove the selected object completely, filling the gap naturally with the surrounding background.',
    hint: 'Select the object, then remove it',
  },
  {
    id: 'replace',
    label: 'Replace object',
    prompt: 'Replace the selected object with {subject} that matches the scene lighting, perspective and style.',
    hint: 'Select the object and describe the replacement',
  },
  {
    id: 'background',
    label: 'Replace background',
    prompt: 'Replace the background behind the selected area with {description}. Keep the foreground objects exactly the same.',
    hint: 'Select the background, then describe the new one',
  },
  {
    id: 'fill',
    label: 'AI fill',
    prompt: 'Fill the selected area seamlessly with content that matches the surrounding image.',
    hint: 'Select the area to fill',
  },
  {
    id: 'color',
    label: 'Change color',
    prompt: 'Change the color of the selected object to {color}. Keep everything else identical.',
    hint: 'Select the object and name the color',
  },
  {
    id: 'clothing',
    label: 'Change clothing',
    prompt: 'Change the clothing on the selected person to {clothing}. Keep the person, pose and lighting identical.',
    hint: 'Select the person, then describe the outfit',
  },
  {
    id: 'expand',
    label: 'Expand image',
    prompt: 'Expand the image outpainting beyond its edges in the same style, extending the scene naturally.',
    hint: 'No selection needed — describe the extension',
  },
  {
    id: 'relight',
    label: 'Relight image',
    prompt: 'Relight the selected area with {lighting}, preserving all content and detail.',
    hint: 'Select the area, then describe the lighting',
  },
];

// ---------------------------------------------------------------------------
// Misc helpers (shared, no deps)
// ---------------------------------------------------------------------------
export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

export function uid(prefix = 'id'): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/** Normalize raw pixel coords into [0..1] given a canvas size. */
export function normalizePoint(p: { x: number; y: number }, w: number, h: number) {
  return { x: w > 0 ? p.x / w : 0, y: h > 0 ? p.y / h : 0 };
}

/** Downscale dimensions so the longest edge <= maxEdge, preserving aspect. */
export function fitWithin(w: number, h: number, maxEdge = MAX_IMAGE_DIMENSION) {
  const scale = Math.min(1, maxEdge / Math.max(w, h));
  return { width: Math.round(w * scale), height: Math.round(h * scale), scale };
}
