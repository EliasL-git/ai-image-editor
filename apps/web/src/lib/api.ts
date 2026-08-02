import type {
  AuthResponse,
  EditJobInput,
  ExportRequest,
  ExportResponse,
  ImageAsset,
  Job,
  JobResponse,
  ProjectDetail,
  ProjectSummary,
  RegisterRequest,
  SegmentJobInput,
  User,
} from '@aie/types';

/**
 * API base URL resolution:
 * - VITE_API_URL (baked at build time) wins when set (production: the API service)
 * - otherwise same-origin with an /api prefix (dev proxy or web-service proxy)
 */
const baseUrl = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, '') ?? '';
const apiUrl = (path: string) => `${baseUrl}${baseUrl ? '' : '/api'}${path}`;

const TOKEN_KEY = 'aie_token';
const USER_KEY = 'aie_user';

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setSession(auth: AuthResponse): void {
  localStorage.setItem(TOKEN_KEY, auth.token);
  localStorage.setItem(USER_KEY, JSON.stringify(auth.user));
}

export function getStoredUser(): User | null {
  const raw = localStorage.getItem(USER_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as User;
  } catch {
    return null;
  }
}

export function clearSession(): void {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
}

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = {
    ...(options.headers as Record<string, string>),
  };
  if (options.body && !(options.body instanceof FormData)) {
    headers['content-type'] = 'application/json';
  }
  if (token) headers.authorization = `Bearer ${token}`;

  const res = await fetch(apiUrl(path), { ...options, headers });
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      /* keep default */
    }
    throw new ApiError(message, res.status);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const api = {
  // auth
  register: (data: RegisterRequest) => request<AuthResponse>('/auth/register', { method: 'POST', body: JSON.stringify(data) }),
  login: (data: { email: string; password: string }) => request<AuthResponse>('/auth/login', { method: 'POST', body: JSON.stringify(data) }),

  // upload
  upload: (file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    return request<ImageAsset>('/upload', { method: 'POST', body: fd });
  },

  // jobs
  segment: (input: SegmentJobInput) => request<JobResponse>('/segment', { method: 'POST', body: JSON.stringify(input) }),
  edit: (input: EditJobInput) => request<JobResponse>('/edit', { method: 'POST', body: JSON.stringify(input) }),
  generate: (input: { prompt: string; seed?: number }) => request<JobResponse>('/generate', { method: 'POST', body: JSON.stringify(input) }),
  job: (id: string) => request<{ job: Job }>(`/jobs/${id}`),

  // projects
  listProjects: () => request<{ projects: ProjectSummary[] }>('/projects'),
  createProject: (data: { name?: string; imageUrl: string }) => request<{ project: ProjectSummary }>('/projects', { method: 'POST', body: JSON.stringify(data) }),
  getProject: (id: string) => request<{ project: ProjectDetail }>(`/projects/${id}`),
  addVersion: (id: string, data: { imageUrl: string; prompt?: string | null; maskUrl?: string | null; parentId?: string | null }) =>
    request<{ version: ProjectDetail['versions'][number] }>(`/projects/${id}/versions`, { method: 'POST', body: JSON.stringify(data) }),
  restore: (id: string, versionId: string) => request<{ ok: boolean }>(`/projects/${id}/restore`, { method: 'POST', body: JSON.stringify({ versionId }) }),

  // export
  export: (data: ExportRequest) => request<ExportResponse>('/export', { method: 'POST', body: JSON.stringify(data) }),
};

export { apiUrl };
