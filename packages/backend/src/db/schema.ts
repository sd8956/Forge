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
    /** Permission prompts the session showed (Notification permission_prompt). */
    permissionPrompts: integer("permission_prompts").notNull().default(0),
    /** Tool calls the PreToolUse guard denied with a corrective reason. */
    toolDenials: integer("tool_denials").notNull().default(0),
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

/** A target repository registered in Forge (one per repo). */
export const projects = sqliteTable("project", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  repoPath: text("repo_path").notNull().unique(),
  remote: text("remote"),
  defaultBranch: text("default_branch").notNull(),
  /** Parsed `.factory/project.yaml`, refreshed on every registration. */
  config: text("config", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

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
    /** build: first pass; review: a round started by the PR watcher. */
    mode: text("mode", { enum: ["build", "review"] }).notNull().default("build"),
    reviewRound: integer("review_round").notNull().default(0),
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

/**
 * A PR comment, review or failed check the watcher picked up. The unique
 * (run, external id) pair is what keeps a thread from being handled twice,
 * across restarts too.
 */
export const prThreads = sqliteTable(
  "pr_thread",
  {
    id: text("id").primaryKey(),
    runId: text("run_id").notNull(),
    /** `review_comment:<id>`, `issue_comment:<id>`, `review:<id>` or `check:<name>@<sha>`. */
    externalId: text("external_id").notNull(),
    kind: text("kind", { enum: ["review_comment", "issue_comment", "review", "check", "conflict"] }).notNull(),
    author: text("author"),
    path: text("path"),
    line: integer("line"),
    body: text("body").notNull(),
    url: text("url"),
    handledByStepId: text("handled_by_step_id"),
    handledAt: integer("handled_at"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [uniqueIndex("pr_thread_unique").on(t.runId, t.externalId), index("pr_thread_run_idx").on(t.runId)],
);

/** A plan the orchestrator proposed for a project; nothing runs until a person approves it. */
export const executionPlans = sqliteTable(
  "execution_plan",
  {
    id: text("id").primaryKey(),
    projectPath: text("project_path").notNull(),
    status: text("status", { enum: ["proposed", "approved", "rejected", "done", "cancelled"] }).notNull(),
    rationale: text("rationale").notNull(),
    proposedBy: text("proposed_by").notNull(),
    createdAt: integer("created_at").notNull(),
    decidedAt: integer("decided_at"),
  },
  (t) => [index("execution_plan_project_idx").on(t.projectPath, t.status)],
);

/** One task of a plan and its place in the queue. */
export const planTasks = sqliteTable(
  "plan_task",
  {
    id: text("id").primaryKey(),
    planId: text("plan_id").notNull(),
    projectPath: text("project_path").notNull(),
    taskId: text("task_id").notNull(),
    wave: integer("wave").notNull(),
    modules: text("modules", { mode: "json" }).$type<string[]>().notNull(),
    priority: integer("priority").notNull().default(0),
    dependsOn: text("depends_on", { mode: "json" }).$type<string[]>().notNull(),
    /** planned: plan not approved yet; queued: waiting for the scheduler; launched: has a run. */
    state: text("state", { enum: ["planned", "queued", "launched", "cancelled"] }).notNull(),
    /** Why the scheduler has not launched it yet, refreshed on every pass. */
    waitReason: text("wait_reason"),
    runId: text("run_id"),
    queuedAt: integer("queued_at"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [uniqueIndex("plan_task_unique").on(t.planId, t.taskId), index("plan_task_state_idx").on(t.state)],
);

/** A project's definition in progress: its worktree and the person's idea. */
export const definitions = sqliteTable("definition", {
  projectId: text("project_id").primaryKey(),
  repoPath: text("repo_path").notNull(),
  worktreePath: text("worktree_path").notNull(),
  branch: text("branch").notNull(),
  idea: text("idea").notNull(),
  prUrl: text("pr_url"),
  /** When the definition PR merged and the base branch was pulled. */
  mergedAt: integer("merged_at"),
  createdAt: integer("created_at").notNull(),
});

/** One of the six stages of a project definition (the definition's data model). */
export const definitionStages = sqliteTable(
  "definition_stage",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull(),
    stage: text("stage", { enum: ["intake", "requirements", "architecture", "test_strategy", "design", "backlog"] }).notNull(),
    status: text("status", { enum: ["pending", "running", "in_review", "changes_requested", "approved"] }).notNull(),
    summary: text("summary"),
    stepId: text("step_id"),
    /** The person's latest "Request changes" text, passed to the next session. */
    feedback: text("feedback"),
    lastError: text("last_error"),
    approvedScreens: text("approved_screens", { mode: "json" }).$type<string[]>().notNull(),
    approvedAt: integer("approved_at"),
    commit: text("commit"),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [uniqueIndex("definition_stage_unique").on(t.projectId, t.stage)],
);

/** Small persistent key-value state: queue pause and the latest usage window. */
export const settings = sqliteTable("setting", {
  key: text("key").primaryKey(),
  value: text("value", { mode: "json" }).$type<unknown>().notNull(),
  updatedAt: integer("updated_at").notNull(),
});

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
export type ProjectRow = typeof projects.$inferSelect;
export type PrThreadRow = typeof prThreads.$inferSelect;
export type ExecutionPlanRow = typeof executionPlans.$inferSelect;
export type PlanTaskRow = typeof planTasks.$inferSelect;
export type DefinitionRow = typeof definitions.$inferSelect;
export type DefinitionStageRow = typeof definitionStages.$inferSelect;
export type NewRunRow = typeof runs.$inferInsert;
