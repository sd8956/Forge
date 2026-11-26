import type { RunStatus, StepStatus } from "@forge/shared";

/** Badge styles defined by the design tokens. */
export type Tone = "queued" | "running" | "awaiting_review" | "needs_attention" | "failed" | "done";

const RUN: Record<RunStatus, { tone: Tone; label: string }> = {
  queued: { tone: "queued", label: "Queued" },
  running: { tone: "running", label: "Running" },
  waiting_review: { tone: "awaiting_review", label: "Awaiting review" },
  needs_human: { tone: "needs_attention", label: "Needs attention" },
  done: { tone: "done", label: "Done" },
  failed: { tone: "failed", label: "Failed" },
  cancelled: { tone: "queued", label: "Cancelled" },
};

const STEP: Record<StepStatus, { tone: Tone; label: string }> = {
  queued: { tone: "queued", label: "Queued" },
  running: { tone: "running", label: "Running" },
  needs_human: { tone: "needs_attention", label: "Needs attention" },
  done: { tone: "done", label: "Done" },
  blocked: { tone: "needs_attention", label: "Blocked" },
  failed: { tone: "failed", label: "Failed" },
};

export const runStatus = (status: RunStatus) => RUN[status];
export const stepStatus = (status: StepStatus) => STEP[status];

export const STEP_LABELS: Record<string, string> = {
  plan: "Plan + test plan",
  design: "Technical design",
  development: "Development",
  security: "Security",
  e2e: "E2E tests",
  code_review: "Code review",
  pr: "Pull request",
  review_fix: "Review fix",
};

export function duration(fromMs: number | null, toMs: number | null, now = Date.now()): string {
  if (!fromMs) return "";
  const seconds = Math.max(0, Math.round(((toMs ?? now) - fromMs) / 1000));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}
