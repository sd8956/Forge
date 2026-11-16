import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type { RunStatus } from "@forge/shared";
import { nextRunStatus, type RunEvent, type RunTransitionResult } from "../domain/run-machine.js";
import type { Db } from "./client.js";
import { events, runs, steps, type NewRunRow, type RunRow, type StepRow } from "./schema.js";

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
      tx.insert(events).values({ entity: "run", entityId: inserted.id, type: "created", payload: { taskId: row.taskId }, ts: now }).run();
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
        tx.insert(events).values({ entity: "run", entityId: id, type: "transition_rejected", payload: { event, from: current.status, ...payload }, ts }).run();
        return result;
      }
      tx.update(runs)
        .set({ ...patch, status: result.to, updatedAt: ts })
        .where(and(eq(runs.id, id), eq(runs.status, result.from)))
        .run();
      tx.insert(events).values({ entity: "run", entityId: id, type: "transition", payload: { event, from: result.from, to: result.to, ...payload }, ts }).run();
      return result;
    });
  }

  update(id: string, patch: RunPatch): void {
    this.db.update(runs).set({ ...patch, updatedAt: this.now() }).where(eq(runs.id, id)).run();
  }

  recordEvent(id: string, type: string, payload: Record<string, unknown>): void {
    this.db.insert(events).values({ entity: "run", entityId: id, type, payload, ts: this.now() }).run();
  }
}
