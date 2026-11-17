import type { RunStatus } from "@forge/shared";

/**
 * Events that move a run. The run service raises them from step outcomes
 * (complete, attention, fail), the CLI (resume, cancel) and the first launch (start).
 */
export const RUN_EVENTS = ["start", "complete", "attention", "resume", "fail", "cancel", "review_requested", "merged", "pr_closed"] as const;
export type RunEvent = (typeof RUN_EVENTS)[number];

interface Transition {
  readonly from: readonly RunStatus[];
  readonly event: RunEvent;
  readonly to: RunStatus;
}

const OPEN: readonly RunStatus[] = ["queued", "running", "needs_human"];

/** The only valid run transitions. */
export const RUN_TRANSITIONS: readonly Transition[] = [
  { from: ["queued"], event: "start", to: "running" },
  { from: ["running"], event: "complete", to: "waiting_review" },
  { from: ["running"], event: "attention", to: "needs_human" },
  { from: ["needs_human"], event: "resume", to: "running" },
  { from: OPEN, event: "fail", to: "failed" },
  { from: [...OPEN, "waiting_review"], event: "cancel", to: "cancelled" },
  // The PR watcher: a new comment or a red check reopens the run; merge or close ends it.
  { from: ["waiting_review"], event: "review_requested", to: "running" },
  { from: ["waiting_review"], event: "merged", to: "done" },
  { from: ["waiting_review"], event: "pr_closed", to: "cancelled" },
];

export type RunTransitionResult =
  | { ok: true; from: RunStatus; to: RunStatus }
  | { ok: false; from: RunStatus; event: RunEvent };

export function nextRunStatus(from: RunStatus, event: RunEvent): RunTransitionResult {
  const transition = RUN_TRANSITIONS.find((t) => t.event === event && t.from.includes(from));
  return transition ? { ok: true, from, to: transition.to } : { ok: false, from, event };
}

export function isOpenRunStatus(status: RunStatus): boolean {
  return OPEN.includes(status);
}
