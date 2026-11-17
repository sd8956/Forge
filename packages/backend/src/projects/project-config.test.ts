import { describe, expect, it } from "vitest";
import { FIXTURE } from "../../test/helpers.js";
import { listBacklog, loadProjectConfig } from "./project-config.js";

describe("project config", () => {
  it("reads the fixture project.yaml with review defaults", () => {
    expect(loadProjectConfig(FIXTURE)).toMatchObject({ name: "demo-project", platforms: ["web"], review: { allowed_authors: [] } });
  });

  it("lists the backlog with titles, sizes, coverage and dependencies", () => {
    expect(listBacklog(FIXTURE).slice(0, 2)).toEqual([
      { id: "TASK-001", title: "Add and list todos", size: "S", covers: ["FR-001", "FR-002"], dependsOn: [] },
      { id: "TASK-002", title: "Show the todo count", size: "S", covers: ["FR-003"], dependsOn: ["TASK-001"] },
    ]);
  });
});
