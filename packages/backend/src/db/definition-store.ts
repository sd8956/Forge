import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { DEFINITION_STAGES, type DefinitionStage } from "@forge/shared";
import { nextStageStatus, type DefinitionEvent } from "../domain/definition.js";
import type { Db } from "./client.js";
import { definitions, definitionStages, events, type DefinitionRow, type DefinitionStageRow, type EventRow } from "./schema.js";

type StagePatch = Partial<Omit<DefinitionStageRow, "id" | "projectId" | "stage" | "status">>;

export class DefinitionTransitionError extends Error {}

/** Reads and writes of a project definition. Stage status changes only through `transition`. */
export class DefinitionStore {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
    private readonly onEvent: (event: EventRow) => void = () => undefined,
  ) {}

  create(row: Omit<DefinitionRow, "createdAt" | "prUrl" | "mergedAt">): DefinitionRow {
    return this.db.transaction((tx) => {
      const created = tx.insert(definitions).values({ ...row, prUrl: null, createdAt: this.now() }).returning().get();
      for (const stage of DEFINITION_STAGES) {
        tx.insert(definitionStages).values({ id: randomUUID(), projectId: row.projectId, stage, status: "pending", approvedScreens: [], updatedAt: this.now() }).run();
      }
      return created;
    });
  }

  get(projectId: string): DefinitionRow | undefined {
    return this.db.select().from(definitions).where(eq(definitions.projectId, projectId)).get();
  }

  list(): DefinitionRow[] {
    return this.db.select().from(definitions).all();
  }

  setPrUrl(projectId: string, prUrl: string): void {
    this.db.update(definitions).set({ prUrl }).where(eq(definitions.projectId, projectId)).run();
  }

  setMerged(projectId: string): void {
    this.db.update(definitions).set({ mergedAt: this.now() }).where(eq(definitions.projectId, projectId)).run();
  }

  stages(projectId: string): DefinitionStageRow[] {
    const rows = this.db.select().from(definitionStages).where(eq(definitionStages.projectId, projectId)).all();
    return DEFINITION_STAGES.map((s) => rows.find((r) => r.stage === s)).filter((r): r is DefinitionStageRow => Boolean(r));
  }

  stage(projectId: string, stage: DefinitionStage): DefinitionStageRow {
    const row = this.db.select().from(definitionStages).where(and(eq(definitionStages.projectId, projectId), eq(definitionStages.stage, stage))).get();
    if (!row) throw new DefinitionTransitionError(`No ${stage} stage for project ${projectId}`);
    return row;
  }

  byStep(stepId: string): DefinitionStageRow | undefined {
    return this.db.select().from(definitionStages).where(eq(definitionStages.stepId, stepId)).get();
  }

  /** Applies an event from the transition table; returns false when it does not apply. */
  transition(projectId: string, stage: DefinitionStage, event: DefinitionEvent, patch: StagePatch = {}, payload: Record<string, unknown> = {}): boolean {
    const moved = this.db.transaction((tx) => {
      const row = tx.select().from(definitionStages).where(and(eq(definitionStages.projectId, projectId), eq(definitionStages.stage, stage))).get();
      const to = row ? nextStageStatus(row.status, event) : null;
      if (!row || !to) return null;
      tx.update(definitionStages).set({ ...patch, status: to, updatedAt: this.now() }).where(eq(definitionStages.id, row.id)).run();
      return { from: row.status, to };
    });
    if (moved) this.recordEvent(projectId, "stage_transition", { stage, event, ...moved, ...payload });
    return moved !== null;
  }

  update(projectId: string, stage: DefinitionStage, patch: StagePatch): void {
    this.db
      .update(definitionStages)
      .set({ ...patch, updatedAt: this.now() })
      .where(and(eq(definitionStages.projectId, projectId), eq(definitionStages.stage, stage)))
      .run();
  }

  recordEvent(projectId: string, type: string, payload: Record<string, unknown>): void {
    this.onEvent(this.db.insert(events).values({ entity: "definition", entityId: projectId, type, payload, ts: this.now() }).returning().get());
  }
}
