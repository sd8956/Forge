import type { PlanTaskView, PlanView, QueueView } from "@forge/shared";
import type { ForgeConfig } from "../config.js";
import type { PlanStore } from "../db/plan-store.js";
import type { RunStore } from "../db/run-store.js";
import type { ExecutionPlanRow, PlanTaskRow } from "../db/schema.js";
import { listBacklog } from "../projects/project-config.js";
import type { SchedulerService } from "../runs/scheduler-service.js";

interface ViewDeps {
  config: ForgeConfig;
  plans: PlanStore;
  runs: RunStore;
  scheduler: SchedulerService;
}

function titles(projectPath: string): Map<string, string> {
  try {
    return new Map(listBacklog(projectPath).map((t) => [t.id, t.title]));
  } catch {
    return new Map();
  }
}

function taskView(deps: ViewDeps, row: PlanTaskRow, names: Map<string, string>): PlanTaskView {
  return {
    id: row.id,
    taskId: row.taskId,
    title: names.get(row.taskId) ?? row.taskId,
    wave: row.wave,
    modules: row.modules,
    priority: row.priority,
    dependsOn: row.dependsOn,
    state: row.state,
    waitReason: row.waitReason,
    runId: row.runId,
    runStatus: row.runId ? (deps.runs.get(row.runId)?.status ?? null) : null,
  };
}

export function planView(deps: ViewDeps, plan: ExecutionPlanRow): PlanView {
  const names = titles(plan.projectPath);
  return {
    id: plan.id,
    projectPath: plan.projectPath,
    status: plan.status,
    rationale: plan.rationale,
    proposedBy: plan.proposedBy,
    createdAt: plan.createdAt,
    decidedAt: plan.decidedAt,
    tasks: deps.plans.tasks(plan.id).map((t) => taskView(deps, t, names)),
  };
}

export function queueView(deps: ViewDeps, projectPath?: string): QueueView {
  const names = new Map<string, Map<string, string>>();
  const namesFor = (path: string) => names.get(path) ?? names.set(path, titles(path)).get(path)!;
  return {
    paused: deps.scheduler.pauseState(),
    usage: deps.scheduler.usage(),
    usagePausePercent: deps.scheduler.limits().usagePausePercent,
    maxConcurrency: deps.scheduler.limits().maxConcurrency,
    active: deps.runs
      .listOpen()
      .filter((r) => !projectPath || r.projectPath === projectPath)
      .map((r) => ({ runId: r.id, taskId: r.taskId, projectPath: r.projectPath, status: r.status, currentStep: r.currentStep })),
    queued: deps.plans
      .queued()
      .filter((t) => !projectPath || t.projectPath === projectPath)
      .map((t) => ({ ...taskView(deps, t, namesFor(t.projectPath)), planId: t.planId, projectPath: t.projectPath })),
  };
}
