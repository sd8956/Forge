/** A plan proposed by the orchestrator, as its tool receives it. */
export interface PlanProposal {
  rationale: string;
  waves: { tasks: { id: string; modules: string[]; priority?: number | undefined }[] }[];
}

export interface PlannedTask {
  taskId: string;
  wave: number;
  modules: string[];
  priority: number;
  dependsOn: string[];
}

export type PlanValidation = { ok: true; tasks: PlannedTask[] } | { ok: false; issues: string[] };

const normalise = (module: string) => module.trim().replace(/\/+$/, "");

/**
 * Checks that a proposed plan is a valid DAG for the backlog: every task exists
 * and appears once, and every dependency is merged or scheduled in an earlier
 * wave. Pure: the orchestrator proposes, the backend decides.
 */
export function validatePlan(proposal: PlanProposal, backlog: { id: string; dependsOn: string[] }[], merged: Set<string>): PlanValidation {
  const issues: string[] = [];
  const known = new Map(backlog.map((t) => [t.id, t]));
  const seen = new Map<string, number>();
  const tasks: PlannedTask[] = [];

  proposal.waves.forEach((wave, index) => {
    for (const task of wave.tasks) {
      const spec = known.get(task.id);
      if (!spec) {
        issues.push(`${task.id} is not in the backlog`);
        continue;
      }
      if (seen.has(task.id)) {
        issues.push(`${task.id} appears more than once`);
        continue;
      }
      seen.set(task.id, index);
      const modules = [...new Set(task.modules.map(normalise).filter(Boolean))];
      if (modules.length === 0) issues.push(`${task.id} must list the modules it touches`);
      tasks.push({ taskId: task.id, wave: index, modules, priority: task.priority ?? 0, dependsOn: spec.dependsOn });
    }
  });

  for (const task of tasks) {
    for (const dep of task.dependsOn) {
      const depWave = seen.get(dep);
      if (!merged.has(dep) && (depWave === undefined || depWave >= task.wave)) {
        issues.push(`${task.taskId} depends on ${dep}, which must be merged or in an earlier wave`);
      }
    }
  }
  if (tasks.length === 0 && issues.length === 0) issues.push("The plan has no tasks");
  return issues.length ? { ok: false, issues } : { ok: true, tasks };
}

export type PlanStatus = "proposed" | "approved" | "rejected" | "done" | "cancelled";
export type PlanEvent = "approve" | "reject" | "supersede" | "complete" | "cancel";
export type PlanTaskState = "planned" | "queued" | "launched" | "cancelled";
export type PlanTaskEvent = "queue" | "launch" | "requeue" | "cancel";

const PLAN_TRANSITIONS: Record<PlanStatus, Partial<Record<PlanEvent, PlanStatus>>> = {
  proposed: { approve: "approved", reject: "rejected", supersede: "rejected" },
  approved: { complete: "done", cancel: "cancelled" },
  rejected: {},
  done: {},
  cancelled: {},
};

const PLAN_TASK_TRANSITIONS: Record<PlanTaskState, Partial<Record<PlanTaskEvent, PlanTaskState>>> = {
  planned: { queue: "queued", cancel: "cancelled" },
  queued: { launch: "launched", cancel: "cancelled" },
  launched: { requeue: "queued" },
  cancelled: {},
};

/** The only way a plan changes status; null when the event does not apply. */
export function nextPlanStatus(from: PlanStatus, event: PlanEvent): PlanStatus | null {
  return PLAN_TRANSITIONS[from][event] ?? null;
}

/** The only way a plan task moves through the queue; null when the event does not apply. */
export function nextPlanTaskState(from: PlanTaskState, event: PlanTaskEvent): PlanTaskState | null {
  return PLAN_TASK_TRANSITIONS[from][event] ?? null;
}
