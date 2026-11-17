import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type OpenedDb } from "./client.js";
import { PlanStore } from "./plan-store.js";

const task = (taskId: string, wave = 0, dependsOn: string[] = []) => ({ taskId, wave, modules: ["src/server"], priority: 0, dependsOn });

describe("PlanStore", () => {
  let opened: OpenedDb;
  let plans: PlanStore;
  let now = 1000;

  beforeEach(() => {
    opened = openDatabase(":memory:");
    plans = new PlanStore(opened.db, () => now);
  });
  afterEach(() => opened.close());

  it("keeps tasks planned until the plan is approved, then queues them in order", () => {
    const plan = plans.propose("/repo", "two waves", [task("TASK-001"), task("TASK-002", 1, ["TASK-001"])], "orchestrator");
    expect(plans.queued()).toEqual([]);
    expect(plans.tasks(plan.id).map((t) => `${t.taskId}:${t.state}`)).toEqual(["TASK-001:planned", "TASK-002:planned"]);
    now = 2000;
    expect(plans.approve(plan.id)).toEqual({ ok: true });
    expect(plans.get(plan.id)).toMatchObject({ status: "approved", decidedAt: 2000 });
    expect(plans.queued().map((t) => t.taskId)).toEqual(["TASK-001", "TASK-002"]);
    expect(plans.approve(plan.id)).toEqual({ ok: false, message: "The plan is approved" });
  });

  it("supersedes an older proposal for the same project and can reject one", () => {
    const first = plans.propose("/repo", "first", [task("TASK-001")], "orchestrator");
    const second = plans.propose("/repo", "second", [task("TASK-001")], "orchestrator");
    expect(plans.get(first.id)?.status).toBe("rejected");
    expect(plans.reject(second.id)).toBe(true);
    expect(plans.reject(second.id)).toBe(false);
    expect(plans.approve(second.id)).toEqual({ ok: false, message: "The plan is rejected" });
  });

  it("refuses to approve a plan whose task another approved plan already queued", () => {
    const first = plans.propose("/repo", "first", [task("TASK-001")], "orchestrator");
    plans.approve(first.id);
    const second = plans.propose("/repo", "second", [task("TASK-001")], "orchestrator");
    expect(plans.approve(second.id)).toEqual({ ok: false, message: "Already queued by another plan: TASK-001" });
  });

  it("records launches, wait reasons and settings", () => {
    const plan = plans.propose("/repo", "one", [task("TASK-001")], "orchestrator");
    plans.approve(plan.id);
    const [queued] = plans.queued();
    plans.setWaitReason(queued!.id, "Waiting for a slot");
    expect(plans.queued()[0]?.waitReason).toBe("Waiting for a slot");
    plans.markLaunched(queued!.id, "run-1");
    expect(plans.queued()).toEqual([]);
    expect(plans.launchedFor("run-1")).toMatchObject({ taskId: "TASK-001", state: "launched", waitReason: null });
    plans.setSetting("queue.paused", { paused: true, reason: "manual" });
    plans.setSetting("queue.paused", { paused: false });
    expect(plans.getSetting("queue.paused")).toEqual({ paused: false });
    expect(plans.getSetting("missing")).toBeUndefined();
  });
});

describe("PlanStore transitions", () => {
  it("cancels the tasks of a rejected plan and refuses moves the tables do not allow", () => {
    const opened = openDatabase(":memory:");
    const plans = new PlanStore(opened.db);
    const plan = plans.propose("/repo", "one", [task("TASK-001")], "orchestrator");
    const [t] = plans.tasks(plan.id);
    expect(() => plans.markLaunched(t!.id, "run-1")).toThrow("TASK-001 cannot launch from planned");
    plans.reject(plan.id);
    expect(plans.tasks(plan.id)[0]?.state).toBe("cancelled");
    expect(plans.finish(plan.id, "complete")).toBe(false);
    opened.close();
  });
});
