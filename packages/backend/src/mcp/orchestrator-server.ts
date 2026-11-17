import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { proposePlanShape } from "@forge/shared";
import { z } from "zod";
import type { ForgeConfig } from "../config.js";
import type { PlanStore } from "../db/plan-store.js";
import type { RunStore } from "../db/run-store.js";
import { validatePlan } from "../domain/plan.js";
import { planView, queueView } from "../orchestrator/views.js";
import { listBacklog } from "../projects/project-config.js";
import { unmergedDependencies } from "../runs/dependencies.js";
import type { RunService } from "../runs/run-service.js";
import type { SchedulerService } from "../runs/scheduler-service.js";

export interface OrchestratorToolDeps {
  config: ForgeConfig;
  plans: PlanStore;
  runs: RunStore;
  runService: RunService;
  scheduler: SchedulerService;
  /** Current branch of the project checkout. */
  baseBranch: (projectPath: string) => Promise<string>;
}

const text = (value: unknown, isError = false) => ({ content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }], isError });
const OPEN = new Set(["queued", "running", "needs_human", "waiting_review"]);

/** Backlog tasks with where each one stands in Forge. */
async function backlogStatus(deps: OrchestratorToolDeps, projectPath: string) {
  const tasks = listBacklog(projectPath);
  const runs = deps.runs.list().filter((r) => r.projectPath === projectPath);
  const queued = new Set(deps.plans.queued().filter((t) => t.projectPath === projectPath).map((t) => t.taskId));
  const base = await deps.baseBranch(projectPath);
  const unmerged = new Set(await unmergedDependencies(projectPath, base, tasks.map((t) => t.id)));
  return tasks.map((t) => {
    const latest = runs.filter((r) => r.taskId === t.id).at(-1);
    // A failed or cancelled run leaves a branch git may call merged; only a done run (or no run and git) counts.
    const merged = latest ? latest.status === "done" : !unmerged.has(t.id);
    const status = latest && OPEN.has(latest.status) ? `run_${latest.status}` : queued.has(t.id) ? "queued" : merged ? "merged" : "not_started";
    return { ...t, status };
  });
}

/**
 * The `factory` MCP server as the orchestrator session sees it. The project
 * comes from the URL, so the orchestrator can only plan for its own project.
 * It proposes; only a person approves, and the scheduler launches.
 */
export function createOrchestratorMcpServer(projectPath: string, deps: OrchestratorToolDeps): McpServer {
  const server = new McpServer({ name: "factory", version: "0.0.0" });

  server.registerTool(
    "list_backlog",
    {
      title: "List the backlog",
      description:
        "Backlog tasks of this project with id, title, size, covered requirements, dependencies and status " +
        "(not_started, queued, run_<status> or merged). Read a task's spec in .factory/backlog/<id>.md for its scope.",
      inputSchema: {},
    },
    async () => text(await backlogStatus(deps, projectPath)),
  );

  server.registerTool(
    "propose_plan",
    {
      title: "Propose an execution plan",
      description:
        "Propose which tasks to run, in waves, with the folders or files each task changes. Forge checks the plan " +
        "(dependencies must be merged or in an earlier wave) and shows it to the person in the panel. Nothing runs " +
        "until they approve it there. A new proposal replaces the previous one that was not decided yet.",
      inputSchema: proposePlanShape,
    },
    async (input) => {
      const backlog = await backlogStatus(deps, projectPath);
      const merged = new Set(backlog.filter((t) => t.status === "merged").map((t) => t.id));
      const validation = validatePlan(input, backlog, merged);
      const issues = validation.ok ? [] : [...validation.issues];
      for (const wave of input.waves) {
        for (const t of wave.tasks) {
          const status = backlog.find((b) => b.id === t.id)?.status;
          if (status === "merged") issues.push(`${t.id} is already merged`);
          else if (status && status !== "not_started") issues.push(`${t.id} is already ${status.replace(/^run_/, "running as ")}`);
        }
      }
      if (!validation.ok || issues.length) return text({ accepted: false, issues: [...new Set(issues)] }, true);
      const plan = deps.plans.propose(projectPath, input.rationale, validation.tasks, "orchestrator");
      return text({
        accepted: true,
        planId: plan.id,
        next: "The person reviews this plan in the panel and approves or rejects it. Tell them it is ready, then wait; do not call launch_pipeline before they approve.",
      });
    },
  );

  server.registerTool(
    "launch_pipeline",
    {
      title: "Launch an approved plan",
      description:
        "Ask the scheduler to start the tasks of a plan the person approved in the panel. It refuses a plan that is " +
        "not approved. The scheduler decides when each task starts (session cap, merged dependencies, modules, pause).",
      inputSchema: { plan_id: z.uuid() },
    },
    async ({ plan_id }) => {
      const plan = deps.plans.get(plan_id);
      if (!plan || plan.projectPath !== projectPath) return text(`Unknown plan ${plan_id} for this project.`, true);
      if (plan.status === "proposed") return text(`Plan ${plan_id} is waiting for the person to approve it in the panel. Nothing was launched.`, true);
      if (plan.status !== "approved") return text(`Plan ${plan_id} is ${plan.status}; it cannot be launched.`, true);
      await deps.scheduler.tick();
      return text(planView(deps, deps.plans.get(plan_id) ?? plan));
    },
  );

  server.registerTool(
    "get_status",
    {
      title: "Queue and plan status",
      description: "Open runs, queued tasks with why each one waits, the queue pause, the usage window and the latest plans of this project.",
      inputSchema: {},
    },
    () => text({ queue: queueView(deps, projectPath), plans: deps.plans.plans(projectPath).slice(0, 3).map((p) => planView(deps, p)) }),
  );

  server.registerTool(
    "cancel",
    {
      title: "Cancel a task",
      description: "Take a queued task out of the queue, or cancel its open run. Only do it when the person asks.",
      inputSchema: { task_id: z.string().regex(/^TASK-\d{3,}$/), reason: z.string().trim().min(1).max(300) },
    },
    async ({ task_id, reason }) => {
      const queued = deps.plans.queued().find((t) => t.projectPath === projectPath && t.taskId === task_id);
      if (queued) {
        deps.plans.cancelTask(queued.id, `Cancelled by the orchestrator: ${reason}`);
        deps.plans.recordEvent("plan", queued.planId, "task_cancelled", { taskId: task_id, reason, by: "orchestrator" });
        return text(`${task_id} left the queue.`);
      }
      const run = deps.runs.listOpen().find((r) => r.projectPath === projectPath && r.taskId === task_id);
      if (!run) return text(`${task_id} is neither queued nor running.`, true);
      deps.runs.recordEvent(run.id, "cancel_requested", { reason, by: "orchestrator" });
      const result = await deps.runService.cancel(run.id);
      return text(result.message, !result.ok);
    },
  );

  return server;
}
