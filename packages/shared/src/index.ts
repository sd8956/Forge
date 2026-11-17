import { z } from "zod";

/** Lifecycle of one pipeline step (one Claude Code session). */
export const STEP_STATUSES = ["queued", "running", "needs_human", "done", "blocked", "failed"] as const;
export type StepStatus = (typeof STEP_STATUSES)[number];

export const TERMINAL_STEP_STATUSES: readonly StepStatus[] = ["done", "blocked", "failed"];

export function isTerminalStepStatus(status: StepStatus): boolean {
  return TERMINAL_STEP_STATUSES.includes(status);
}

/** Lifecycle of one pipeline run (one task through every step). */
export const RUN_STATUSES = ["queued", "running", "waiting_review", "needs_human", "done", "failed", "cancelled"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

/** Pipeline step kinds the backend knows how to hand off and validate, in pipeline order. */
export const STEP_KINDS = ["plan", "design", "development", "security", "e2e", "pr"] as const;
export type StepKind = (typeof STEP_KINDS)[number];

/** Statuses an agent may report through the `report_step` MCP tool. */
export const REPORT_STATUSES = ["done", "blocked", "failed"] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];

export const reportStepInputShape = {
  status: z.enum(REPORT_STATUSES).describe("done: the step's exit criteria are met; blocked: cannot continue without outside input; failed: the step could not be completed"),
  summary: z.string().trim().min(1).max(4000).describe("Short summary of what the step produced or why it stopped"),
  artifacts: z
    .array(z.string().trim().min(1).max(500))
    .max(100)
    .describe("Paths of the files this step produced, relative to the worktree root"),
};
export const reportStepInput = z.object(reportStepInputShape);
export type ReportStepInput = z.infer<typeof reportStepInput>;

/** Common fields Claude Code sends to every hook. Unknown fields are kept. */
const hookBase = z.looseObject({
  session_id: z.string().min(1),
  transcript_path: z.string().optional(),
  cwd: z.string().optional(),
  permission_mode: z.string().optional(),
  hook_event_name: z.string(),
});

export const stopHookInput = hookBase.extend({
  hook_event_name: z.literal("Stop"),
  stop_hook_active: z.boolean().default(false),
  background_tasks: z.array(z.unknown()).optional(),
  last_assistant_message: z.string().optional(),
});
export type StopHookInput = z.infer<typeof stopHookInput>;

export const notificationHookInput = hookBase.extend({
  hook_event_name: z.literal("Notification"),
  notification_type: z.string().optional(),
  message: z.string().optional(),
  title: z.string().optional(),
});
export type NotificationHookInput = z.infer<typeof notificationHookInput>;

export const sessionEndHookInput = hookBase.extend({
  hook_event_name: z.literal("SessionEnd"),
  reason: z.string().optional(),
});
export type SessionEndHookInput = z.infer<typeof sessionEndHookInput>;

/** Notification types that mean a person must look at the session. */
export const ATTENTION_NOTIFICATION_TYPES = ["permission_prompt", "idle_prompt"] as const;

/** Body of `POST /runs`. */
export const startRunRequest = z.object({
  projectPath: z.string().min(1),
  taskId: z.string().regex(/^TASK-\d{3,}$/, "taskId must look like TASK-001"),
});
export type StartRunRequest = z.infer<typeof startRunRequest>;

/** Public view of a run returned by the HTTP API. */
export interface RunView {
  id: string;
  taskId: string;
  projectPath: string;
  branch: string;
  baseBranch: string;
  status: RunStatus;
  currentStep: StepKind;
  attempts: Partial<Record<StepKind, number>>;
  prUrl: string | null;
  prNumber: number | null;
  exitReason: string | null;
  createdAt: number;
  endedAt: number | null;
}

/** Public view of a step returned by the HTTP API. */
export interface StepView {
  id: string;
  runId: string | null;
  taskId: string;
  kind: string;
  attempt: number;
  model: string | null;
  agent: string;
  status: StepStatus;
  tmuxSession: string;
  claudeSessionId: string;
  worktreePath: string;
  inputPath: string;
  outputPath: string;
  transcriptPath: string | null;
  exitReason: string | null;
  summary: string | null;
  artifacts: string[];
  startedAt: number | null;
  endedAt: number | null;
  deadlineAt: number | null;
}
