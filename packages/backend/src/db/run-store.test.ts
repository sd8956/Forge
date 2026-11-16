import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type OpenedDb } from "./client.js";
import { DuplicateRunError, RunStore } from "./run-store.js";
import { StepStore } from "./step-store.js";

const newRun = (id: string) => ({
  id,
  projectPath: "/repo",
  taskId: "TASK-001",
  worktreePath: "/repo/.worktrees/TASK-001",
  branch: "feat/TASK-001",
  currentStep: "plan" as const,
});

describe("RunStore", () => {
  let opened: OpenedDb;
  let runs: RunStore;

  beforeEach(() => {
    opened = openDatabase(":memory:");
    runs = new RunStore(opened.db, () => 1000);
  });
  afterEach(() => opened.close());

  it("inserts a queued run with empty loop counters", () => {
    expect(runs.insert(newRun("r1"))).toMatchObject({ status: "queued", attempts: {}, currentStep: "plan" });
  });

  it("refuses a second open run for the same task", () => {
    runs.insert(newRun("r1"));
    expect(() => runs.insert(newRun("r2"))).toThrow(DuplicateRunError);
  });

  it("allows a new run once the previous one is closed", () => {
    runs.insert(newRun("r1"));
    runs.transition("r1", "cancel");
    expect(runs.insert(newRun("r2")).status).toBe("queued");
  });

  it("applies valid transitions with their patch and rejects the rest", () => {
    runs.insert(newRun("r1"));
    expect(runs.transition("r1", "start").ok).toBe(true);
    expect(runs.transition("r1", "resume").ok).toBe(false);
    runs.transition("r1", "attention", { attempts: { security: 3 }, exitReason: "attempts_exhausted:security" });
    expect(runs.get("r1")).toMatchObject({ status: "needs_human", attempts: { security: 3 } });
  });

  it("lists the steps of a run in order", () => {
    runs.insert(newRun("r1"));
    let t = 0;
    const steps = new StepStore(opened.db, () => ++t);
    for (const [id, kind] of [["s1", "plan"], ["s2", "design"]] as const) {
      steps.insert({
        id,
        runId: "r1",
        projectPath: "/repo",
        taskId: "TASK-001",
        kind,
        agent: `forge-${kind}`,
        tmuxSession: `forge-TASK-001-${kind}`,
        claudeSessionId: `${id}-session`,
        worktreePath: "/repo/.worktrees/TASK-001",
        inputPath: "in",
        outputPath: "out",
        timeoutMs: 1,
      });
    }
    expect(runs.steps("r1").map((s) => s.id)).toEqual(["s1", "s2"]);
    expect(runs.latestStep("r1")?.id).toBe("s2");
  });
});
