import { describe, expect, it } from "vitest";
import { decideStop, type StopContext } from "./stop-policy.js";

const base: StopContext = {
  reported: false,
  stepStatus: "running",
  stopHookActive: false,
  blockCount: 0,
  maxBlocks: 3,
  backgroundTasks: 0,
};

describe("decideStop", () => {
  it("allows the stop once the step was reported", () => {
    expect(decideStop({ ...base, reported: true })).toEqual({ action: "allow", why: "reported" });
  });

  it("blocks a stop without report and tells the agent to call report_step", () => {
    const decision = decideStop(base);
    expect(decision.action).toBe("block");
    if (decision.action !== "block") throw new Error("unreachable");
    expect(decision.reason).toContain("report_step");
    expect(decision.reason).toContain("1/3");
  });

  it("keeps blocking while stop_hook_active is true and blocks remain", () => {
    expect(decideStop({ ...base, stopHookActive: true, blockCount: 1 }).action).toBe("block");
    expect(decideStop({ ...base, stopHookActive: true, blockCount: 2 }).action).toBe("block");
  });

  it("stops blocking after the maximum and escalates to a person", () => {
    expect(decideStop({ ...base, stopHookActive: true, blockCount: 3 })).toEqual({ action: "allow", why: "block_limit" });
  });

  it("never blocks when stop_hook_active is true and the limit is zero", () => {
    expect(decideStop({ ...base, stopHookActive: true, maxBlocks: 0 })).toEqual({ action: "allow", why: "block_limit" });
  });

  it("allows the stop while background tasks are pending, without spending a block", () => {
    expect(decideStop({ ...base, backgroundTasks: 2 })).toEqual({ action: "allow", why: "background_tasks" });
  });

  it("keeps the safety net after a person answered a prompt (needs_human)", () => {
    expect(decideStop({ ...base, stepStatus: "needs_human" }).action).toBe("block");
  });

  it("allows the stop for steps that are already finished", () => {
    expect(decideStop({ ...base, stepStatus: "failed" })).toEqual({ action: "allow", why: "not_running" });
  });
});
