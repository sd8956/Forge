import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type OpenedDb } from "./client.js";
import { DuplicateStepError, StepStore } from "./step-store.js";

function newStep(id: string, sessionId: string) {
  return {
    id,
    projectPath: "/repo",
    taskId: "TASK-001",
    kind: "plan",
    agent: "forge-planner",
    tmuxSession: `forge-TASK-001-plan-${id}`,
    claudeSessionId: sessionId,
    worktreePath: "/repo/.worktrees/TASK-001",
    inputPath: "/repo/.worktrees/TASK-001/.factory/runs/TASK-001/plan/input.md",
    outputPath: "/repo/.worktrees/TASK-001/.factory/runs/TASK-001/plan/output.md",
    timeoutMs: 60_000,
  };
}

describe("StepStore", () => {
  let opened: OpenedDb;
  let store: StepStore;

  beforeEach(() => {
    opened = openDatabase(":memory:");
    store = new StepStore(opened.db, () => 1000);
  });
  afterEach(() => opened.close());

  it("inserts a queued step and logs its creation", () => {
    const row = store.insert(newStep("s1", "11111111-1111-4111-8111-111111111111"));
    expect(row.status).toBe("queued");
    expect(store.events("s1").map((e) => e.type)).toEqual(["created"]);
  });

  it("refuses a second live step for the same task and kind", () => {
    store.insert(newStep("s1", "11111111-1111-4111-8111-111111111111"));
    expect(() => store.insert(newStep("s2", "22222222-2222-4222-8222-222222222222"))).toThrow(DuplicateStepError);
  });

  it("allows a new step once the previous one is terminal", () => {
    store.insert(newStep("s1", "11111111-1111-4111-8111-111111111111"));
    store.transition("s1", "launch_failed");
    expect(store.insert(newStep("s2", "22222222-2222-4222-8222-222222222222")).status).toBe("queued");
  });

  it("applies valid transitions and records them", () => {
    store.insert(newStep("s1", "11111111-1111-4111-8111-111111111111"));
    expect(store.transition("s1", "launch", { startedAt: 5 })).toEqual({ ok: true, from: "queued", to: "running" });
    expect(store.get("s1")).toMatchObject({ status: "running", startedAt: 5 });
    expect(store.events("s1").at(-1)?.payload).toEqual({ event: "launch", from: "queued", to: "running" });
  });

  it("rejects invalid transitions without changing the step", () => {
    store.insert(newStep("s1", "11111111-1111-4111-8111-111111111111"));
    expect(store.transition("s1", "report_done", { summary: "x" }).ok).toBe(false);
    expect(store.get("s1")).toMatchObject({ status: "queued", summary: null });
    expect(store.events("s1").at(-1)?.type).toBe("transition_rejected");
  });

  it("finds a step by its Claude session id", () => {
    store.insert(newStep("s1", "11111111-1111-4111-8111-111111111111"));
    expect(store.getBySessionId("11111111-1111-4111-8111-111111111111")?.id).toBe("s1");
  });
});
