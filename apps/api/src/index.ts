import express, { type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import bcrypt from 'bcryptjs';
import sharp from 'sharp';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { requireAuth, signToken, userOf } from './auth.js';
import {
  addVersion,
  completeJob,
  createJob,
  createProject,
  headVersion,
  jobs,
  projects,
  updateJob,
  users,
  versions,
  type StoredUser,
} from './store.js';
import { upload, saveUpload, saveMask, saveResult, saveExport, readFileByUrl } from './uploads.js';
import { requestSegment, requestEdit } from './modal.js';
import { isLocalFallback, publicUrl } from './config.js';
import type { User } from '@aie/types';

const app = express();
app.use(cors({ origin: config.corsOrigin === '*' ? true : config.corsOrigin }));
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true }));

// ---------------------------------------------------------------------------
// Static asset serving (uploads, masks, results, exports)
// ---------------------------------------------------------------------------
app.use('/uploads', express.static(path.join(config.dataDir, 'uploads')));
app.use('/masks', express.static(path.join(config.dataDir, 'masks')));
app.use('/results', express.static(path.join(config.dataDir, 'results')));
app.use('/exports', express.static(path.join(config.dataDir, 'exports')));

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------
app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'ai-image-editor-api', modal: isLocalFallback() ? 'local-fallback' : 'modal' });
});

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------
function publicUser(u: StoredUser): User {
  return { id: u.id, email: u.email, name: u.name, createdAt: u.createdAt };
}

app.post('/auth/register', async (req: Request, res: Response) => {
  const { email, password, name } = req.body ?? {};
  if (typeof email !== 'string' || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    res.status(400).json({ error: 'A valid email is required' });
    return;
  }
  if (typeof password !== 'string' || password.length < 8) {
    res.status(400).json({ error: 'Password must be at least 8 characters' });
    return;
  }
  const normalized = email.trim().toLowerCase();
  if (users.find((u) => u.email === normalized)) {
    res.status(409).json({ error: 'An account with this email already exists' });
    return;
  }
  const hash = await bcrypt.hash(password, 10);
  const user = users.insert({
    id: crypto.randomUUID(),
    email: normalized,
    name: typeof name === 'string' && name.trim() ? name.trim() : normalized.split('@')[0],
    createdAt: new Date().toISOString(),
    passwordHash: hash,
  });
  res.status(201).json({ token: signToken(user), user: publicUser(user) });
});

