import { execFileSync } from "node:child_process";
import { readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startBackend } from "../src/app.js";
import { Tmux } from "../src/runner/tmux.js";
import { Api, disposeTmux, FIXTURE, fakeEnv, makeProject, scratch, StubMemory, testConfig } from "./helpers.js";

const PLAN_AND_DESIGN = `version: 1
steps:
  - { id: plan, agent: forge-planner, model: opus, settings: steps/planner.settings.json, exit: { requires: [plan.md, test-plan.md], every_ac_has_tc: true } }
  - { id: design, agent: forge-designer, model: opus, settings: steps/designer.settings.json, exit: { requires: [design.md] } }
`;

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("agent preflight", () => {
  it("hands the run to a person when the worktree lacks the step's agent, and resumes after merging the base branch", async () => {
    const root = scratch();
    const project = makeProject(root, { pipeline: PLAN_AND_DESIGN });
    const git = (...args: string[]) => execFileSync("git", ["-C", project, "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], { encoding: "utf8" });
    // The designer agent does not exist yet when the task branch is created.
    unlinkSync(join(project, ".claude", "agents", "forge-designer.md"));
    git("commit", "-qam", "no designer yet");
    const config = testConfig(root, { extraEnv: fakeEnv(root) });
    const tmux = new Tmux(config.tmuxSocket);
    const backend = await startBackend(config, { memory: new StubMemory() });
    cleanups.push(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
    cleanups.push(() => disposeTmux(tmux, config.tmuxSocket));
    cleanups.push(() => backend.close());
    const api = new Api(backend.url, backend.token);

    const { id } = await api.startRun(project);
    const stuck = await api.waitForRun(id, "needs_human");
    expect(stuck).toMatchObject({ exitReason: "agent_missing:forge-designer", currentStep: "design" });
    expect(stuck.steps.map((s) => s.kind)).toEqual(["plan"]);
    const event = stuck.events.find((e) => e.type === "agent_missing");
    expect(event?.payload).toMatchObject({ agent: "forge-designer", onBase: false });

    // Plain resume cannot fix it: still missing.
    await api.request("POST", `/runs/${id}/resume`, {});
    expect((await api.waitForRun(id, "needs_human")).exitReason).toBe("agent_missing:forge-designer");

    // The agent lands on main; resume with mergeBase brings it into the task branch.
    writeFileSync(join(project, ".claude", "agents", "forge-designer.md"), readFileSync(join(FIXTURE, ".claude", "agents", "forge-designer.md")));
    git("add", ".");
    git("commit", "-qm", "add the designer");
    const resumed = await api.request("POST", `/runs/${id}/resume`, { mergeBase: true });
    expect(resumed.status).toBe(200);
    const done = await api.waitForRun(id, "waiting_review");
    expect(done.steps.map((s) => `${s.kind}:${s.status}`)).toEqual(["plan:done", "design:done"]);
    expect(done.events.some((e) => e.type === "base_merged")).toBe(true);
  });
});
