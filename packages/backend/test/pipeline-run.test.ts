import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startBackend } from "../src/app.js";
import { parseFrontmatter } from "../src/handoff/frontmatter.js";
import { commonFrontmatter } from "../src/handoff/output-validator.js";
import { Tmux } from "../src/runner/tmux.js";
import { Api, disposeTmux, fakeEnv, makeProject, readTrace, scratch, StubMemory, testConfig, waitFor, type RunDetail } from "./helpers.js";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup(script: Record<string, string[] | string> = {}, overrides: Parameters<typeof testConfig>[1] = {}) {
  const root = scratch();
  const project = makeProject(root);
  const config = testConfig(root, { extraEnv: fakeEnv(root, script), ...overrides });
  const tmux = new Tmux(config.tmuxSocket);
  const memory = new StubMemory([{ id: 1, title: "store seam", type: "decision", content: "Ref: TASK-001/plan", project: "demo-project", createdAt: "now", ref: "TASK-001/plan" }]);
  const backend = await startBackend(config, { memory });
  cleanups.push(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  cleanups.push(() => disposeTmux(tmux, config.tmuxSocket));
  cleanups.push(() => backend.close());
  return { root, project, backend, tmux, api: new Api(backend.url, backend.token) };
}

const sequence = (run: RunDetail) => run.steps.map((s) => `${s.kind}#${s.attempt}:${s.status}`);

function expectValidOutputs(run: RunDetail) {
  for (const step of run.steps) {
    const parsed = parseFrontmatter(readFileSync(step.outputPath, "utf8"));
    expect(parsed.ok, step.outputPath).toBe(true);
    if (parsed.ok) expect(commonFrontmatter.parse(parsed.data)).toMatchObject({ step: step.kind, attempt: step.attempt, status: step.status });
  }
}

describe("pipeline run with a fake claude", () => {
  it("runs plan → design → development → security → e2e → pr and stops in waiting_review", async () => {
    const ctx = await setup();
    const started = await ctx.api.startRun(ctx.project);
    expect(started).toMatchObject({ status: "running", currentStep: "plan", branch: "feat/TASK-001", baseBranch: "main" });

    const run = await ctx.api.waitForRun(started.id, "waiting_review");
    expect(sequence(run)).toEqual(["plan#1:done", "design#1:done", "development#1:done", "security#1:done", "e2e#1:done", "pr#1:done"]);
    expect(run).toMatchObject({ prUrl: "https://github.com/example/demo-project/pull/7", prNumber: 7, attempts: {}, exitReason: "completed" });
    expectValidOutputs(run);

    // Handoff: each step's input names the earlier steps' outputs; models come from the pipeline.
    const input = (kind: string) => readFileSync(run.steps.find((s) => s.kind === kind)?.inputPath ?? "", "utf8");
    expect(input("design")).toContain(".factory/runs/TASK-001/plan/1/output.md");
    expect(input("pr")).toContain(".factory/runs/TASK-001/e2e/1/evidence/manifest.json");
    const models = readTrace(ctx.root).filter((t) => t.type === "started").map((t) => `${String(t.kind)}:${String(t.model)}`);
    expect(models).toEqual(["plan:opus", "design:opus", "development:sonnet", "security:opus", "e2e:sonnet", "pr:sonnet"]);
    expect(run.memories).toMatchObject({ available: true, items: [{ ref: "TASK-001/plan" }] });
    await waitFor(async () => (await ctx.tmux.listSessions()).length === 0, "all sessions to close");
  });

  it("sends a failed e2e back to development, which recovers", async () => {
    const ctx = await setup({ e2e: ["failed", "done"] });
    const run = await ctx.api.waitForRun((await ctx.api.startRun(ctx.project)).id, "waiting_review");
    expect(sequence(run)).toEqual([
      "plan#1:done",
      "design#1:done",
      "development#1:done",
      "security#1:done",
      "e2e#1:failed",
      "development#2:done",
      "security#2:done",
      "e2e#2:done",
      "pr#1:done",
    ]);
    expect(run.attempts).toEqual({ e2e: 1 });
    const devRetry = readFileSync(run.steps[5]?.inputPath ?? "", "utf8");
    expect(devRetry).toContain("The `e2e` step failed (failure 1 of 3 allowed)");
    expect(devRetry).toContain("Fake e2e attempt 1: failed");
    expectValidOutputs(run);
  });

  it("hands the run to a person when security keeps failing, without manual intervention", async () => {
    const ctx = await setup({ security: ["failed", "failed", "failed"] });
    const run = await ctx.api.waitForRun((await ctx.api.startRun(ctx.project)).id, "needs_human");
    expect(sequence(run)).toEqual([
      "plan#1:done",
      "design#1:done",
      "development#1:done",
      "security#1:failed",
      "development#2:done",
      "security#2:failed",
      "development#3:done",
      "security#3:failed",
    ]);
    expect(run).toMatchObject({ attempts: { security: 3 }, exitReason: "attempts_exhausted:security", currentStep: "security", prUrl: null });
    await waitFor(async () => (await ctx.tmux.listSessions()).length === 0, "sessions to close");
  });

  it("resumes an exhausted run with a fresh budget for the stuck step", async () => {
    const ctx = await setup({ security: ["failed", "failed", "failed", "done"] });
    const { id } = await ctx.api.startRun(ctx.project);
    await ctx.api.waitForRun(id, "needs_human");
    const resumed = await ctx.api.request("POST", `/runs/${id}/resume`, {});
    expect(resumed.status).toBe(200);
    const run = await ctx.api.waitForRun(id, "waiting_review");
    expect(sequence(run).slice(-3)).toEqual(["security#4:done", "e2e#1:done", "pr#1:done"]);
    expect(run.attempts).toEqual({ security: 0 });
  });

  it("rejects a report whose output.md is invalid and accepts the fixed one", async () => {
    const ctx = await setup({ plan: ["bad-output-then-fix"] });
    const run = await ctx.api.waitForRun((await ctx.api.startRun(ctx.project)).id, "waiting_review");
    expect(readTrace(ctx.root).find((t) => t.type === "first_report")).toMatchObject({ isError: true });
    const plan = await ctx.api.step(run.steps[0]?.id ?? "");
    expect(plan.events.find((e) => e.type === "report_rejected")?.payload.issues).toEqual(["output.md must start with a YAML frontmatter block between --- lines"]);
  });

  it("refuses a development done while make check is red", async () => {
    const ctx = await setup({ development: ["done", "done"] }, { maxStopBlocks: 0 });
    // Break the lint rule in the task branch before development reports.
    const { id } = await ctx.api.startRun(ctx.project);
    const worktree = join(ctx.project, ".worktrees", "TASK-001");
    writeFileSync(join(worktree, "src", "broken.js"), "debugger;\n");
    const run = await ctx.api.waitForRun(id, "needs_human");
    const dev = run.steps.find((s) => s.kind === "development");
    // The report was refused, and with no Stop reminders left the step waits for a person.
    expect(dev).toMatchObject({ status: "needs_human" });
    const events = (await ctx.api.step(dev?.id ?? "")).events;
    expect(String(events.find((e) => e.type === "report_rejected")?.payload.issues)).toContain("`make check` failed");
  }, 40_000);

  it("blocks on a blocked step and records why", async () => {
    const ctx = await setup({ design: ["blocked"] });
    const run = await ctx.api.waitForRun((await ctx.api.startRun(ctx.project)).id, "needs_human");
    expect(run).toMatchObject({ exitReason: "blocked:design", currentStep: "design" });
  });

  it("cancels a run and closes its live session", async () => {
    const ctx = await setup({ plan: ["hang"] });
    const { id } = await ctx.api.startRun(ctx.project);
    await waitFor(async () => (await ctx.tmux.listSessions()).length === 1, "plan session");
    expect((await ctx.api.request("POST", `/runs/${id}/cancel`, {})).status).toBe(200);
    const run = await ctx.api.waitForRun(id, "cancelled");
    expect(run.steps[0]).toMatchObject({ status: "failed", exitReason: "cancelled" });
    await waitFor(async () => (await ctx.tmux.listSessions()).length === 0, "session to close");
  });

  it("refuses a second open run for the same task", async () => {
    const ctx = await setup({ plan: ["hang"] });
    await ctx.api.startRun(ctx.project);
    expect((await ctx.api.request("POST", "/runs", { projectPath: ctx.project, taskId: "TASK-001" })).status).toBe(409);
    expect(await ctx.api.runs()).toHaveLength(1);
  });

  it("refuses a project Claude Code does not trust yet", async () => {
    const ctx = await setup({}, { checkTrust: true });
    const res = await ctx.api.request("POST", "/runs", { projectPath: ctx.project, taskId: "TASK-001" });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain("does not trust");
    writeFileSync(join(ctx.root, "claude.json"), JSON.stringify({ projects: { [ctx.root]: { hasTrustDialogAccepted: true } } }));
    expect((await ctx.api.request("POST", "/runs", { projectPath: ctx.project, taskId: "TASK-001" })).status).toBe(201);
  });

  it("rejects a project whose pipeline.yaml is invalid", async () => {
    const ctx = await setup();
    writeFileSync(join(ctx.project, ".factory", "pipeline.yaml"), "version: 1\nsteps: [{ id: deploy }]\n");
    const res = await ctx.api.request("POST", "/runs", { projectPath: ctx.project, taskId: "TASK-001" });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain('unknown step \\"deploy\\"');
    expect(await ctx.tmux.listSessions()).toEqual([]);
  });
});
