import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ForgeConfig } from "../config.js";
import { openDatabase, type OpenedDb } from "../db/client.js";
import { StepStore } from "../db/step-store.js";
import type { Tmux } from "../runner/tmux.js";
import { StepService } from "./step-service.js";

const step = (id: string) => ({
  id,
  projectPath: "/repo",
  taskId: "TASK-001",
  kind: "design",
  agent: "forge-designer",
  tmuxSession: `forge-TASK-001-design-${id}`,
  claudeSessionId: `${id}-session`,
  worktreePath: "/repo/.worktrees/TASK-001",
  inputPath: "in",
  outputPath: "out",
  timeoutMs: 60_000,
});

describe("StepService.sweep", () => {
  let opened: OpenedDb;
  let store: StepStore;

  beforeEach(() => {
    opened = openDatabase(":memory:");
    store = new StepStore(opened.db);
  });
  afterEach(() => opened.close());

  function service(listSessions: () => Promise<string[]>) {
    const tmux = { listSessions } as unknown as Tmux;
    return new StepService({ config: { home: "/nowhere" } as ForgeConfig, store, tmux, token: "t", url: () => "http://x" });
  }

  it("marks a running step whose session is gone", async () => {
    store.insert(step("a"));
    store.transition("a", "launch");
    await service(() => Promise.resolve([])).sweep();
    expect(store.get("a")).toMatchObject({ status: "failed", exitReason: "session_vanished" });
  });

  it("never marks a step that started while the session list was being read", async () => {
    // The session list is a snapshot taken before this step launched.
    await service(() => {
      store.insert(step("b"));
      store.transition("b", "launch");
      return Promise.resolve([]);
    }).sweep();
    expect(store.get("b")?.status).toBe("running");
  });
});
