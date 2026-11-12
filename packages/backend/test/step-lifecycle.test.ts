import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startBackend, type Backend } from "../src/app.js";
import { Tmux } from "../src/runner/tmux.js";
import { Api, disposeTmux, fakeEnv, makeProject, readTrace, scratch, testConfig, waitFor } from "./helpers.js";

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

async function setup(scenario: string, overrides: Parameters<typeof testConfig>[1] = {}): Promise<Ctx> {
  const root = scratch();
  const project = makeProject(root);
  const config = testConfig(root, { extraEnv: fakeEnv(root, scenario), ...overrides });
  const tmux = new Tmux(config.tmuxSocket);
  const backend = await startBackend(config);
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  cleanups.push(() => disposeTmux(tmux, config.tmuxSocket));
  cleanups.push(() => backend.close());
  return { root, project, backend, api: new Api(backend.url, backend.token), tmux };
}

async function waitForStatus(ctx: Ctx, id: string, status: string) {
  return waitFor(async () => {
    const step = await ctx.api.step(id);
    return step.status === status ? step : undefined;
  }, `step ${id} to be ${status}`);
}

async function waitForClosed(ctx: Ctx, id: string) {
  return waitFor(async () => {
    const step = await ctx.api.step(id);
    return step.events.some((e) => e.type === "session_closed") && !(await ctx.tmux.hasSession(step.tmuxSession)) ? step : undefined;
  }, `step ${id} to close`);
}

