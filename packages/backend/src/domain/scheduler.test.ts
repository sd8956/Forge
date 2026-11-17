import { describe, expect, it } from "vitest";
import { schedule, type SchedulerInput } from "./scheduler.js";

const P = "/repo";
const item = (taskId: string, extra: Partial<SchedulerInput["items"][number]> = {}) => ({
  id: `pt-${taskId}`,
  projectPath: P,
  taskId,
  modules: [`src/${taskId}`],
  priority: 0,
  wave: 0,
  queuedAt: 1,
  unmergedDeps: [],
  ...extra,
});
const active = (taskId: string, modules = [`src/${taskId}`], projectPath = P) => ({ runId: `run-${taskId}`, projectPath, taskId, modules });
const base: SchedulerInput = { items: [], active: [], reviews: [], maxConcurrency: 3, paused: null, usage: null, usagePausePercent: 90, now: 1000 };

describe("schedule", () => {
  it("launches up to the free slots and tells the rest to wait for one", () => {
    const result = schedule({ ...base, maxConcurrency: 2, active: [active("TASK-009")], items: [item("TASK-001"), item("TASK-002")] });
    expect(result.launches).toEqual(["pt-TASK-001"]);
    expect(result.waits).toEqual({ "pt-TASK-002": "Waiting for a slot (2 of 2 sessions busy)" });
  });

  it("orders by priority, then wave, then queue time", () => {
    const result = schedule({
      ...base,
      maxConcurrency: 2,
      items: [item("TASK-001", { queuedAt: 1 }), item("TASK-002", { queuedAt: 2, priority: 5 }), item("TASK-003", { queuedAt: 0, wave: 1 }), item("TASK-004", { queuedAt: 3 })],
    });
    expect(result.launches).toEqual(["pt-TASK-002", "pt-TASK-001"]);
    expect(Object.keys(result.waits)).toEqual(["pt-TASK-004", "pt-TASK-003"]);
  });

  it("waits for unmerged dependencies without taking a slot", () => {
    const result = schedule({ ...base, items: [item("TASK-002", { unmergedDeps: ["TASK-001"] }), item("TASK-003")] });
    expect(result.launches).toEqual(["pt-TASK-003"]);
    expect(result.waits["pt-TASK-002"]).toBe("Waits for TASK-001 merge");
  });

  it("never runs two tasks on the same module, including nested folders and tasks launched in the same pass", () => {
    const result = schedule({
      ...base,
      active: [active("TASK-009", ["src/server"])],
      items: [item("TASK-001", { modules: ["src/server/routes"] }), item("TASK-002", { modules: ["public"] }), item("TASK-003", { modules: ["public/"] }), item("TASK-004", { modules: ["src/serverless"] })],
    });
    expect(result.launches).toEqual(["pt-TASK-002", "pt-TASK-004"]);
    expect(result.waits).toEqual({ "pt-TASK-001": "Module busy: src/server (TASK-009)", "pt-TASK-003": "Module busy: public (TASK-002)" });
  });

  it("only compares modules within the same project", () => {
    const result = schedule({ ...base, active: [active("TASK-009", ["src"], "/other")], items: [item("TASK-001", { modules: ["src"] })] });
    expect(result.launches).toEqual(["pt-TASK-001"]);
  });

  it("does not launch a task that already has an open run", () => {
    const result = schedule({ ...base, active: [active("TASK-001", ["x"])], items: [item("TASK-001")] });
    expect(result.launches).toEqual([]);
    expect(result.waits["pt-TASK-001"]).toBe("TASK-001 already has an open run");
  });

  it("gives review rounds the free slots first, oldest first", () => {
    const result = schedule({
      ...base,
      maxConcurrency: 2,
      reviews: [
        { runId: "run-b", taskId: "TASK-008", requestedAt: 5 },
        { runId: "run-a", taskId: "TASK-007", requestedAt: 4 },
      ],
      active: [active("TASK-009")],
      items: [item("TASK-001")],
    });
    expect(result.reviews).toEqual(["run-a"]);
    expect(result.reviewWaits).toEqual({ "run-b": "Waiting for a slot (2 of 2 sessions busy)" });
    expect(result.waits["pt-TASK-001"]).toBe("Waiting for a slot (2 of 2 sessions busy)");
  });

  it("launches nothing while the queue is paused", () => {
    const result = schedule({ ...base, paused: { reason: "Paused by a person" }, items: [item("TASK-001")], reviews: [{ runId: "r", taskId: "TASK-007", requestedAt: 1 }] });
    expect(result).toMatchObject({ launches: [], reviews: [], waits: { "pt-TASK-001": "Queue paused: Paused by a person" }, reviewWaits: { r: "Queue paused: Paused by a person" } });
  });

  it("launches nothing while the usage window is over the threshold, until it resets", () => {
    const over = { ...base, usage: { percent: 95, resetsAt: 2000 }, items: [item("TASK-001")] };
    expect(schedule(over).waits["pt-TASK-001"]).toBe("Usage window at 95% (pause at 90%)");
    expect(schedule({ ...over, usage: { percent: 89, resetsAt: 2000 } }).launches).toEqual(["pt-TASK-001"]);
    expect(schedule({ ...over, now: 2000 }).launches).toEqual(["pt-TASK-001"]);
  });
});
