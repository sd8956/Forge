import { describe, expect, it } from "vitest";
import { parseDependencies, unfinishedDependencyRuns } from "./dependencies.js";

describe("dependencies", () => {
  it("reads the Depends on line", () => {
    expect(parseDependencies("- Depends on: TASK-001, TASK-002 and TASK-001")).toEqual(["TASK-001", "TASK-002"]);
    expect(parseDependencies("- Depends on: none")).toEqual([]);
  });

  it("counts a dependency as unfinished unless its latest Forge run is done", () => {
    const run = (taskId: string, status: string, createdAt: number, projectPath = "/p") => ({ projectPath, taskId, status, createdAt });
    const runs = [run("TASK-001", "done", 1), run("TASK-002", "cancelled", 1), run("TASK-003", "done", 1), run("TASK-003", "running", 2), run("TASK-004", "failed", 1), run("TASK-004", "done", 2), run("TASK-005", "running", 1, "/other")];
    expect(unfinishedDependencyRuns(runs, "/p", ["TASK-001", "TASK-002", "TASK-003", "TASK-004", "TASK-005", "TASK-006"])).toEqual(["TASK-002", "TASK-003"]);
  });
});