describe("step lifecycle with a fake claude in tmux", () => {
  it("prepares the worktree and input, launches the agent and finishes only through report_step", async () => {
    const ctx = await setup("report");
    const started = await ctx.api.startStep(ctx.project);

    expect(started.status).toBe("running");
    expect(started.worktreePath).toBe(join(ctx.project, ".worktrees", "TASK-001"));
    expect(execFileSync("git", ["-C", started.worktreePath, "branch", "--show-current"], { encoding: "utf8" }).trim()).toBe("feat/TASK-001");
    const input = readFileSync(started.inputPath, "utf8");
    expect(input).toContain(".factory/backlog/TASK-001.md");
    expect(input).toContain("report_step");

    const done = await waitForStatus(ctx, started.id, "done");
    expect(done.exitReason).toBe("reported_done");
    expect(done.summary).toBe("Fake planner finished.");

    const closed = await waitForClosed(ctx, started.id);
    expect(closed.transcriptPath).toBe(join(ctx.root, `${started.claudeSessionId}.jsonl`));
    expect(closed.endedAt).not.toBeNull();
    await waitFor(async () => (await ctx.api.step(started.id)).events.some((e) => e.type === "hook" && e.payload.hook === "SessionEnd"), "SessionEnd hook");

    const trace = readTrace(ctx.root);
    expect(trace.find((t) => t.type === "started")).toMatchObject({
      agent: "forge-planner",
      prompt: "Read .factory/runs/TASK-001/plan/input.md and run the step.",
      settingSources: "project",
      permissionMode: "acceptEdits",
    });
    expect(trace.find((t) => t.type === "tools")).toMatchObject({ names: ["report_step"] });
    // The Stop hook after the report lets the session stop (no decision body).
    expect(trace.find((t) => t.type === "hook" && t.event === "Stop")).toMatchObject({ status: 204 });
  });

  it("blocks a Stop without report and tells the agent to call report_step", async () => {
    const ctx = await setup("stop-then-report");
    const started = await ctx.api.startStep(ctx.project);
    await waitForStatus(ctx, started.id, "done");

    const trace = readTrace(ctx.root);
    expect(trace.find((t) => t.type === "first_stop")).toMatchObject({ allowed: false });
    const blocked = trace.find((t) => t.type === "hook" && t.event === "Stop");
    const decision = JSON.parse(blocked?.body as string) as { decision: string; reason: string };
    expect(decision.decision).toBe("block");
    expect(decision.reason).toContain("report_step");
  });

  it("stops blocking after the maximum and hands the step to a person", async () => {
    const ctx = await setup("never-report", { maxStopBlocks: 2 });
    const started = await ctx.api.startStep(ctx.project);
    const step = await waitForStatus(ctx, started.id, "needs_human");

    expect(step.events.filter((e) => e.type === "stop_blocked")).toHaveLength(2);
    expect(step.events.find((e) => e.type === "transition" && e.payload.to === "needs_human")?.payload.cause).toBe("stop_block_limit");
    expect(await ctx.tmux.hasSession(step.tmuxSession)).toBe(true);
  });

  it("moves to needs_human on a permission prompt and finishes after the person answers", async () => {
    const ctx = await setup("permission");
    const started = await ctx.api.startStep(ctx.project);
    const waiting = await waitForStatus(ctx, started.id, "needs_human");
    expect(waiting.events.find((e) => e.type === "transition" && e.payload.to === "needs_human")?.payload.cause).toBe("permission_prompt");

    writeFileSync(join(ctx.root, "release"), "");
    await waitForStatus(ctx, started.id, "done");
  });

  it("fails the step when the session ends without a report", async () => {
    const ctx = await setup("exit-without-report");
    const started = await ctx.api.startStep(ctx.project);
    const failed = await waitForStatus(ctx, started.id, "failed");
    expect(failed.exitReason).toBe("session_ended_without_report:prompt_input_exit");
  });

  it("fails the step and kills the session on the wall-clock timeout", async () => {
    const ctx = await setup("hang");
    const started = await ctx.api.startStep(ctx.project, { timeoutMinutes: 0.01 });
    const failed = await waitForStatus(ctx, started.id, "failed");
    expect(failed.exitReason).toBe("timeout");
    await waitForClosed(ctx, started.id);
  });

  it("notices a session that vanished without any hook", async () => {
    const ctx = await setup("crash");
    const started = await ctx.api.startStep(ctx.project);
    const failed = await waitForStatus(ctx, started.id, "failed");
    expect(failed.exitReason).toBe("session_vanished");
    expect(failed.events.at(-1)?.payload.exitCode).toBe("3");
  });

  it("refuses a second live step for the same task", async () => {
    const ctx = await setup("hang");
    await ctx.api.startStep(ctx.project);
    const second = await ctx.api.request("POST", "/steps", { projectPath: ctx.project, taskId: "TASK-001", step: "plan" });
    expect(second.status).toBe(409);
    expect(await ctx.api.steps()).toHaveLength(1);
  });

  it("rejects bad requests before touching tmux", async () => {
    const ctx = await setup("report");
    expect((await ctx.api.request("POST", "/steps", { projectPath: ctx.project, taskId: "TASK-999", step: "plan" })).status).toBe(400);
    expect((await ctx.api.request("POST", "/steps", { projectPath: ctx.project, taskId: "TASK-001", step: "deploy" })).status).toBe(400);
    expect((await ctx.api.request("POST", "/steps", { projectPath: ctx.project, taskId: "../etc", step: "plan" })).status).toBe(400);
    expect(await ctx.tmux.listSessions()).toEqual([]);
  });

  it("refuses to launch an agent whose permission mode would skip the prompts", async () => {
    const ctx = await setup("report");
    const agentFile = join(ctx.project, ".claude", "agents", "forge-planner.md");
    writeFileSync(agentFile, readFileSync(agentFile, "utf8").replace("permissionMode: acceptEdits", "permissionMode: bypassPermissions"));
    execFileSync("git", ["-C", ctx.project, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-qam", "bypass"]);
    const res = await ctx.api.request("POST", "/steps", { projectPath: ctx.project, taskId: "TASK-001", step: "plan" });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain("bypassPermissions");
    const [step] = await ctx.api.steps();
    expect(step).toMatchObject({ status: "failed", exitReason: "launch_failed" });
    expect(await ctx.tmux.listSessions()).toEqual([]);
  });

  it("requires the local token everywhere except /health", async () => {
    const ctx = await setup("report");
    expect((await ctx.api.request("GET", "/health", undefined, null)).status).toBe(200);
    expect((await ctx.api.request("GET", "/steps", undefined, null)).status).toBe(401);
    expect((await ctx.api.request("POST", "/hooks/stop", { session_id: "x", hook_event_name: "Stop" }, "wrong")).status).toBe(401);
    expect((await ctx.api.request("POST", "/mcp/00000000-0000-4000-8000-000000000000", {}, null)).status).toBe(401);
    expect((await ctx.api.request("POST", "/mcp/00000000-0000-4000-8000-000000000000", {})).status).toBe(404);
  });

  it("keeps the rendered token out of the worktree", async () => {
    const ctx = await setup("report");
    const started = await ctx.api.startStep(ctx.project);
    await waitForStatus(ctx, started.id, "done");
    const files = readdirSync(started.worktreePath, { recursive: true, withFileTypes: true })
      .filter((d) => d.isFile() && !d.parentPath.includes("/.git"))
      .map((d) => join(d.parentPath, d.name));
    expect(files.length).toBeGreaterThan(3);
    expect(files.filter((f) => readFileSync(f, "utf8").includes(ctx.backend.token))).toEqual([]);
  });

  it("does not leave hook endpoints open to unknown sessions", async () => {
    const ctx = await setup("report");
    const res = await ctx.api.request("POST", "/hooks/stop", { session_id: "nobody", hook_event_name: "Stop" });
    expect(res.status).toBe(204);
    expect(existsSync(join(ctx.root, "trace.jsonl"))).toBe(false);
  });
});
