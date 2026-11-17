import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import type { NewThread } from "../github/pr-diff.js";
import type { Db } from "./client.js";
import { prThreads, type PrThreadRow } from "./schema.js";

export class PrThreadStore {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {}

  /** Inserts the threads not seen before for this run; returns only the new ones. */
  insertNew(runId: string, threads: NewThread[]): PrThreadRow[] {
    if (threads.length === 0) return [];
    return this.db
      .insert(prThreads)
      .values(threads.map((t) => ({ id: randomUUID(), runId, createdAt: this.now(), ...t })))
      .onConflictDoNothing({ target: [prThreads.runId, prThreads.externalId] })
      .returning()
      .all();
  }

  externalIds(runId: string): Set<string> {
    return new Set(this.db.select({ id: prThreads.externalId }).from(prThreads).where(eq(prThreads.runId, runId)).all().map((r) => r.id));
  }

  unhandled(runId: string): PrThreadRow[] {
    return this.db
      .select()
      .from(prThreads)
      .where(and(eq(prThreads.runId, runId), isNull(prThreads.handledByStepId)))
      .orderBy(asc(prThreads.createdAt))
      .all();
  }

  list(runId: string): PrThreadRow[] {
    return this.db.select().from(prThreads).where(eq(prThreads.runId, runId)).orderBy(asc(prThreads.createdAt)).all();
  }

  markHandled(runId: string, externalIds: string[], stepId: string): void {
    if (externalIds.length === 0) return;
    this.db
      .update(prThreads)
      .set({ handledByStepId: stepId, handledAt: this.now() })
      .where(and(eq(prThreads.runId, runId), inArray(prThreads.externalId, externalIds), isNull(prThreads.handledByStepId)))
      .run();
  }

  setBody(id: string, body: string): void {
    this.db.update(prThreads).set({ body }).where(eq(prThreads.id, id)).run();
  }
}
