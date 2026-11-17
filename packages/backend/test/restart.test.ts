import { spawn, type ChildProcess } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readToken } from "../src/auth.js";
import { Tmux } from "../src/runner/tmux.js";
import { Api, FAKE_CLAUDE, disposeTmux, type RunDetail, REPO_ROOT, fakeEnv, makeProject, scratch, waitFor } from "./helpers.js";

// `node --import tsx` keeps the backend in one process, so SIGKILL really kills it
// (the tsx CLI would spawn a child that survives its parent).
const NODE_ARGS = ["--import", "tsx"];
const CLI = join(REPO_ROOT, "packages", "backend", "src", "cli.ts");

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => (typeof address === "object" && address ? resolve(address.port) : reject(new Error("no port"))));
    });
  });
}

interface Env {
  root: string;
  project: string;
  env: NodeJS.ProcessEnv;
  tmux: Tmux;
  url: string;
}

async function prepare(script: Record<string, string[]>): Promise<Env> {
  const root = scratch();
  const project = makeProject(root);
  const port = await freePort();
  const socket = `forge-test-restart-${port}`;
  const env = {
    ...process.env,
    FORGE_HOME: join(root, "home"),
    FORGE_PORT: String(port),
    FORGE_TMUX_SOCKET: socket,
    FORGE_CLAUDE_BIN: FAKE_CLAUDE,
    FORGE_CLOSE_GRACE_MS: "100",
    FORGE_SWEEP_INTERVAL_MS: "200",
    FORGE_CHECK_TRUST: "0",
    FORGE_ENGRAM_URL: "http://127.0.0.1:9",
    // The tmux server inherits the backend's environment, so the fake sees these.
    ...fakeEnv(root, script),
  };
  const tmux = new Tmux(socket);
  cleanups.push(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  cleanups.push(() => disposeTmux(tmux, socket));
  return { root, project, env, tmux, url: `http://127.0.0.1:${port}` };
}

async function serve(e: Env): Promise<{ child: ChildProcess; api: Api }> {
  const child = spawn(process.execPath, [...NODE_ARGS, CLI, "serve"], { cwd: REPO_ROOT, env: e.env, stdio: "ignore" });
  cleanups.push(() => {
    child.kill("SIGKILL");
  });
  await waitFor(async () => {
    try {
      return (await fetch(`${e.url}/health`)).ok || undefined;
    } catch {
      return undefined;
    }
  }, "backend to listen");
  return { child, api: new Api(e.url, readToken(e.env.FORGE_HOME ?? "")) };
}

async function killHard(child: ChildProcess): Promise<void> {
  const exited = new Promise((r) => child.once("exit", r));
  child.kill("SIGKILL");
  await exited;
}

const liveStep = (run: RunDetail) => run.steps.find((s) => ["queued", "running", "needs_human"].includes(s.status));

describe("backend restart", () => {
  it("kill -9 in the middle of the pipeline, restart and resume: same step, no duplicates", async () => {
    const e = await prepare({ development: ["wait-release"] });
    const first = await serve(e);
    const { id } = await first.api.startRun(e.project);
    const before = await waitFor(async () => {
      const run = await first.api.run(id);
      const step = liveStep(run);
      return step?.kind === "development" && step.status === "running" && (await e.tmux.hasSession(step.tmuxSession)) ? run : undefined;
    }, "development to run");
    const dev = liveStep(before);

    await killHard(first.child);
    expect(await e.tmux.hasSession(dev?.tmuxSession ?? "")).toBe(true);

    const second = await serve(e);
    const resumed = await second.api.request("POST", `/runs/${id}/resume`, {});
    expect(resumed.status).toBe(200);
    expect((resumed.body as { message: string }).message).toContain("Step development is still live");
    const after = await second.api.run(id);
    expect(after.status).toBe("running");
    expect(liveStep(after)?.id).toBe(dev?.id);
    expect((await second.api.request("POST", "/runs", { projectPath: e.project, taskId: "TASK-001" })).status).toBe(409);

    writeFileSync(join(e.root, "release"), "");
    const done = await second.api.waitForRun(id, "waiting_review");
    expect(done.steps.map((s) => `${s.kind}#${s.attempt}`)).toEqual(["plan#1", "design#1", "development#1", "security#1", "e2e#1", "pr#1"]);
    expect(await second.api.runs()).toHaveLength(1);
  });

  it("relaunches the current step when its session died while the backend was down", async () => {
    const e = await prepare({ development: ["hang", "done"] });
    const first = await serve(e);
    const { id } = await first.api.startRun(e.project);
    const dev = await waitFor(async () => {
      const step = liveStep(await first.api.run(id));
      return step?.kind === "development" && step.status === "running" && (await e.tmux.hasSession(step.tmuxSession)) ? step : undefined;
    }, "development to run");
    await killHard(first.child);
    await e.tmux.killSession(dev.tmuxSession);

    const second = await serve(e);
    const done = await second.api.waitForRun(id, "waiting_review");
    expect(done.steps.filter((s) => s.kind === "development").map((s) => `${s.status}:${s.exitReason}`)).toEqual([
      "failed:orphaned_session_missing",
      "done:reported_done",
    ]);
    expect(done.attempts).toEqual({ development: 1 });
  });

  it("runs a task end to end with `forge run-task` and exits 0 in waiting_review", async () => {
    const e = await prepare({});
    await serve(e);
    const run = spawn(process.execPath, [...NODE_ARGS, CLI, "run-task", "--project", e.project, "--task", "TASK-001"], { cwd: REPO_ROOT, env: e.env });
    let output = "";
    run.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
    const code = await new Promise<number | null>((r) => run.once("exit", r));
    expect(code).toBe(0);
    expect(output).toContain("step pr#1 done (reported_done)");
    expect(output).toContain("run waiting_review (completed)");
    expect(output).toContain("Pull request: https://github.com/example/demo-project/pull/7");

    const status = spawn(process.execPath, [...NODE_ARGS, CLI, "status", /Run (\S+)/.exec(output)?.[1] ?? ""], { cwd: REPO_ROOT, env: e.env });
    let statusOut = "";
    status.stdout.on("data", (chunk: Buffer) => (statusOut += chunk.toString()));
    await new Promise((r) => status.once("exit", r));
    expect(statusOut).toContain("waiting_review");
    expect(statusOut).toContain("security#1 done");
    expect(statusOut).toContain("Engram unavailable");
    expect(statusOut).toContain("Total: 6 sessions, 0 permission prompts, 0 tool calls denied by the guard");
  });
});
