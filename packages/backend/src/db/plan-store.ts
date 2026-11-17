import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type { PlannedTask } from "../domain/plan.js";
import type { Db } from "./client.js";
import { executionPlans, planTasks, settings, type ExecutionPlanRow, type PlanTaskRow } from "./schema.js";

export class PlanStore {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {}

  /** Stores a proposal; an older proposal for the same project is superseded. */
  propose(projectPath: string, rationale: string, tasks: PlannedTask[], proposedBy: string): ExecutionPlanRow {
    return this.db.transaction((tx) => {
      const now = this.now();
      tx.update(executionPlans)
        .set({ status: "rejected", decidedAt: now })
        .where(and(eq(executionPlans.projectPath, projectPath), eq(executionPlans.status, "proposed")))
        .run();
      const plan = tx.insert(executionPlans).values({ id: randomUUID(), projectPath, status: "proposed", rationale, proposedBy, createdAt: now }).returning().get();
      for (const t of tasks) {
        tx.insert(planTasks).values({ id: randomUUID(), planId: plan.id, projectPath, ...t, state: "planned", createdAt: now }).run();
      }
      return plan;
    });
  }

  /** Approving queues every task of the plan for the scheduler. */
  approve(planId: string): { ok: true } | { ok: false; message: string } {
    return this.db.transaction((tx) => {
      const plan = tx.select().from(executionPlans).where(eq(executionPlans.id, planId)).get();
      if (!plan) return { ok: false as const, message: "Unknown plan" };
      if (plan.status !== "proposed") return { ok: false as const, message: `The plan is ${plan.status}` };
      const tasks = tx.select().from(planTasks).where(eq(planTasks.planId, planId)).all();
      const busy = tx
        .select({ taskId: planTasks.taskId })
        .from(planTasks)
        .where(and(eq(planTasks.projectPath, plan.projectPath), inArray(planTasks.state, ["queued"]), inArray(planTasks.taskId, tasks.map((t) => t.taskId))))
        .all();
      if (busy.length) return { ok: false as const, message: `Already queued by another plan: ${busy.map((b) => b.taskId).join(", ")}` };
      const now = this.now();
      tx.update(executionPlans).set({ status: "approved", decidedAt: now }).where(eq(executionPlans.id, planId)).run();
      tx.update(planTasks).set({ state: "queued", queuedAt: now }).where(eq(planTasks.planId, planId)).run();
      return { ok: true as const };
    });
  }

  reject(planId: string): boolean {
    const result = this.db
      .update(executionPlans)
      .set({ status: "rejected", decidedAt: this.now() })
      .where(and(eq(executionPlans.id, planId), eq(executionPlans.status, "proposed")))
      .run();
    return result.changes > 0;
  }

  get(planId: string): ExecutionPlanRow | undefined {
    return this.db.select().from(executionPlans).where(eq(executionPlans.id, planId)).get();
  }

  plans(projectPath: string): ExecutionPlanRow[] {
    return this.db.select().from(executionPlans).where(eq(executionPlans.projectPath, projectPath)).orderBy(desc(executionPlans.createdAt)).all();
  }

  tasks(planId: string): PlanTaskRow[] {
    return this.db.select().from(planTasks).where(eq(planTasks.planId, planId)).orderBy(asc(planTasks.wave), asc(planTasks.createdAt)).all();
  }

  queued(): PlanTaskRow[] {
    return this.db.select().from(planTasks).where(eq(planTasks.state, "queued")).orderBy(asc(planTasks.queuedAt)).all();
  }

  launchedFor(runId: string): PlanTaskRow | undefined {
    return this.db.select().from(planTasks).where(eq(planTasks.runId, runId)).get();
  }

  markLaunched(id: string, runId: string): void {
    this.db.update(planTasks).set({ state: "launched", runId, waitReason: null }).where(eq(planTasks.id, id)).run();
  }

  setWaitReason(id: string, reason: string | null): void {
    this.db.update(planTasks).set({ waitReason: reason }).where(eq(planTasks.id, id)).run();
  }

  cancelTask(id: string): void {
    this.db.update(planTasks).set({ state: "cancelled", waitReason: null }).where(eq(planTasks.id, id)).run();
  }

  /** Re-queues a task of an approved plan (after a cancelled or failed run). */
  requeue(id: string): void {
    this.db.update(planTasks).set({ state: "queued", runId: null, queuedAt: this.now() }).where(eq(planTasks.id, id)).run();
  }

  setPlanStatus(planId: string, status: ExecutionPlanRow["status"]): void {
    this.db.update(executionPlans).set({ status }).where(eq(executionPlans.id, planId)).run();
  }

  // --------------------------------------------------------------- settings
  getSetting<T>(key: string): T | undefined {
    return this.db.select().from(settings).where(eq(settings.key, key)).get()?.value as T | undefined;
  }

  setSetting(key: string, value: unknown): void {
    this.db
      .insert(settings)
      .values({ key, value, updatedAt: this.now() })
      .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: this.now() } })
      .run();
  }
}
