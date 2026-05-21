/**
 * Wrapper fino do fetch. Sempre `credentials: include` pro cookie de sessão.
 * Lança erro com status pra UI tratar.
 */

export class ApiError extends Error {
  constructor(public status: number, public body: unknown) {
    super(`API ${status}`);
  }
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: 'include',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = (await res.json().catch(() => null)) as unknown;

  if (!res.ok) {
    throw new ApiError(res.status, data);
  }

  return data as T;
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
};

// — Endpoints tipados —

export interface AuthMe {
  user: { username: string };
}

export interface JobRunSummary {
  startedAt: string;
  finishedAt: string | null;
  status: 'running' | 'success' | 'failed';
  durationMs: number | null;
  errorMessage: string | null;
  triggerSource?: 'cron' | 'manual';
}

export interface JobInfo {
  name: string;
  description: string;
  schedule: string;
  timezone: string;
  lastRun: JobRunSummary | null;
}

export interface JobsList {
  jobs: JobInfo[];
}

export const authApi = {
  me: () => api.get<AuthMe>('/api/me'),
  login: (username: string, password: string) =>
    api.post<{ ok: boolean; user: { username: string } }>('/login', { username, password }),
  logout: () => api.post<{ ok: boolean }>('/logout'),
};

export const jobsApi = {
  list: () => api.get<JobsList>('/api/jobs'),
  trigger: (name: string) => api.post<{ ok: boolean }>(`/api/jobs/${name}/trigger`),
  runs: (name: string) => api.get<{ runs: JobRunSummary[] }>(`/api/jobs/${name}/runs`),
};
