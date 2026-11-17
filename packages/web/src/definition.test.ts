import { describe, expect, it } from "vitest";
import type { DefinitionView } from "./api.js";
import { currentStage, factoryTree, stageStatusText } from "./definition.js";

const view = (statuses: string[]): DefinitionView => ({
  projectId: "p",
  repoPath: "/r",
  worktreePath: "/r/.worktrees/definition",
  branch: "forge/definition",
  idea: "x",
  prUrl: null,
  files: [],
  fileVersions: {},
  mergedAt: null,
  prototypeScreens: [],
  stages: (["intake", "requirements", "architecture", "test_strategy", "design", "backlog"] as const).map((stage, i) => ({
    stage,
    status: statuses[i] as DefinitionView["stages"][number]["status"],
    summary: statuses[i] === "approved" ? `${stage} ok` : null,
    stepId: null,
    feedback: null,
    lastError: null,
    approvedScreens: [],
    approvedAt: null,
    commit: null,
  })),
});

describe("definition view helpers", () => {
  it("finds the stage in progress and describes each status", () => {
    const v = view(["approved", "approved", "in_review", "pending", "pending", "pending"]);
    expect(currentStage(v)?.stage).toBe("architecture");
    expect(v.stages.map(stageStatusText)).toEqual(["intake ok", "requirements ok", "In review", "Pending", "Pending", "Pending"]);
    expect(currentStage(view(Array(6).fill("approved") as string[]))).toBeNull();
  });

  it("marks .factory/ entries approved, current or pending by the stage that writes them", () => {
    const tree = factoryTree(view(["approved", "running", "pending", "pending", "pending", "pending"]));
    expect(tree.slice(0, 4)).toEqual([
      { path: "intake.md", state: "approved" },
      { path: "project.yaml", state: "approved" },
      { path: "requirements.md", state: "current" },
      { path: "architecture.md", state: "pending" },
    ]);
  });
});
