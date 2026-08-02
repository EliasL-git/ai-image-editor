/** Shared type contracts for the AI image editor. Used by apps/api, apps/web and packages/*. */

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------
export interface RegisterRequest {
  email: string;
  password: string;
  name?: string;
}

export interface LoginRequest {
  email: string;
  password: string;
}

export interface AuthResponse {
  token: string;
  user: User;
}

export interface User {
  id: string;
  email: string;
  name: string;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Uploads & images
// ---------------------------------------------------------------------------
export interface ImageAsset {
  id: string;
  url: string;
  width: number;
  height: number;
  mimeType: string;
  sizeBytes: number;
  createdAt: string;
}

export interface UploadResponse extends ImageAsset {}

// ---------------------------------------------------------------------------
// Jobs (Modal-backed, polled by the client)
// ---------------------------------------------------------------------------
export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled';

export interface Job {
  id: string;
  userId: string;
  type: 'segment' | 'edit' | 'generate';
  status: JobStatus;
  progress: number; // 0..100 heuristic
  stage?: string; // human-readable status detail, e.g. 'warming up GPU'
  input: SegmentJobInput | EditJobInput | GenerateJobInput;
  outputUrl?: string;
  /** Live preview of the image being generated/edited (streamed from Modal). */
  previewUrl?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SegmentJobInput {
  imageId: string;
  mode: 'point' | 'box' | 'brush';
  /** Normalized [x, y] in [0..1] — point mode */
  point?: { x: number; y: number };
  /** Normalized box [x0, y0, x1, y1] in [0..1] — box mode */
  box?: [number, number, number, number];
  /** Normalized brush stroke points in [0..1] — brush mode */
  points?: Array<{ x: number; y: number }>;
}

export interface EditJobInput {
  imageId: string;
  prompt: string;
  /** Data URL or URL of the mask (white = edit region) */
  mask: string;
  /** How strongly to respect the prompt (0..1) */
  strength?: number;
  seed?: number;
}

export interface GenerateJobInput {
  prompt: string;
  seed?: number;
}

export interface SegmentJobResult {
  maskUrl: string;
  maskWidth: number;
  maskHeight: number;
  latencyMs: number;
}

export interface EditJobResult {
  imageUrl: string;
  width: number;
  height: number;
  latencyMs: number;
}

export type JobResult = SegmentJobResult | EditJobResult | GenerateJobResult;

export interface GenerateJobResult {
  imageUrl: string;
  width: number;
  height: number;
  latencyMs: number;
}

export interface JobResponse {
  job: Job;
}

// ---------------------------------------------------------------------------
// Projects & versions (Git-style history)
// ---------------------------------------------------------------------------
export interface Project {
  id: string;
  userId: string;
  name: string;
  coverUrl: string;
  createdAt: string;
  updatedAt: string;
  versionCount: number;
}

export interface ProjectVersion {
  id: string;
  projectId: string;
  parentId: string | null;
  imageUrl: string;
  prompt: string | null;
  maskUrl: string | null;
  createdAt: string;
  /** true when this version is the current head */
  isHead: boolean;
}

export interface ProjectDetail extends Project {
  versions: ProjectVersion[];
  headVersionId: string | null;
}

export interface ProjectSummary {
  id: string;
  name: string;
  coverUrl: string;
  versionCount: number;
  updatedAt: string;
}

export interface ExportRequest {
  projectId: string;
  versionId?: string; // defaults to head
  format: 'png' | 'jpeg' | 'webp';
  quality?: number; // 0..1, jpeg/webp
  scale?: number; // render scale multiplier (default 1)
}

export interface ExportResponse {
  url: string;
}

// ---------------------------------------------------------------------------
// Selection tool types (frontend canvas)
// ---------------------------------------------------------------------------
export type SelectionTool = 'brush' | 'rect' | 'ellipse' | 'lasso' | 'magic' | 'pan';

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

// ---------------------------------------------------------------------------
// Shared API error shape
// ---------------------------------------------------------------------------
export interface ApiError {
  error: string;
  details?: unknown;
}