app.post('/auth/login', async (req: Request, res: Response) => {
  const { email, password } = req.body ?? {};
  if (typeof email !== 'string' || typeof password !== 'string') {
    res.status(400).json({ error: 'Email and password are required' });
    return;
  }
  const user = users.find((u) => u.email === email.trim().toLowerCase());
  if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
    res.status(401).json({ error: 'Invalid email or password' });
    return;
  }
  res.json({ token: signToken(user), user: publicUser(user) });
});

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------
app.post('/upload', requireAuth, upload.single('file'), async (req: Request, res: Response) => {
  if (!req.file) {
    res.status(400).json({ error: 'No file uploaded (field "file")' });
    return;
  }
  try {
    const asset = await saveUpload(req.file.buffer, req.file.originalname, req.file.mimetype);
    res.status(201).json(asset);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// ---------------------------------------------------------------------------
// Jobs: segment (SAM 2) and edit (FLUX Kontext)
// ---------------------------------------------------------------------------
app.post('/segment', requireAuth, async (req: Request, res: Response) => {
  const user = userOf(res);
  const { imageId, mode, point, box, points } = req.body ?? {};
  if (!imageId || !['point', 'box', 'brush'].includes(mode)) {
    res.status(400).json({ error: 'imageId and a valid mode are required' });
    return;
  }
  const job = createJob({
    userId: user.id,
    type: 'segment',
    status: 'queued',
    progress: 5,
    stage: 'queued',
    input: { imageId, mode, point, box, points },
  });

  void (async () => {
    try {
      updateJob(job.id, { status: 'running', progress: 40, stage: 'running SAM 2' });
      const result = await requestSegment({ imageId, mode, point, box, points });
      let maskUrl = result.maskUrl;
      if (maskUrl.startsWith('data:')) {
        const saved = await saveMask(maskUrl);
        maskUrl = saved.url;
      }
      updateJob(job.id, { stage: 'saving mask' });
      completeJob(job.id, {
        maskUrl,
        maskWidth: result.maskWidth,
        maskHeight: result.maskHeight,
        latencyMs: result.latencyMs,
      });
    } catch (err) {
      updateJob(job.id, { status: 'failed', stage: 'failed', error: (err as Error).message });
    }
  })();

  res.status(202).json({ job });
});

app.post('/edit', requireAuth, async (req: Request, res: Response) => {
  const user = userOf(res);
  const { imageId, prompt, mask, strength, seed } = req.body ?? {};
  if (!imageId || typeof prompt !== 'string' || !prompt.trim() || typeof mask !== 'string') {
    res.status(400).json({ error: 'imageId, prompt and mask are required' });
    return;
  }
  const job = createJob({
    userId: user.id,
    type: 'edit',
    status: 'queued',
    progress: 5,
    stage: 'queued',
    input: { imageId, prompt, mask, strength, seed },
  });

  void (async () => {
    try {
      updateJob(job.id, { status: 'running', progress: 30, stage: 'starting FLUX Kontext' });
      const sourceUrl = await resolveSourceUrl(imageId);
      updateJob(job.id, { progress: 50, stage: 'generating edit' });
      const result = await requestEdit({ imageId, prompt, mask, strength, seed, imageUrl: sourceUrl });
      let imageUrl = result.imageUrl;
      if (imageUrl.startsWith('data:')) {
        const saved = await saveResult(Buffer.from(imageUrl.split(',')[1] ?? '', 'base64'));
        imageUrl = saved.url;
      }
      updateJob(job.id, { stage: 'saving result' });
      completeJob(job.id, { imageUrl, width: result.width, height: result.height, latencyMs: result.latencyMs });
    } catch (err) {
      updateJob(job.id, { status: 'failed', stage: 'failed', error: (err as Error).message });
    }
  })();

  res.status(202).json({ job });
});

async function resolveSourceUrl(imageId: string): Promise<string> {
  // imageId is an upload id; resolve to a fetchable URL for Modal.
  const uploadsDir = path.join(config.dataDir, 'uploads');
  for (const ext of ['jpg', 'png', 'webp']) {
    const candidate = `${imageId}.${ext}`;
    if (fs.existsSync(path.join(uploadsDir, candidate))) {
      return publicUrl(`/uploads/${candidate}`);
    }
  }
  // Allow passing a direct URL as imageId.
  return imageId;
}

// ---------------------------------------------------------------------------
// Jobs polling
// ---------------------------------------------------------------------------
app.get('/jobs/:id', requireAuth, (req: Request, res: Response) => {
  const job = jobs.get(req.params.id);
  if (!job) {
    res.status(404).json({ error: 'Job not found' });
    return;
  }
  if (job.userId !== userOf(res).id) {
    res.status(403).json({ error: 'Not your job' });
    return;
  }
  res.json({ job });
});

// ---------------------------------------------------------------------------
// Projects & versions (Git-style history)
// ---------------------------------------------------------------------------
app.get('/projects', requireAuth, (req: Request, res: Response) => {
  const user = userOf(res);
  const list = projects
    .where((p) => p.userId === user.id)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .map((p) => ({
      id: p.id,
      name: p.name,
      coverUrl: p.coverUrl,
      versionCount: p.versionCount,
      updatedAt: p.updatedAt,
    }));
  res.json({ projects: list });
});

app.post('/projects', requireAuth, (req: Request, res: Response) => {
  const user = userOf(res);
  const { name, imageUrl } = req.body ?? {};
  if (typeof imageUrl !== 'string' || !imageUrl) {
    res.status(400).json({ error: 'imageUrl is required' });
    return;
  }
  const project = createProject(user.id, typeof name === 'string' && name.trim() ? name.trim() : 'Untitled project', imageUrl);
  addVersion(project.id, imageUrl, { prompt: null, maskUrl: null });
  res.status(201).json({ project });
});

app.get('/projects/:id', requireAuth, (req: Request, res: Response) => {
  const user = userOf(res);
  const project = projects.get(req.params.id);
  if (!project || project.userId !== user.id) {
    res.status(404).json({ error: 'Project not found' });
    return;
  }
  const vs = versions
    .where((v) => v.projectId === project.id)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  res.json({ project: { ...project, versions: vs, headVersionId: headVersion(project.id)?.id ?? null } });
});

app.post('/projects/:id/versions', requireAuth, (req: Request, res: Response) => {
  const user = userOf(res);
  const project = projects.get(req.params.id);
  if (!project || project.userId !== user.id) {
    res.status(404).json({ error: 'Project not found' });
    return;
  }
  const { imageUrl, prompt, maskUrl, parentId } = req.body ?? {};
  if (typeof imageUrl !== 'string' || !imageUrl) {
    res.status(400).json({ error: 'imageUrl is required' });
    return;
  }
  const parent = parentId ? versions.get(parentId) : headVersion(project.id);
  const version = addVersion(project.id, imageUrl, {
    parentId: parent?.id ?? null,
    prompt: typeof prompt === 'string' ? prompt : null,
    maskUrl: typeof maskUrl === 'string' ? maskUrl : null,
  });
  res.status(201).json({ version });
});

// Restore a previous version as the new head (Git-style reset)
app.post('/projects/:id/restore', requireAuth, (req: Request, res: Response) => {
  const user = userOf(res);
  const project = projects.get(req.params.id);
  if (!project || project.userId !== user.id) {
    res.status(404).json({ error: 'Project not found' });
    return;
  }
  const { versionId } = req.body ?? {};
  const target = versions.get(versionId);
  if (!target || target.projectId !== project.id) {
    res.status(404).json({ error: 'Version not found' });
    return;
  }
  addVersion(project.id, target.imageUrl, { parentId: target.id, prompt: target.prompt, maskUrl: target.maskUrl });
  res.json({ ok: true, headVersionId: headVersion(project.id)?.id ?? null });
});

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------
app.post('/export', requireAuth, async (req: Request, res: Response) => {
  const user = userOf(res);
  const { projectId, versionId, format, quality, scale } = req.body ?? {};
  const project = projects.get(projectId);
  if (!project || project.userId !== user.id) {
    res.status(404).json({ error: 'Project not found' });
    return;
  }
  const version = versionId ? versions.get(versionId) : headVersion(project.id);
  if (!version || version.projectId !== project.id) {
    res.status(404).json({ error: 'Version not found' });
    return;
  }
  const fmt = (['png', 'jpeg', 'webp'].includes(format) ? format : 'png') as 'png' | 'jpeg' | 'webp';
  const q = typeof quality === 'number' ? Math.min(1, Math.max(0.1, quality)) : 0.92;
  const sc = typeof scale === 'number' ? Math.min(4, Math.max(0.1, scale)) : 1;

  const buffer = readFileByUrl(version.imageUrl) ?? Buffer.from('');
  if (buffer.length === 0) {
    res.status(404).json({ error: 'Version image file not found' });
    return;
  }
  let out = sharp(buffer);
  if (sc !== 1) {
    const meta = await out.metadata();
    out = out.resize({ width: Math.round((meta.width ?? 1024) * sc) });
  }
  const outBuf = await out.toFormat(fmt, { quality: Math.round(q * 100) }).toBuffer();
  const url = await saveExport(outBuf, fmt);
  res.json({ url });
});

// ---------------------------------------------------------------------------
// Error handler + 404
// ---------------------------------------------------------------------------
app.use((_req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error(err);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
const server = app.listen(config.port, () => {
  console.log(
    `[api] listening on port ${config.port} (${config.env}) — modal: ${isLocalFallback() ? 'local fallback' : 'configured'}`,
  );
});

export { app, server };
