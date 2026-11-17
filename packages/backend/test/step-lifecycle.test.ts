import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startBackend, type Backend } from "../src/app.js";
import { Tmux } from "../src/runner/tmux.js";
import { Api, disposeTmux, fakeEnv, makeProject, PLAN_ONLY_PIPELINE, readTrace, scratch, StubMemory, testConfig, waitFor, type RunDetail } from "./helpers.js";

interface Ctx {
  root: string;
  project: string;
  backend: Backend;
  api: Api;
  tmux: Tmux;
}

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A one-step pipeline (plan) so each test is about one session's lifecycle. */
async function setup(behaviour: string, overrides: Parameters<typeof testConfig>[1] = {}): Promise<Ctx> {
  const root = scratch();
  const project = makeProject(root, { pipeline: PLAN_ONLY_PIPELINE });
  const config = testConfig(root, { extraEnv: fakeEnv(root, { plan: [behaviour] }), ...overrides });
  const tmux = new Tmux(config.tmuxSocket);
  const backend = await startBackend(config, { memory: new StubMemory() });
  cleanups.push(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  cleanups.push(() => disposeTmux(tmux, config.tmuxSocket));
  cleanups.push(() => backend.close());
  return { root, project, backend, api: new Api(backend.url, backend.token), tmux };
}

async function startPlan(ctx: Ctx): Promise<RunDetail> {
  const { id } = await ctx.api.startRun(ctx.project);
  return waitFor(async () => {
    const run = await ctx.api.run(id);
    return run.steps.length ? run : undefined;
  }, "plan step to launch");
}

async function waitForStep(ctx: Ctx, runId: string, status: string) {
  return waitFor(async () => {
    const step = (await ctx.api.run(runId)).steps[0];
    return step?.status === status ? ctx.api.step(step.id) : undefined;
  }, `plan step to be ${status}`);
}

async function waitForClosed(ctx: Ctx, stepId: string) {
  return waitFor(async () => {
    const step = await ctx.api.step(stepId);
    return step.events.some((e) => e.type === "session_closed") && !(await ctx.tmux.hasSession(step.tmuxSession)) ? step : undefined;
  }, `step ${stepId} to close`);
}

describe("step lifecycle with a fake claude in tmux", () => {
  it("prepares the worktree and input, launches the agent and finishes only through report_step", async () => {
    const ctx = await setup("done");
    const run = await startPlan(ctx);
    const step = run.steps[0];
    if (!step) throw new Error("no step");

    expect(step.worktreePath).toBe(join(ctx.project, ".worktrees", "TASK-001"));
    expect(execFileSync("git", ["-C", step.worktreePath, "branch", "--show-current"], { encoding: "utf8" }).trim()).toBe("feat/TASK-001");
    expect(step.inputPath).toBe(join(step.worktreePath, ".factory/runs/TASK-001/plan/1/input.md"));
    const input = readFileSync(step.inputPath, "utf8");
    expect(input).toContain(".factory/backlog/TASK-001.md");
    expect(input).toContain("report_step");

    const done = await ctx.api.waitForRun(run.id, "waiting_review");
    expect(done.steps[0]).toMatchObject({ status: "done", exitReason: "reported_done", summary: "Fake plan attempt 1: done" });

    const closed = await waitForClosed(ctx, step.id);
    expect(closed.transcriptPath).toBe(join(ctx.root, `${step.claudeSessionId}.jsonl`));
    expect(closed.endedAt).not.toBeNull();
    await waitFor(async () => (await ctx.api.step(step.id)).events.some((e) => e.type === "hook" && e.payload.hook === "SessionEnd"), "SessionEnd hook");

    expect(readTrace(ctx.root).find((t) => t.type === "started")).toMatchObject({
      agent: "forge-planner",
      prompt: "Read .factory/runs/TASK-001/plan/1/input.md and run the step.",
      settingSources: "project",
      permissionMode: "acceptEdits",
      model: "opus",
    });
    // The Stop hook after the report lets the session stop (no decision body).
    expect(readTrace(ctx.root).find((t) => t.type === "hook" && t.event === "Stop")).toMatchObject({ status: 204 });
  });

  it("blocks a Stop without report and tells the agent to call report_step", async () => {
    const ctx = await setup("stop-then-report");
    const run = await startPlan(ctx);
    await ctx.api.waitForRun(run.id, "waiting_review");
    const trace = readTrace(ctx.root);
    expect(trace.find((t) => t.type === "first_stop")).toMatchObject({ allowed: false });
    const blocked = trace.find((t) => t.type === "hook" && t.event === "Stop");
    const decision = JSON.parse(blocked?.body as string) as { decision: string; reason: string };
    expect(decision.decision).toBe("block");
    expect(decision.reason).toContain("report_step");
  });

  it("stops blocking after the maximum and hands the step and the run to a person", async () => {
    const ctx = await setup("never-report", { maxStopBlocks: 2 });
    const run = await startPlan(ctx);
    const step = await waitForStep(ctx, run.id, "needs_human");
    expect(step.events.filter((e) => e.type === "stop_blocked")).toHaveLength(2);
    expect(step.events.find((e) => e.type === "transition" && e.payload.to === "needs_human")?.payload.cause).toBe("stop_block_limit");
    expect((await ctx.api.run(run.id)).status).toBe("needs_human");
    expect(await ctx.tmux.hasSession(step.tmuxSession)).toBe(true);
  });

  it("moves to needs_human on a permission prompt and back to running once the person answers", async () => {
    const ctx = await setup("permission");
    const run = await startPlan(ctx);
    const waiting = await waitForStep(ctx, run.id, "needs_human");
    expect(waiting.events.find((e) => e.type === "transition" && e.payload.to === "needs_human")?.payload.cause).toBe("permission_prompt");
    expect(waiting.permissionPrompts).toBe(1);
    expect((await ctx.api.run(run.id)).status).toBe("needs_human");

    // The person answers; the next PostToolUse puts the step and the run back to running, before any report.
    writeFileSync(join(ctx.root, "release"), "");
    const resumed = await waitForStep(ctx, run.id, "running");
    expect(resumed.events.find((e) => e.type === "transition" && e.payload.event === "resume_work")?.payload.cause).toBe("PostToolUse");
    expect((await ctx.api.run(run.id)).status).toBe("running");

    writeFileSync(join(ctx.root, "release-2"), "");
    await ctx.api.waitForRun(run.id, "waiting_review");
  });

  it("denies a Bash file write with a corrective reason and counts it, without a prompt", async () => {
    const ctx = await setup("guarded-write");
    const run = await startPlan(ctx);
    const done = await ctx.api.waitForRun(run.id, "waiting_review");
    const guard = readTrace(ctx.root).find((t) => t.type === "guard") as { denied: { hookSpecificOutput: Record<string, string> }; allowed: unknown };
    expect(guard.denied.hookSpecificOutput).toMatchObject({ hookEventName: "PreToolUse", permissionDecision: "deny" });
    expect(guard.denied.hookSpecificOutput.permissionDecisionReason).toContain("Write and Edit tools");
    expect(guard.allowed).toBeNull();
    const step = await ctx.api.step(done.steps[0]?.id ?? "");
    expect(step).toMatchObject({ toolDenials: 1, permissionPrompts: 0 });
    expect(step.events.find((e) => e.type === "tool_denied")?.payload).toMatchObject({ tool: "Bash", rule: "heredoc" });
  });

  it("fails the step when the session ends without a report, and the run needs a person once retries are spent", async () => {
    const ctx = await setup("exit-without-report");
    const run = await startPlan(ctx);
    const done = await ctx.api.waitForRun(run.id, "needs_human");
    expect(done.steps[0]).toMatchObject({ status: "failed", exitReason: "session_ended_without_report:prompt_input_exit" });
    expect(done.exitReason).toBe("attempts_exhausted:plan");
  });

  it("fails the step and kills the session on the wall-clock timeout", async () => {
    const ctx = await setup("hang");
    await writeTimeout(ctx, 0.01);
    const run = await startPlan(ctx);
    const failed = await waitForStep(ctx, run.id, "failed");
    expect(failed.exitReason).toBe("timeout");
    await waitForClosed(ctx, failed.id);
  });

  it("notices a session that vanished without any hook", async () => {
    const ctx = await setup("crash");
    const run = await startPlan(ctx);
    const failed = await waitForStep(ctx, run.id, "failed");
    expect(failed.exitReason).toBe("session_vanished");
    expect(failed.events.find((e) => e.type === "transition" && e.payload.to === "failed")?.payload.exitCode).toBe("3");
  });

  it("requires the local token everywhere except /health", async () => {
    const ctx = await setup("done");
    expect((await ctx.api.request("GET", "/health", undefined, null)).status).toBe(200);
    expect((await ctx.api.request("GET", "/runs", undefined, null)).status).toBe(401);
    expect((await ctx.api.request("POST", "/hooks/stop", { session_id: "x", hook_event_name: "Stop" }, "wrong")).status).toBe(401);
    expect((await ctx.api.request("POST", "/mcp/00000000-0000-4000-8000-000000000000", {}, null)).status).toBe(401);
    expect((await ctx.api.request("POST", "/mcp/00000000-0000-4000-8000-000000000000", {})).status).toBe(404);
  });

  it("refuses to launch an agent whose permission mode would skip the prompts", async () => {
    const ctx = await setup("done");
    const agentFile = join(ctx.project, ".claude", "agents", "forge-planner.md");
    writeFileSync(agentFile, readFileSync(agentFile, "utf8").replace("permissionMode: acceptEdits", "permissionMode: bypassPermissions"));
    execFileSync("git", ["-C", ctx.project, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-qam", "bypass"]);
    const { id } = await ctx.api.startRun(ctx.project);
    const run = await ctx.api.waitForRun(id, "failed");
    expect(run).toMatchObject({ exitReason: "launch_failed:plan" });
    expect(run.steps[0]).toMatchObject({ status: "failed", exitReason: "launch_failed" });
    expect(run.events.some((e) => e.type === "launch_error" && String(e.payload.error).includes("bypassPermissions"))).toBe(true);
    expect(await ctx.tmux.listSessions()).toEqual([]);
  });

  it("keeps the rendered token out of the worktree", async () => {
    const ctx = await setup("done");
    const run = await startPlan(ctx);
    await ctx.api.waitForRun(run.id, "waiting_review");
    const worktree = run.steps[0]?.worktreePath ?? "";
    const files = readdirSync(worktree, { recursive: true, withFileTypes: true })
      .filter((d) => d.isFile() && !d.parentPath.includes("/.git"))
      .map((d) => join(d.parentPath, d.name));
    expect(files.length).toBeGreaterThan(3);
    expect(files.filter((f) => readFileSync(f, "utf8").includes(ctx.backend.token))).toEqual([]);
  });

  it("ignores hooks from unknown sessions", async () => {
    const ctx = await setup("done");
    const res = await ctx.api.request("POST", "/hooks/stop", { session_id: "nobody", hook_event_name: "Stop" });
    expect(res.status).toBe(204);
    expect(existsSync(join(ctx.root, "trace.jsonl"))).toBe(false);
  });
});

/** Rewrites the project's one-step pipeline with a very short timeout and commits it. */
async function writeTimeout(ctx: Ctx, minutes: number): Promise<void> {
  const file = join(ctx.project, ".factory", "pipeline.yaml");
  writeFileSync(file, PLAN_ONLY_PIPELINE.replace("model: opus,", `model: opus, timeout_minutes: ${minutes},`));
  execFileSync("git", ["-C", ctx.project, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-qam", "timeout"]);
  await Promise.resolve();
}
