import type { RunView, StepView } from "@forge/shared";

export class UnauthorizedError extends Error {}

export interface RunSummary extends RunView {
  latestStep: StepView | null;
}

export interface RunDetail extends RunView {
  task: { id: string; title: string; size: string | null; covers: string[]; dependsOn: string[] } | null;
  steps: StepView[];
  memories: { available: boolean; error?: string; items: { id: number; title: string; ref: string | null }[] };
  prThreads: { id: string; kind: string; author: string | null; path: string | null; line: number | null; url: string | null; handled: boolean; body: string }[];
  events: { id: number; entity: string; entityId: string; type: string; payload: Record<string, unknown>; ts: number }[];
}

export interface Evidence {
  testPlan: { id: string; title: string; covers: string[] }[];
  evidenceDir: string | null;
  cases: { id: string; frs: string[]; result: string; files: string[] }[];
  tests: { total: number; passed: number; failed: number } | null;
  security: { findings: Record<string, number>; status: string; report: string | null } | null;
}

export interface Project {
  id: string;
  name: string;
  repoPath: string;
  remote: string | null;
  defaultBranch: string;
}

export interface BacklogTask {
  id: string;
  title: string;
  size: string | null;
  covers: string[];
  dependsOn: string[];
  latestRun: { id: string; status: RunView["status"] } | null;
}

/** Same-origin requests; the session cookie authenticates them. */
async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, { ...init, headers: { ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers } });
  if (response.status === 401) throw new UnauthorizedError("Not logged in");
  const body = (await response.json().catch(() => ({}))) as T & { message?: string; error?: string };
  if (!response.ok) throw new Error(body.message ?? body.error ?? `HTTP ${response.status}`);
  return body;
}

export const api = {
  projects: () => request<Project[]>("/projects"),
  addProject: (path: string) => request<Project>("/projects", { method: "POST", body: JSON.stringify({ path }) }),
  backlog: (projectId: string) => request<BacklogTask[]>(`/projects/${projectId}/backlog`),
  runs: () => request<RunSummary[]>("/runs"),
  run: (id: string) => request<RunDetail>(`/runs/${id}`),
  evidence: (id: string) => request<Evidence>(`/runs/${id}/evidence`),
  startRun: (projectPath: string, taskId: string) => request<RunView>("/runs", { method: "POST", body: JSON.stringify({ projectPath, taskId }) }),
  resume: (id: string, opts: { mergeBase?: boolean } = {}) =>
    request<{ message: string }>(`/runs/${id}/resume`, { method: "POST", body: JSON.stringify({ mergeBase: opts.mergeBase ?? false }) }),
  cancel: (id: string) => request<{ message: string }>(`/runs/${id}/cancel`, { method: "POST", body: "{}" }),
};

/** URL of a file in a run's handoff folder (screenshots, reports, output.md). */
export function runFileUrl(runId: string, path: string): string {
  return `/runs/${runId}/files?path=${encodeURIComponent(path)}`;
}
