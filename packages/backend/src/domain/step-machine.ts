import type { ReportStatus, StepStatus } from "@forge/shared";

/**
 * Events that can move a step. They come from the runner (launch, timeout),
 * the `report_step` MCP tool (report_*), hooks (attention, session_ended)
 * and startup reconciliation (orphaned).
 */
export const STEP_EVENTS = [
  "launch",
  "launch_failed",
  "report_done",
  "report_blocked",
  "report_failed",
  "attention",
  "timeout",
  "session_ended",
  "orphaned",
] as const;
export type StepEvent = (typeof STEP_EVENTS)[number];

interface Transition {
  readonly from: readonly StepStatus[];
  readonly event: StepEvent;
  readonly to: StepStatus;
}

const ACTIVE: readonly StepStatus[] = ["running", "needs_human"];

/** The only valid transitions. Anything not listed here is rejected. */
export const STEP_TRANSITIONS: readonly Transition[] = [
  { from: ["queued"], event: "launch", to: "running" },
  { from: ["queued"], event: "launch_failed", to: "failed" },
  { from: ACTIVE, event: "report_done", to: "done" },
  { from: ACTIVE, event: "report_blocked", to: "blocked" },
  { from: ACTIVE, event: "report_failed", to: "failed" },
  { from: ["running"], event: "attention", to: "needs_human" },
  { from: ACTIVE, event: "timeout", to: "failed" },
  // The Claude session ended before the agent called report_step.
  { from: ACTIVE, event: "session_ended", to: "failed" },
  // Found during startup reconciliation without a live tmux session.
  { from: ["queued", ...ACTIVE], event: "orphaned", to: "failed" },
];

export type TransitionResult =
  | { ok: true; from: StepStatus; to: StepStatus }
  | { ok: false; from: StepStatus; event: StepEvent };

export function nextStatus(from: StepStatus, event: StepEvent): TransitionResult {
  const transition = STEP_TRANSITIONS.find((t) => t.event === event && t.from.includes(from));
  return transition ? { ok: true, from, to: transition.to } : { ok: false, from, event };
}

export function reportEvent(status: ReportStatus): StepEvent {
  return `report_${status}`;
}
