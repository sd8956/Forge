import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { startBackend, type Backend } from "../src/app.js";
import type { ForgeConfig } from "../src/config.js";
import { Tmux } from "../src/runner/tmux.js";
import { Api, disposeTmux, fakeEnv, makeProject, PLAN_ONLY_PIPELINE, removeScratch, scratch, StubMemory, testConfig, waitFor } from "./helpers.js";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup(overrides: Partial<ForgeConfig> = {}, script: Record<string, string[]> = { plan: ["wait-release"] }) {
  const root = scratch();
  const project = makeProject(root, { pipeline: PLAN_ONLY_PIPELINE });
  const config = testConfig(root, { extraEnv: fakeEnv(root, script), ...overrides });
  const tmux = new Tmux(config.tmuxSocket);
  const backend: Backend = await startBackend(config, { memory: new StubMemory() });
  cleanups.push(() => removeScratch(root));
  cleanups.push(() => disposeTmux(tmux, config.tmuxSocket));
  cleanups.push(() => backend.close());
  const api = new Api(backend.url, backend.token);
  const { id } = (await api.request("POST", "/projects", { path: project })).body as { id: string };
  return { root, project, config, backend, api, id, tmux };
}

async function consoleTools(url: string, token: string, projectId: string) {
  const client = new Client({ name: "fake-console", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp/console/${projectId}`), { requestInit: { headers: { "x-forge-token": token } } }));
  cleanups.push(() => client.close());
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    const raw = result.content[0]?.text ?? "";
    let body: unknown = raw;
    try {
      body = JSON.parse(raw);
    } catch {
      // plain text
    }
    return { isError: result.isError === true, body };
  };
  return { client, call };
}

describe("project console", () => {
  it("sizes the session to the panel from the first message, sent before the route has found the session", async () => {
    const ctx = await setup();
    expect((await ctx.api.request("POST", `/projects/${ctx.id}/console`, {})).status).toBe(200);
    const cookie = ((await fetch(ctx.backend.loginLink(), { redirect: "manual" })).headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    const socket = new WebSocket(`${ctx.backend.url.replace("http", "ws")}/ws/console/${ctx.id}`, { headers: { cookie, origin: ctx.backend.url } });
    cleanups.push(() => socket.terminate());
    socket.on("error", () => undefined);
    // The panel sends its size as soon as the socket opens, like Terminal.tsx does.
    socket.once("open", () => socket.send(JSON.stringify({ type: "resize", cols: 90, rows: 20 })));
    const size = () => execFileSync("tmux", ["-L", ctx.config.tmuxSocket, "list-clients", "-F", "#{client_width}x#{client_height}"], { encoding: "utf8" }).trim();
    await waitFor(() => size() === "90x20", "the tmux client to take the panel's size", 5_000).catch(() => undefined);
    expect(size()).toBe("90x20");
  });

  it("starts the person's own Claude Code in the project with Forge's tools, asking before every action", async () => {
    const root = scratch();
    cleanups.push(() => removeScratch(root));
    const recorder = join(root, "claude-recorder.mjs");
    writeFileSync(recorder, `#!/usr/bin/env node\nimport { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(join(root, "argv.json"))}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }));\nsetInterval(() => {}, 60000);\n`);
    chmodSync(recorder, 0o755);
    const ctx = await setup({ claudeBin: recorder });

    expect(((await ctx.api.request("GET", `/projects/${ctx.id}/console`)).body as { session: unknown }).session).toBeNull();
    expect((await ctx.api.request("POST", `/projects/${ctx.id}/console`, {})).status).toBe(200);
    const recorded = await waitFor(() => (existsSync(join(root, "argv.json")) ? (JSON.parse(readFileSync(join(root, "argv.json"), "utf8")) as { argv: string[]; cwd: string }) : undefined), "the console to start");
    const argv = recorded.argv;
    expect(recorded.cwd).toBe(ctx.project);
    expect(argv).not.toContain("--agent");
    // The person's own settings apply (no --setting-sources), and every command or edit asks them.
    expect(argv).not.toContain("--setting-sources");
    expect(argv.slice(argv.indexOf("--permission-mode"), argv.indexOf("--permission-mode") + 2)).toEqual(["--permission-mode", "default"]);
    const settings = JSON.parse(readFileSync(argv[argv.indexOf("--settings") + 1]!, "utf8")) as { permissions: Record<string, unknown> };
    expect(settings.permissions.disableBypassPermissionsMode).toBe("disable");
    const mcp = JSON.parse(readFileSync(argv[argv.indexOf("--mcp-config") + 1]!, "utf8")) as { mcpServers: { factory: { url: string } } };
    expect(mcp.mcpServers.factory.url).toBe(`${ctx.backend.url}/mcp/console/${ctx.id}`);
    const prompt = argv[argv.indexOf("--append-system-prompt") + 1]!;
    expect(prompt).toContain("active_steps");
    expect(prompt).toContain("never by hand");

    const status = (await ctx.api.request("GET", `/projects/${ctx.id}/console`)).body as { session: { tmuxSession: string } };
    expect(status.session.tmuxSession).toMatch(/^forge-console-/);
    expect((await ctx.api.request("DELETE", `/projects/${ctx.id}/console`)).body).toEqual({ stopped: true });
    expect(await ctx.tmux.hasSession(status.session.tmuxSession)).toBe(false);
  });

  it("answers about runs and steps, and resumes, cancels, starts and pauses through Forge", async () => {
    const ctx = await setup();
    const { call } = await consoleTools(ctx.backend.url, ctx.backend.token, ctx.id);
    const run = await ctx.api.startRun(ctx.project);
    await waitFor(async () => (await ctx.api.run(run.id)).steps[0]?.status === "running", "the plan step to run");

    const runs = await call("list_runs");
    expect(runs.body).toEqual([expect.objectContaining({ taskId: "TASK-001", status: "running", currentStep: "plan", runId: run.id })]);
    const live = await call("active_steps");
    expect(live.body).toEqual([expect.objectContaining({ taskId: "TASK-001", step: "plan", worktree: join(ctx.project, ".worktrees", "TASK-001") })]);
    const detail = (await call("get_run", { task_id: "TASK-001" })).body as { steps: { kind: string; status: string; output: string }[]; events: unknown[] };
    expect(detail.steps).toEqual([expect.objectContaining({ kind: "plan", status: "running", output: ".factory/runs/TASK-001/plan/1/output.md" })]);
    expect(detail.events.length).toBeGreaterThan(0);

    expect((await call("resume_run", { task_id: "TASK-001" })).body).toContain("nothing to relaunch");
    expect((await call("pause_queue", { reason: "Fixing TASK-001 by hand" })).isError).toBe(false);
    expect(((await ctx.api.request("GET", "/queue")).body as { paused: { reason: string } }).paused.reason).toBe("Fixing TASK-001 by hand");
    expect((await call("resume_queue")).isError).toBe(false);
    expect((await call("cancel_run", { task_id: "TASK-001" })).body).toBe("Run cancelled.");
    expect((await call("cancel_run", { task_id: "TASK-001" })).isError).toBe(true);
    // TASK-002 depends on TASK-001, which is not merged: start_task says why instead of starting it.
    const refused = await call("start_task", { task_id: "TASK-002" });
    expect(refused).toMatchObject({ isError: true, body: expect.stringContaining("depends on TASK-001") as string });
    expect((await call("get_run", { task_id: "TASK-009" })).isError).toBe(true);
  }, 60_000);
});
