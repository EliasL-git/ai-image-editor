import fs from 'node:fs';
import path from 'node:path';
import { nanoid } from 'nanoid';
import { config } from './config.js';
import type { Job, JobResult, Project, ProjectVersion, User } from '@aie/types';

/**
 * Minimal JSON-file persistence for Render's persistent disk.
 * Each collection is one JSON file, written atomically.
 * (Swap for Postgres when multi-instance scaling is needed.)
 */

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

class JsonCollection<T extends { id: string }> {
  private file: string;
  private cache: Map<string, T> | null = null;

  constructor(dir: string, name: string) {
    ensureDir(dir);
    this.file = path.join(dir, `${name}.json`);
  }

  private load(): Map<string, T> {
    if (this.cache) return this.cache;
    const map = new Map<string, T>();
    if (fs.existsSync(this.file)) {
      try {
        const rows = JSON.parse(fs.readFileSync(this.file, 'utf-8')) as T[];
        for (const row of rows) map.set(row.id, row);
      } catch {
        // corrupt file -> start empty (upload a fresh one)
      }
    }
    this.cache = map;
    return map;
  }

  private persist(): void {
    const rows = [...(this.cache ?? new Map()).values()];
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(rows, null, 2));
    fs.renameSync(tmp, this.file);
  }

  all(): T[] {
    return [...this.load().values()];
  }

  get(id: string): T | undefined {
    return this.load().get(id);
  }

  find(pred: (row: T) => boolean): T | undefined {
    return this.all().find(pred);
  }

  where(pred: (row: T) => boolean): T[] {
    return this.all().filter(pred);
  }

  insert(row: T): T {
    const map = this.load();
    map.set(row.id, row);
    this.persist();
    return row;
  }

  update(id: string, patch: Partial<T>): T | undefined {
    const map = this.load();
    const row = map.get(id);
    if (!row) return undefined;
    const next = { ...row, ...patch, id } as T;
    map.set(id, next);
    this.persist();
    return next;
  }

  delete(id: string): void {
    const map = this.load();
    if (map.delete(id)) this.persist();
  }
}

const dataDir = config.dataDir;
const uploadsDir = path.join(dataDir, 'uploads');
const masksDir = path.join(dataDir, 'masks');
const resultsDir = path.join(dataDir, 'results');
const exportsDir = path.join(dataDir, 'exports');
for (const dir of [uploadsDir, masksDir, resultsDir, exportsDir]) ensureDir(dir);

export const dirs = { uploadsDir, masksDir, resultsDir, exportsDir };

export const users = new JsonCollection<User>(path.join(dataDir, 'db'), 'users');
export const projects = new JsonCollection<Project>(path.join(dataDir, 'db'), 'projects');
export const versions = new JsonCollection<ProjectVersion>(path.join(dataDir, 'db'), 'versions');
export const jobs = new JsonCollection<Job>(path.join(dataDir, 'db'), 'jobs');

// ---------------------------------------------------------------------------
// Projects / versions (Git-style)
// ---------------------------------------------------------------------------
export function createProject(userId: string, name: string, coverUrl: string): Project {
  const now = new Date().toISOString();
  const project: Project = {
    id: nanoid(12),
    userId,
    name,
    coverUrl,
    createdAt: now,
    updatedAt: now,
    versionCount: 0,
  };
  projects.insert(project);
  return project;
}

export function addVersion(
  projectId: string,
  imageUrl: string,
  opts: { parentId?: string | null; prompt?: string | null; maskUrl?: string | null } = {},
): ProjectVersion {
  const version: ProjectVersion = {
    id: nanoid(12),
    projectId,
    parentId: opts.parentId ?? null,
    imageUrl,
    prompt: opts.prompt ?? null,
    maskUrl: opts.maskUrl ?? null,
    createdAt: new Date().toISOString(),
    isHead: false,
  };
  versions.insert(version);

  // Clear head flags, set new head
  for (const v of versions.where((v) => v.projectId === projectId)) {
    if (v.id !== version.id && v.isHead) versions.update(v.id, { isHead: false });
  }
  versions.update(version.id, { isHead: true });

  const project = projects.get(projectId);
  if (project) {
    projects.update(projectId, {
      versionCount: versions.where((v) => v.projectId === projectId).length,
      updatedAt: new Date().toISOString(),
      coverUrl: imageUrl,
    });
  }
  return version;
}

export function headVersion(projectId: string): ProjectVersion | undefined {
  return versions.find((v) => v.projectId === projectId && v.isHead);
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------
export function createJob(job: Omit<Job, 'id' | 'createdAt' | 'updatedAt'>): Job {
  const now = new Date().toISOString();
  const row: Job = {
    ...job,
    id: nanoid(12),
    createdAt: now,
    updatedAt: now,
  };
  jobs.insert(row);
  return row;
}

export function updateJob(id: string, patch: Partial<Job>): Job | undefined {
  return jobs.update(id, { ...patch, updatedAt: new Date().toISOString() });
}

export function completeJob(id: string, result: JobResult): Job | undefined {
  return updateJob(id, {
    status: 'succeeded',
    progress: 100,
    stage: 'done',
    outputUrl: 'outputUrl' in result ? result.imageUrl : result.maskUrl,
  });
}
