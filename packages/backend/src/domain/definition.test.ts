import { describe, expect, it } from "vitest";
import { nextStage, nextStageStatus, stageAgent, stageKind, stageOfKind } from "./definition.js";

describe("definition stage transitions", () => {
  it.each([
    ["pending", "start", "running"],
    ["running", "report", "in_review"],
    ["running", "session_failed", "pending"],
    ["in_review", "approve", "approved"],
    ["in_review", "request_changes", "changes_requested"],
    ["changes_requested", "start", "running"],
    ["pending", "approve", null],
    ["running", "approve", null],
    ["approved", "start", null],
    ["approved", "request_changes", null],
    ["in_review", "start", null],
  ] as const)("%s --%s--> %s", (from, event, to) => {
    expect(nextStageStatus(from, event)).toBe(to);
  });

  it("orders the stages and names their sessions", () => {
    expect(nextStage("intake")).toBe("requirements");
    expect(nextStage("design")).toBe("backlog");
    expect(nextStage("backlog")).toBeNull();
    expect(stageKind("test_strategy")).toBe("def_test_strategy");
    expect(stageAgent("test_strategy")).toBe("forge-def-test-strategy");
    expect(stageOfKind("def_test_strategy")).toBe("test_strategy");
    expect(stageOfKind("plan")).toBeNull();
    expect(stageOfKind("def_unknown")).toBeNull();
  });
});
