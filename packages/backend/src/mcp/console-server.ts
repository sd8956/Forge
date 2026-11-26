import { relative } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { isTerminalStepStatus } from "@forge/shared";
import { z } from "zod";
import type { RunRow } from "../db/schema.js";
import type { StepStore } from "../db/step-store.js";
import type { PrThreadStore } from "../db/pr-thread-store.js";
import { planView, queueView } from "../orchestrator/views.js";
import type { OrchestratorToolDeps } from "./orchestrator-server.js";

export interface ConsoleToolDeps extends OrchestratorToolDeps {
  steps: StepStore;
  threads: PrThreadStore;
}

const text = (value: unknown, isError = false) => ({ content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }], isError });
const taskId = z.string().regex(/^TASK-\d{3,}$/);

/**
 * The `factory` MCP server as the project console sees it: everything about the project's runs and steps, and the
 * same actions the panel offers (resume, cancel, start, pause). State changes go through Forge, never around it.
 */
export function createConsoleMcpServer(projectPath: string, deps: ConsoleToolDeps): McpServer {
  const server = new McpServer({ name: "factory", version: "0.0.0" });
  const runsOf = () => deps.runs.list().filter((r) => r.projectPath === projectPath);
  const latestRun = (id: string): RunRow | undefined => runsOf().filter((r) => r.taskId === id).at(-1);

  server.registerTool("get_status", { title: "Queue and plans", description: "The queue (pause, usage window, active sessions, queued tasks with why each waits) and the latest plans.", inputSchema: {} }, () =>
    text({ queue: queueView(deps, projectPath), plans: deps.plans.plans(projectPath).slice(0, 3).map((p) => planView(deps, p)) }),
  );

  server.registerTool("list_runs", { title: "Runs", description: "Every run of this project, newest last: task, status, current step, PR and why it stopped.", inputSchema: {} }, () =>
    text(runsOf().map((r) => ({ runId: r.id, taskId: r.taskId, status: r.status, currentStep: r.currentStep, mode: r.mode, reviewRound: r.reviewRound, prUrl: r.prUrl, exitReason: r.exitReason }))),
  );

  server.registerTool(
    "get_run",
    {
      title: "One run in detail",
      description: "The latest run of a task: its steps (status, exit reason, summary, prompts, handoff files), the last 40 events and its PR threads. Read a step's output.md in the worktree for the full handoff.",
      inputSchema: { task_id: taskId },
    },
    ({ task_id }) => {
      const run = latestRun(task_id);
      if (!run) return text(`${task_id} has no run in this project.`, true);
      return text({
        runId: run.id,
        taskId: run.taskId,
        status: run.status,
        currentStep: run.currentStep,
        exitReason: run.exitReason,
        branch: run.branch,
        worktree: run.worktreePath,
        prUrl: run.prUrl,
        steps: deps.runs.steps(run.id).map((s) => ({
          kind: s.kind,
          attempt: s.attempt,
          status: s.status,
          exitReason: s.exitReason,
          summary: s.summary,
          permissionPrompts: s.permissionPrompts,
          toolDenials: s.toolDenials,
          tmuxSession: s.tmuxSession,
          output: relative(run.worktreePath, s.outputPath),
        })),
        events: deps.steps.events(run.id).slice(-40).map((e) => ({ type: e.type, payload: e.payload, at: new Date(e.ts).toISOString() })),
        threads: deps.threads.list(run.id).map((t) => ({ id: t.externalId, kind: t.kind, author: t.author, handled: t.handledByStepId !== null, body: t.body.slice(0, 500) })),
      });
    },
  );

  server.registerTool(
    "active_steps",
    { title: "Live step sessions", description: "Step sessions running right now, with their worktree. Never edit a worktree listed here.", inputSchema: {} },
    () =>
      text(
        runsOf().flatMap((r) => {
          const step = deps.runs.latestStep(r.id);
          return step && !isTerminalStepStatus(step.status) ? [{ taskId: r.taskId, step: step.kind, status: step.status, tmuxSession: step.tmuxSession, worktree: r.worktreePath }] : [];
        }),
      ),
  );

  server.registerTool(
    "resume_run",
    { title: "Resume a run", description: "Resume the latest run of a task after fixing what stopped it; merge_base merges the base branch into its branch first.", inputSchema: { task_id: taskId, merge_base: z.boolean().optional() } },
    async ({ task_id, merge_base }) => {
      const run = latestRun(task_id);
      if (!run) return text(`${task_id} has no run in this project.`, true);
      const result = await deps.runService.resume(run.id, { mergeBase: merge_base ?? false });
      return text(result.message, !result.ok);
    },
  );

  server.registerTool("cancel_run", { title: "Cancel a run", description: "Cancel the open run of a task. Only when the person asks.", inputSchema: { task_id: taskId } }, async ({ task_id }) => {
    const run = latestRun(task_id);
    if (!run) return text(`${task_id} has no run in this project.`, true);
    const result = await deps.runService.cancel(run.id);
    return text(result.message, !result.ok);
  });

  server.registerTool("start_task", { title: "Start a task", description: "Start a backlog task's pipeline now (its dependencies must be merged).", inputSchema: { task_id: taskId } }, async ({ task_id }) => {
    try {
      const run = await deps.runService.start({ projectPath, taskId: task_id });
      return text({ runId: run.id, status: run.status, currentStep: run.currentStep });
    } catch (error) {
      return text(error instanceof Error ? error.message : String(error), true);
    }
  });

  server.registerTool("pause_queue", { title: "Pause the queue", description: "Pause every pipeline (no new step starts) while something is fixed by hand.", inputSchema: { reason: z.string().trim().min(1).max(200) } }, ({ reason }) => {
    deps.scheduler.pause(reason, "manual");
    return text(`Queue paused: ${reason}`);
  });

  server.registerTool("resume_queue", { title: "Resume the queue", description: "Resume the queue after a pause.", inputSchema: {} }, () => text(deps.scheduler.resume() ? "Queue resumed." : "The queue was not paused."));

  return server;
}
