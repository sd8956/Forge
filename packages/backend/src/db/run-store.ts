import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type { RunStatus, RunView } from "@forge/shared";
import { nextRunStatus, type RunEvent, type RunTransitionResult } from "../domain/run-machine.js";
import type { Db } from "./client.js";
import { events, runs, steps, type EventRow, type NewRunRow, type RunRow, type StepRow } from "./schema.js";

const OPEN_STATUSES: RunStatus[] = ["queued", "running", "needs_human"];

type RunPatch = Partial<Omit<RunRow, "id" | "status" | "createdAt">>;

export class DuplicateRunError extends Error {
  constructor(readonly taskId: string, readonly runId: string) {
    super(`${taskId} already has an open run (${runId})`);
  }
}

/** All reads and writes of `run`. Status changes only go through `transition`. */
export class RunStore {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
    private readonly onEvent: (event: EventRow) => void = () => undefined,
  ) {}

  insert(row: Omit<NewRunRow, "status" | "createdAt" | "updatedAt" | "attempts">): RunRow {
    return this.db.transaction((tx) => {
      const open = tx
        .select({ id: runs.id })
        .from(runs)
        .where(and(eq(runs.projectPath, row.projectPath), eq(runs.taskId, row.taskId), inArray(runs.status, OPEN_STATUSES)))
        .get();
      if (open) throw new DuplicateRunError(row.taskId, open.id);
      const now = this.now();
      const inserted = tx
        .insert(runs)
        .values({ ...row, status: "queued", attempts: {}, createdAt: now, updatedAt: now })
        .returning()
        .get();
      this.onEvent(tx.insert(events).values({ entity: "run", entityId: inserted.id, type: "created", payload: { taskId: row.taskId }, ts: now }).returning().get());
      return inserted;
    });
  }

  get(id: string): RunRow | undefined {
    return this.db.select().from(runs).where(eq(runs.id, id)).get();
  }

  listOpen(): RunRow[] {
    return this.db.select().from(runs).where(inArray(runs.status, OPEN_STATUSES)).orderBy(asc(runs.createdAt)).all();
  }

  list(): RunRow[] {
    return this.db.select().from(runs).orderBy(asc(runs.createdAt)).all();
  }

  steps(runId: string): StepRow[] {
    return this.db.select().from(steps).where(eq(steps.runId, runId)).orderBy(asc(steps.createdAt)).all();
  }

  latestStep(runId: string): StepRow | undefined {
    return this.db.select().from(steps).where(eq(steps.runId, runId)).orderBy(desc(steps.createdAt)).limit(1).get();
  }

  /** Applies a run event atomically; the update is guarded by the status that was read. */
  transition(id: string, event: RunEvent, patch: RunPatch = {}, payload: Record<string, unknown> = {}): RunTransitionResult {
    return this.db.transaction((tx) => {
      const current = tx.select({ status: runs.status }).from(runs).where(eq(runs.id, id)).get();
      if (!current) throw new Error(`Unknown run ${id}`);
      const result = nextRunStatus(current.status, event);
      const ts = this.now();
      if (!result.ok) {
        this.onEvent(tx.insert(events).values({ entity: "run", entityId: id, type: "transition_rejected", payload: { event, from: current.status, ...payload }, ts }).returning().get());
        return result;
      }
      tx.update(runs)
        .set({ ...patch, status: result.to, updatedAt: ts })
        .where(and(eq(runs.id, id), eq(runs.status, result.from)))
        .run();
      this.onEvent(tx.insert(events).values({ entity: "run", entityId: id, type: "transition", payload: { event, from: result.from, to: result.to, ...payload }, ts }).returning().get());
      return result;
    });
  }

  update(id: string, patch: RunPatch): void {
    this.db.update(runs).set({ ...patch, updatedAt: this.now() }).where(eq(runs.id, id)).run();
  }

  recordEvent(id: string, type: string, payload: Record<string, unknown>): void {
    this.onEvent(this.db.insert(events).values({ entity: "run", entityId: id, type, payload, ts: this.now() }).returning().get());
  }
}

export function toRunView(row: RunRow): RunView {
  return {
    id: row.id,
    taskId: row.taskId,
    projectPath: row.projectPath,
    branch: row.branch,
    baseBranch: row.baseBranch,
    status: row.status,
    currentStep: row.currentStep,
    attempts: row.attempts,
    prUrl: row.prUrl,
    prNumber: row.prNumber,
    mode: row.mode,
    reviewRound: row.reviewRound,
    exitReason: row.exitReason,
    createdAt: row.createdAt,
    endedAt: row.endedAt,
  };
}
