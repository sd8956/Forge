import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { nextPlanStatus, nextPlanTaskState, type PlanEvent, type PlannedTask, type PlanTaskEvent } from "../domain/plan.js";
import type { Db } from "./client.js";
import { events, executionPlans, planTasks, settings, type EventRow, type ExecutionPlanRow, type PlanTaskRow } from "./schema.js";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export class PlanTransitionError extends Error {}

/** All reads and writes of plans and the queue. Status changes only go through the transition tables. */
export class PlanStore {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
    private readonly onEvent: (event: EventRow) => void = () => undefined,
  ) {}

  /** Stores a proposal; an older proposal for the same project that is still proposed is superseded. */
  propose(projectPath: string, rationale: string, tasks: PlannedTask[], proposedBy: string): ExecutionPlanRow {
    const plan = this.db.transaction((tx) => {
      const now = this.now();
      const older = tx
        .select()
        .from(executionPlans)
        .where(and(eq(executionPlans.projectPath, projectPath), eq(executionPlans.status, "proposed")))
        .all();
      for (const o of older) this.movePlan(tx, o, "supersede");
      const created = tx.insert(executionPlans).values({ id: randomUUID(), projectPath, status: "proposed", rationale, proposedBy, createdAt: now }).returning().get();
      for (const t of tasks) {
        tx.insert(planTasks).values({ id: randomUUID(), planId: created.id, projectPath, ...t, state: "planned", createdAt: now }).run();
      }
      return created;
    });
    this.recordEvent("plan", plan.id, "plan_proposed", { projectPath, tasks: tasks.map((t) => t.taskId), proposedBy });
    return plan;
  }

  /** Approving queues every task of the plan for the scheduler. */
  approve(planId: string): { ok: true } | { ok: false; message: string } {
    const result = this.db.transaction((tx) => {
      const plan = tx.select().from(executionPlans).where(eq(executionPlans.id, planId)).get();
      if (!plan) return { ok: false as const, message: "Unknown plan" };
      if (!nextPlanStatus(plan.status, "approve")) return { ok: false as const, message: `The plan is ${plan.status}` };
      const tasks = tx.select().from(planTasks).where(eq(planTasks.planId, planId)).all();
      const busy = tx
        .select({ taskId: planTasks.taskId })
        .from(planTasks)
        .where(and(eq(planTasks.projectPath, plan.projectPath), eq(planTasks.state, "queued"), inArray(planTasks.taskId, tasks.map((t) => t.taskId))))
        .all();
      if (busy.length) return { ok: false as const, message: `Already queued by another plan: ${busy.map((b) => b.taskId).join(", ")}` };
      this.movePlan(tx, plan, "approve");
      for (const t of tasks) this.moveTask(tx, t, "queue", { queuedAt: this.now() });
      return { ok: true as const };
    });
    if (result.ok) this.recordEvent("plan", planId, "plan_approved", {});
    return result;
  }

  reject(planId: string): boolean {
    const rejected = this.db.transaction((tx) => {
      const plan = tx.select().from(executionPlans).where(eq(executionPlans.id, planId)).get();
      if (!plan || !nextPlanStatus(plan.status, "reject")) return false;
      this.movePlan(tx, plan, "reject");
      return true;
    });
    if (rejected) this.recordEvent("plan", planId, "plan_rejected", {});
    return rejected;
  }

  /** Moves an approved plan to done or cancelled. */
  finish(planId: string, event: "complete" | "cancel"): boolean {
    return this.db.transaction((tx) => {
      const plan = tx.select().from(executionPlans).where(eq(executionPlans.id, planId)).get();
      if (!plan || !nextPlanStatus(plan.status, event)) return false;
      this.movePlan(tx, plan, event);
      return true;
    });
  }

  get(planId: string): ExecutionPlanRow | undefined {
    return this.db.select().from(executionPlans).where(eq(executionPlans.id, planId)).get();
  }

  plans(projectPath?: string): ExecutionPlanRow[] {
    const query = this.db.select().from(executionPlans);
    return (projectPath ? query.where(eq(executionPlans.projectPath, projectPath)) : query).orderBy(desc(executionPlans.createdAt)).all();
  }

  approvedPlans(): ExecutionPlanRow[] {
    return this.db.select().from(executionPlans).where(eq(executionPlans.status, "approved")).all();
  }

  tasks(planId: string): PlanTaskRow[] {
    return this.db.select().from(planTasks).where(eq(planTasks.planId, planId)).orderBy(asc(planTasks.wave), asc(planTasks.createdAt)).all();
  }

  task(id: string): PlanTaskRow | undefined {
    return this.db.select().from(planTasks).where(eq(planTasks.id, id)).get();
  }

  queued(): PlanTaskRow[] {
    return this.db.select().from(planTasks).where(eq(planTasks.state, "queued")).orderBy(asc(planTasks.queuedAt)).all();
  }

  launchedFor(runId: string): PlanTaskRow | undefined {
    return this.db.select().from(planTasks).where(eq(planTasks.runId, runId)).get();
  }

  markLaunched(id: string, runId: string): void {
    this.taskEvent(id, "launch", { runId, waitReason: null });
  }

  /** Takes a queued task out of the queue; `reason` explains why (a failed launch or a person). */
  cancelTask(id: string, reason: string | null = null): void {
    this.taskEvent(id, "cancel", { waitReason: reason });
  }

  /** Puts a launched task back in the queue, for a person who wants another run. */
  requeue(id: string): void {
    this.taskEvent(id, "requeue", { runId: null, queuedAt: this.now(), waitReason: null });
  }

  setWaitReason(id: string, reason: string | null): void {
    this.db.update(planTasks).set({ waitReason: reason }).where(eq(planTasks.id, id)).run();
  }

  recordEvent(entity: "plan" | "queue", id: string, type: string, payload: Record<string, unknown>): void {
    this.onEvent(this.db.insert(events).values({ entity, entityId: id, type, payload, ts: this.now() }).returning().get());
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

  // -------------------------------------------------------------- internals
  private movePlan(tx: Tx, plan: ExecutionPlanRow, event: PlanEvent): void {
    const to = nextPlanStatus(plan.status, event);
    if (!to) throw new PlanTransitionError(`Plan ${plan.id} cannot ${event} from ${plan.status}`);
    tx.update(executionPlans).set({ status: to, decidedAt: this.now() }).where(eq(executionPlans.id, plan.id)).run();
    if (to === "rejected" || to === "cancelled") {
      for (const t of tx.select().from(planTasks).where(eq(planTasks.planId, plan.id)).all()) {
        if (nextPlanTaskState(t.state, "cancel")) this.moveTask(tx, t, "cancel");
      }
    }
  }

  private moveTask(tx: Tx, task: PlanTaskRow, event: PlanTaskEvent, patch: Partial<PlanTaskRow> = {}): void {
    const to = nextPlanTaskState(task.state, event);
    if (!to) throw new PlanTransitionError(`${task.taskId} cannot ${event} from ${task.state}`);
    tx.update(planTasks).set({ ...patch, state: to }).where(eq(planTasks.id, task.id)).run();
  }

  private taskEvent(id: string, event: PlanTaskEvent, patch: Partial<PlanTaskRow>): void {
    this.db.transaction((tx) => {
      const task = tx.select().from(planTasks).where(eq(planTasks.id, id)).get();
      if (!task) throw new PlanTransitionError(`Unknown plan task ${id}`);
      this.moveTask(tx, task, event, patch);
    });
  }
}
