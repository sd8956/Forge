import { and, asc, eq, inArray } from "drizzle-orm";
import type { StepStatus, StepView } from "@forge/shared";
import { nextStatus, type StepEvent, type TransitionResult } from "../domain/step-machine.js";
import type { Db } from "./client.js";
import { events, steps, type EventRow, type NewStepRow, type StepRow } from "./schema.js";

const LIVE_STATUSES: StepStatus[] = ["queued", "running", "needs_human"];

type StepPatch = Partial<Omit<StepRow, "id" | "status">>;

export class DuplicateStepError extends Error {
  constructor(readonly taskId: string, readonly kind: string) {
    super(`Step "${kind}" of ${taskId} is already queued or running`);
  }
}

/** All reads and writes of `step` and `event`. Status changes only go through `transition`. */
export class StepStore {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {}

  insert(row: Omit<NewStepRow, "status" | "createdAt">): StepRow {
    return this.db.transaction((tx) => {
      const live = tx
        .select({ id: steps.id })
        .from(steps)
        .where(and(eq(steps.projectPath, row.projectPath), eq(steps.taskId, row.taskId), eq(steps.kind, row.kind), inArray(steps.status, LIVE_STATUSES)))
        .get();
      if (live) throw new DuplicateStepError(row.taskId, row.kind);
      const inserted = tx
        .insert(steps)
        .values({ ...row, status: "queued", createdAt: this.now() })
        .returning()
        .get();
      this.appendEvent(tx, inserted.id, "created", { taskId: row.taskId, kind: row.kind, agent: row.agent });
      return inserted;
    });
  }

  get(id: string): StepRow | undefined {
    return this.db.select().from(steps).where(eq(steps.id, id)).get();
  }

  getBySessionId(claudeSessionId: string): StepRow | undefined {
    return this.db.select().from(steps).where(eq(steps.claudeSessionId, claudeSessionId)).get();
  }

  listLive(): StepRow[] {
    return this.db.select().from(steps).where(inArray(steps.status, LIVE_STATUSES)).orderBy(asc(steps.createdAt)).all();
  }

  list(): StepRow[] {
    return this.db.select().from(steps).orderBy(asc(steps.createdAt)).all();
  }

  /**
   * Applies a state machine event atomically. The update is guarded by the
   * status that was read, so two concurrent events cannot both win.
   */
  transition(id: string, event: StepEvent, patch: StepPatch = {}, payload: Record<string, unknown> = {}): TransitionResult {
    return this.db.transaction((tx) => {
      const current = tx.select({ status: steps.status }).from(steps).where(eq(steps.id, id)).get();
      if (!current) throw new Error(`Unknown step ${id}`);
      const result = nextStatus(current.status, event);
      if (!result.ok) {
        this.appendEvent(tx, id, "transition_rejected", { event, from: current.status, ...payload });
        return result;
      }
      tx.update(steps)
        .set({ ...patch, status: result.to })
        .where(and(eq(steps.id, id), eq(steps.status, result.from)))
        .run();
      this.appendEvent(tx, id, "transition", { event, from: result.from, to: result.to, ...payload });
      return result;
    });
  }

  update(id: string, patch: StepPatch): void {
    this.db.update(steps).set(patch).where(eq(steps.id, id)).run();
  }

  incrementStopBlocks(id: string): number {
    const row = this.get(id);
    if (!row) throw new Error(`Unknown step ${id}`);
    const next = row.stopBlockCount + 1;
    this.update(id, { stopBlockCount: next });
    return next;
  }

  recordEvent(entityId: string, type: string, payload: Record<string, unknown>, entity = "step"): void {
    this.appendEvent(this.db, entityId, type, payload, entity);
  }

  events(entityId: string): EventRow[] {
    return this.db.select().from(events).where(eq(events.entityId, entityId)).orderBy(asc(events.id)).all();
  }

  private appendEvent(db: Pick<Db, "insert">, entityId: string, type: string, payload: Record<string, unknown>, entity = "step"): void {
    db.insert(events).values({ entity, entityId, type, payload, ts: this.now() }).run();
  }
}

export function toStepView(row: StepRow): StepView {
  return {
    id: row.id,
    taskId: row.taskId,
    kind: row.kind,
    agent: row.agent,
    status: row.status,
    tmuxSession: row.tmuxSession,
    claudeSessionId: row.claudeSessionId,
    worktreePath: row.worktreePath,
    inputPath: row.inputPath,
    outputPath: row.outputPath,
    transcriptPath: row.transcriptPath,
    exitReason: row.exitReason,
    summary: row.summary,
    artifacts: row.artifacts ?? [],
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    deadlineAt: row.deadlineAt,
  };
}
