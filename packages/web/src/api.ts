import type { DefinitionStage, DefinitionView, PlanView, QueueView, RunView, StepView } from "@forge/shared";

export type { DefinitionStage, DefinitionView, PlanView, QueueView };

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
  queue: () => request<QueueView>("/queue"),
  pauseQueue: (reason = "Paused by a person") => request<QueueView>("/queue/pause", { method: "POST", body: JSON.stringify({ reason }) }),
  resumeQueue: () => request<QueueView>("/queue/resume", { method: "POST", body: "{}" }),
  plans: (projectId: string) => request<PlanView[]>(`/projects/${projectId}/plans`),
  approvePlan: (planId: string) => request<PlanView>(`/plans/${planId}/approve`, { method: "POST", body: "{}" }),
  rejectPlan: (planId: string) => request<PlanView>(`/plans/${planId}/reject`, { method: "POST", body: "{}" }),
  orchestrator: (projectId: string) => request<{ session: OrchestratorSession | null }>(`/projects/${projectId}/orchestrator`),
  startOrchestrator: (projectId: string, prompt?: string) =>
    request<{ session: OrchestratorSession }>(`/projects/${projectId}/orchestrator`, { method: "POST", body: JSON.stringify(prompt ? { prompt } : {}) }),
  stopOrchestrator: (projectId: string) => request<{ stopped: boolean }>(`/projects/${projectId}/orchestrator`, { method: "DELETE" }),
  memories: (projectId: string, filter: { q?: string; ref?: string } = {}) => {
    const params = new URLSearchParams();
    if (filter.q) params.set("q", filter.q);
    if (filter.ref) params.set("ref", filter.ref);
    return request<MemoryList>(`/projects/${projectId}/memories${params.size ? `?${params.toString()}` : ""}`);
  },
  settings: () => request<ForgeSettings>("/settings"),
  openProject: (projectId: string, target: "editor" | "files") =>
    request<{ opened: string }>(`/projects/${projectId}/open`, { method: "POST", body: JSON.stringify({ target }) }),
  updateSettings: (patch: Partial<Pick<ForgeSettings, "maxConcurrency" | "usagePausePercent" | "auth" | "editorCommand" | "fileManagerCommand">>) =>
    request<ForgeSettings>("/settings", { method: "PATCH", body: JSON.stringify(patch) }),
  saveApiKey: (key: string) => request<ForgeSettings>("/settings/api-key", { method: "PUT", body: JSON.stringify({ key }) }),
  removeApiKey: () => request<ForgeSettings>("/settings/api-key", { method: "DELETE" }),
  templateStatus: (projectId: string) => request<TemplateSync>(`/projects/${projectId}/template`),
  syncTemplate: (projectId: string) => request<TemplateSync>(`/projects/${projectId}/template/sync`, { method: "POST", body: "{}" }),
  projectSettings: (projectId: string) => request<ProjectSettings>(`/projects/${projectId}/settings`),
  definitions: () => request<{ projectId: string; repoPath: string; prUrl: string | null }[]>("/definitions"),
  definition: (projectId: string) => request<DefinitionView>(`/projects/${projectId}/definition`),
  beginDefinition: (path: string, idea: string) => request<DefinitionView>("/definitions", { method: "POST", body: JSON.stringify({ path, idea }) }),
  approveStage: (projectId: string, stage: DefinitionStage) => request<DefinitionView>(`/projects/${projectId}/definition/${stage}/approve`, { method: "POST", body: "{}" }),
  requestChanges: (projectId: string, stage: DefinitionStage, feedback: string) =>
    request<DefinitionView>(`/projects/${projectId}/definition/${stage}/changes`, { method: "POST", body: JSON.stringify({ feedback }) }),
  retryStage: (projectId: string, stage: DefinitionStage) => request<DefinitionView>(`/projects/${projectId}/definition/${stage}/retry`, { method: "POST", body: "{}" }),
  approveScreen: (projectId: string, screen: string) => request<DefinitionView>(`/projects/${projectId}/definition/screens/approve`, { method: "POST", body: JSON.stringify({ screen }) }),
};

/** URL of a file under the definition worktree's .factory/ (path relative to .factory/). */
export function definitionFileUrl(projectId: string, path: string): string {
  return `/projects/${projectId}/definition/files/${path.split("/").map(encodeURIComponent).join("/")}`;
}

export interface OrchestratorSession {
  projectId: string;
  tmuxSession: string;
  startedAt: number;
}

/** URL of a file in a run's handoff folder (screenshots, reports, output.md). */
export function runFileUrl(runId: string, path: string): string {
  return `/runs/${runId}/files?path=${encodeURIComponent(path)}`;
}

export interface MemoryItem {
  id: number;
  title: string;
  type: string;
  content: string;
  createdAt: string;
  ref: string | null;
  runId: string | null;
}

export interface MemoryList {
  available: boolean;
  error?: string;
  items: MemoryItem[];
}

export interface ForgeSettings {
  maxConcurrency: number;
  usagePausePercent: number;
  auth: "subscription" | "api_key";
  apiKey: { configured: boolean; last4: string | null };
  editorCommand: string;
  fileManagerCommand: string;
}

export interface ProjectSettings {
  file: string;
  permissionMode: "auto" | "agent";
  maxConcurrency: number | null;
  allowedAuthors: string[];
  pollIntervalSeconds: number | null;
  commands: Record<string, string>;
}

export interface TemplateSync {
  status: "never_checked" | "up_to_date" | "pr_opened" | "pr_updated" | "pr_open" | "skipped" | "failed";
  reason?: string;
  prUrl?: string | null;
  updated?: string[];
  added?: string[];
  customized?: string[];
  checkedAt?: number;
}
