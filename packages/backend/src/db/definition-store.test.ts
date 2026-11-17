import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type OpenedDb } from "./client.js";
import { DefinitionStore } from "./definition-store.js";

describe("DefinitionStore", () => {
  let opened: OpenedDb;
  let store: DefinitionStore;
  beforeEach(() => {
    opened = openDatabase(":memory:");
    store = new DefinitionStore(opened.db, () => 1000);
  });
  afterEach(() => opened.close());

  it("creates the six stages pending and moves them only through the transition table", () => {
    store.create({ projectId: "p1", repoPath: "/r", worktreePath: "/r/.worktrees/definition", branch: "forge/definition", idea: "A link shortener" });
    expect(store.stages("p1").map((s) => `${s.stage}:${s.status}`)).toEqual([
      "intake:pending",
      "requirements:pending",
      "architecture:pending",
      "test_strategy:pending",
      "design:pending",
      "backlog:pending",
    ]);
    expect(store.transition("p1", "intake", "approve")).toBe(false);
    expect(store.transition("p1", "intake", "start", { stepId: "s1" })).toBe(true);
    expect(store.byStep("s1")?.stage).toBe("intake");
    expect(store.transition("p1", "intake", "report", { summary: "x · web" })).toBe(true);
    expect(store.transition("p1", "intake", "request_changes", { feedback: "Add mobile" })).toBe(true);
    expect(store.stage("p1", "intake")).toMatchObject({ status: "changes_requested", feedback: "Add mobile", summary: "x · web" });
    expect(store.transition("p1", "intake", "start")).toBe(true);
    expect(store.transition("p1", "intake", "report")).toBe(true);
    expect(store.transition("p1", "intake", "approve", { approvedAt: 1000, commit: "abc" })).toBe(true);
    expect(store.transition("p1", "intake", "start")).toBe(false);
  });
});
