import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { RUN_STATUSES, STEP_KINDS, STEP_STATUSES } from "@forge/shared";
import type { Attempts } from "../domain/next-action.js";

/** One Claude Code session running one pipeline step. */
export const steps = sqliteTable(
  "step",
  {
    id: text("id").primaryKey(),
    runId: text("run_id"),
    projectPath: text("project_path").notNull(),
    taskId: text("task_id").notNull(),
    kind: text("kind").notNull(),
    /** 1-based run number of this step kind for the task; names its output directory. */
    attempt: integer("attempt").notNull().default(1),
    agent: text("agent").notNull(),
    status: text("status", { enum: STEP_STATUSES }).notNull(),
    model: text("model"),
    tmuxSession: text("tmux_session").notNull(),
    claudeSessionId: text("claude_session_id").notNull().unique(),
    worktreePath: text("worktree_path").notNull(),
    transcriptPath: text("transcript_path"),
    inputPath: text("input_path").notNull(),
    outputPath: text("output_path").notNull(),
    timeoutMs: integer("timeout_ms").notNull(),
    deadlineAt: integer("deadline_at"),
    stopBlockCount: integer("stop_block_count").notNull().default(0),
    reportedAt: integer("reported_at"),
    summary: text("summary"),
    artifacts: text("artifacts", { mode: "json" }).$type<string[]>(),
    createdAt: integer("created_at").notNull(),
    startedAt: integer("started_at"),
    endedAt: integer("ended_at"),
    exitReason: text("exit_reason"),
  },
  (t) => [
    // A task never has two live sessions for the same step.
    uniqueIndex("step_live_unique")
      .on(t.projectPath, t.taskId, t.kind)
      .where(sql`status in ('queued', 'running', 'needs_human')`),
    index("step_status_idx").on(t.status),
  ],
);

/** One pipeline run: a task going through every step. */
export const runs = sqliteTable(
  "run",
  {
    id: text("id").primaryKey(),
    projectPath: text("project_path").notNull(),
    taskId: text("task_id").notNull(),
    worktreePath: text("worktree_path").notNull(),
    branch: text("branch").notNull(),
    /** Branch the task branch starts from and the PR targets. */
    baseBranch: text("base_branch").notNull(),
    status: text("status", { enum: RUN_STATUSES }).notNull(),
    currentStep: text("current_step", { enum: STEP_KINDS }).notNull(),
    /** Failures per step: the loop counters. */
    attempts: text("attempts", { mode: "json" }).$type<Attempts>().notNull(),
    /** Last step whose outcome was applied; makes advancing idempotent across restarts. */
    lastHandledStepId: text("last_handled_step_id"),
    prNumber: integer("pr_number"),
    prUrl: text("pr_url"),
    exitReason: text("exit_reason"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    endedAt: integer("ended_at"),
  },
  (t) => [
    // A task never has two open runs.
    uniqueIndex("run_open_unique")
      .on(t.projectPath, t.taskId)
      .where(sql`status in ('queued', 'running', 'needs_human')`),
    index("run_status_idx").on(t.status),
  ],
);

/** Append-only audit log. */
export const events = sqliteTable(
  "event",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    entity: text("entity").notNull(),
    entityId: text("entity_id").notNull(),
    type: text("type").notNull(),
    payload: text("payload", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
    ts: integer("ts").notNull(),
  },
  (t) => [index("event_entity_idx").on(t.entity, t.entityId)],
);

export type StepRow = typeof steps.$inferSelect;
export type NewStepRow = typeof steps.$inferInsert;
export type EventRow = typeof events.$inferSelect;
export type RunRow = typeof runs.$inferSelect;
export type NewRunRow = typeof runs.$inferInsert;
