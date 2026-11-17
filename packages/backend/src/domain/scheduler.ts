/** A queued plan task, with the dependencies the caller found unmerged. */
export interface QueueItem {
  id: string;
  projectPath: string;
  taskId: string;
  modules: string[];
  priority: number;
  wave: number;
  queuedAt: number;
  unmergedDeps: string[];
}

/** A run that holds a session slot (queued, running or needs_human). */
export interface ActiveRun {
  runId: string;
  projectPath: string;
  taskId: string;
  modules: string[];
}

/** A run waiting for review that has unhandled feedback. */
export interface ReviewCandidate {
  runId: string;
  taskId: string;
  requestedAt: number;
}

export interface SchedulerInput {
  items: QueueItem[];
  active: ActiveRun[];
  reviews: ReviewCandidate[];
  /** Sessions Forge may run at once, across projects. */
  maxConcurrency: number;
  /** `policies.max_concurrency` per project path, a lower cap for that project. */
  projectCaps?: Record<string, number>;
  paused: { reason: string } | null;
  /** Latest 5-hour usage window reported by Claude Code. */
  usage: { percent: number; resetsAt: number } | null;
  usagePausePercent: number;
  now: number;
}

export interface SchedulerDecision {
  /** Plan task ids to launch, in order. */
  launches: string[];
  /** Run ids whose review round may start, in order. */
  reviews: string[];
  /** Why each queued task that is not launched is waiting. */
  waits: Record<string, string>;
  reviewWaits: Record<string, string>;
}

const norm = (module: string) => module.trim().replace(/\/+$/, "");
const overlaps = (a: string, b: string) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);

/**
 * Decides what starts now. Pure: the LLM proposes the plan, this function
 * applies the rules in code. Review rounds of open PRs go first, then tasks by
 * priority, wave and queue time; a task never shares a module with a running
 * one, and nothing starts while the queue is paused or usage is too high.
 */
export function schedule(input: SchedulerInput): SchedulerDecision {
  const decision: SchedulerDecision = { launches: [], reviews: [], waits: {}, reviewWaits: {} };
  const reviews = [...input.reviews].sort((a, b) => a.requestedAt - b.requestedAt);
  const items = [...input.items].sort((a, b) => b.priority - a.priority || a.wave - b.wave || a.queuedAt - b.queuedAt);

  const blocked =
    input.paused !== null
      ? `Queue paused: ${input.paused.reason}`
      : input.usage && input.usage.percent >= input.usagePausePercent && input.usage.resetsAt > input.now
        ? `Usage window at ${Math.round(input.usage.percent)}% (pause at ${input.usagePausePercent}%)`
        : null;
  if (blocked) {
    for (const r of reviews) decision.reviewWaits[r.runId] = blocked;
    for (const i of items) decision.waits[i.id] = blocked;
    return decision;
  }

  let busy = input.active.length;
  const slotWait = () => `Waiting for a slot (${Math.min(busy, input.maxConcurrency)} of ${input.maxConcurrency} sessions busy)`;
  for (const r of reviews) {
    if (busy < input.maxConcurrency) {
      decision.reviews.push(r.runId);
      busy++;
    } else decision.reviewWaits[r.runId] = slotWait();
  }

  const perProject = new Map<string, number>();
  for (const a of input.active) perProject.set(a.projectPath, (perProject.get(a.projectPath) ?? 0) + 1);
  const holders = input.active.map((a) => ({ projectPath: a.projectPath, taskId: a.taskId, modules: a.modules.map(norm) }));
  for (const i of items) {
    if (i.unmergedDeps.length) {
      decision.waits[i.id] = `Waits for ${i.unmergedDeps.join(", ")} merge`;
      continue;
    }
    if (holders.some((h) => h.projectPath === i.projectPath && h.taskId === i.taskId)) {
      decision.waits[i.id] = `${i.taskId} already has an open run`;
      continue;
    }
    const modules = i.modules.map(norm);
    const conflict = holders
      .filter((h) => h.projectPath === i.projectPath)
      .flatMap((h) => h.modules.filter((m) => modules.some((mine) => overlaps(mine, m))).map((m) => ({ m, task: h.taskId })))[0];
    if (conflict) {
      decision.waits[i.id] = `Module busy: ${conflict.m} (${conflict.task})`;
      continue;
    }
    if (busy >= input.maxConcurrency) {
      decision.waits[i.id] = slotWait();
      continue;
    }
    const cap = input.projectCaps?.[i.projectPath];
    const mine = perProject.get(i.projectPath) ?? 0;
    if (cap !== undefined && mine >= cap) {
      decision.waits[i.id] = `Waiting for a slot (${mine} of ${cap} sessions for this project busy)`;
      continue;
    }
    perProject.set(i.projectPath, mine + 1);
    decision.launches.push(i.id);
    holders.push({ projectPath: i.projectPath, taskId: i.taskId, modules });
    busy++;
  }
  return decision;
}
