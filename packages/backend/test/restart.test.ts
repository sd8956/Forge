import { spawn, type ChildProcess } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readToken } from "../src/auth.js";
import { Tmux } from "../src/runner/tmux.js";
import { Api, FAKE_CLAUDE, disposeTmux, REPO_ROOT, fakeEnv, makeProject, scratch, waitFor } from "./helpers.js";

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

async function prepare(scenario: string): Promise<Env> {
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
    // The tmux server inherits the backend's environment, so the fake sees these.
    ...fakeEnv(root, scenario),
  };
  const tmux = new Tmux(socket);
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
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

describe("backend restart", () => {
  it("resumes a running step after kill -9 without losing or duplicating it", async () => {
    const e = await prepare("wait-release");
    const first = await serve(e);
    const step = await first.api.startStep(e.project);
    expect(step.status).toBe("running");

    await killHard(first.child);
    expect(await e.tmux.hasSession(step.tmuxSession)).toBe(true);

    const second = await serve(e);
    const resumed = await second.api.step(step.id);
    expect(resumed.status).toBe("running");
    expect(resumed.events.some((ev) => ev.type === "resumed_after_restart")).toBe(true);
    expect((await second.api.request("POST", "/steps", { projectPath: e.project, taskId: "TASK-001", step: "plan" })).status).toBe(409);

    writeFileSync(join(e.root, "release"), "");
    const done = await waitFor(async () => {
      const s = await second.api.step(step.id);
      return s.status === "done" && s.endedAt !== null ? s : undefined;
    }, "step to finish after restart");
    expect(done.exitReason).toBe("reported_done");
    expect(await second.api.steps()).toHaveLength(1);
    await waitFor(async () => !(await e.tmux.hasSession(step.tmuxSession)) || undefined, "session to close");
  });

  it("marks a step as orphaned when its session died while the backend was down", async () => {
    const e = await prepare("hang");
    const first = await serve(e);
    const step = await first.api.startStep(e.project);
    await killHard(first.child);
    await e.tmux.killSession(step.tmuxSession);

    const second = await serve(e);
    const orphaned = await second.api.step(step.id);
    expect(orphaned.status).toBe("failed");
    expect(orphaned.exitReason).toBe("orphaned_session_missing");
    expect(await second.api.steps()).toHaveLength(1);
  });

  it("runs a step end to end with `forge run-step` and exits 0 on done", async () => {
    const e = await prepare("report");
    await serve(e);
    const run = spawn(process.execPath, [...NODE_ARGS, CLI, "run-step", "--project", e.project, "--task", "TASK-001", "--step", "plan"], { cwd: REPO_ROOT, env: e.env });
    let output = "";
    run.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
    const code = await new Promise<number | null>((r) => run.once("exit", r));
    expect(code).toBe(0);
    expect(output).toContain("done (reported_done)");
    expect(output).toContain("Transcript: ");
  });
});
