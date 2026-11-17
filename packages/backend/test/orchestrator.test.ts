import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it } from "vitest";
import { startBackend, type Backend } from "../src/app.js";
import type { ForgeConfig } from "../src/config.js";
import { Tmux } from "../src/runner/tmux.js";
import { Api, disposeTmux, fakeEnv, makeProject, PLAN_ONLY_PIPELINE, scratch, StubMemory, testConfig, waitFor } from "./helpers.js";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup(overrides: Partial<ForgeConfig> = {}) {
  const root = scratch();
  const project = makeProject(root, { pipeline: PLAN_ONLY_PIPELINE });
  const config = testConfig(root, { extraEnv: fakeEnv(root, { plan: ["wait-release"] }), ...overrides });
  const tmux = new Tmux(config.tmuxSocket);
  const backend: Backend = await startBackend(config, { memory: new StubMemory() });
  cleanups.push(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  cleanups.push(() => disposeTmux(tmux, config.tmuxSocket));
  cleanups.push(() => backend.close());
  const api = new Api(backend.url, backend.token);
  const registered = await api.request("POST", "/projects", { path: project });
  const projectId = (registered.body as { id: string }).id;
  return { root, project, config, backend, api, projectId, tmux };
}

/** Plays the orchestrator session: a real MCP client on the orchestrator's `factory` server. */
async function orchestratorClient(url: string, token: string, projectId: string) {
  const client = new Client({ name: "fake-orchestrator", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp/orchestrator/${projectId}`), { requestInit: { headers: { "x-forge-token": token } } }));
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    const raw = result.content[0]?.text ?? "";
    let body: unknown = raw;
    try {
      body = JSON.parse(raw);
    } catch {
      // Plain text answer.
    }
    return { isError: result.isError === true, body };
  };
  return { client, call };
}

describe("orchestrator", () => {
  it("proposes through its tools, launches nothing until a person approves, then the scheduler runs the plan", async () => {
    const ctx = await setup({ maxConcurrency: 2 });
    const { client, call } = await orchestratorClient(ctx.backend.url, ctx.backend.token, ctx.projectId);
    cleanups.push(() => client.close());

    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name).sort()).toEqual(["cancel", "get_status", "launch_pipeline", "list_backlog", "propose_plan"]);

    const backlog = await call("list_backlog");
    expect(backlog.body).toEqual([
      expect.objectContaining({ id: "TASK-001", dependsOn: [], status: "not_started" }),
      expect.objectContaining({ id: "TASK-002", dependsOn: ["TASK-001"], status: "not_started" }),
    ]);

    const wrong = await call("propose_plan", { rationale: "all at once", waves: [{ tasks: [{ id: "TASK-001", modules: ["src"] }, { id: "TASK-002", modules: ["public"] }] }] });
    expect(wrong).toEqual({ isError: true, body: { accepted: false, issues: ["TASK-002 depends on TASK-001, which must be merged or in an earlier wave"] } });

    const proposed = await call("propose_plan", {
      rationale: "TASK-002 needs the todo API from TASK-001",
      waves: [{ tasks: [{ id: "TASK-001", modules: ["src/server"] }] }, { tasks: [{ id: "TASK-002", modules: ["public"] }] }],
    });
    expect(proposed.isError).toBe(false);
    const planId = (proposed.body as { planId: string }).planId;

    const early = await call("launch_pipeline", { plan_id: planId });
    expect(early).toEqual({ isError: true, body: `Plan ${planId} is waiting for the person to approve it in the panel. Nothing was launched.` });
    await ctx.backend.scheduler.tick();
    expect(await ctx.api.runs()).toEqual([]);

    const plans = (await ctx.api.request("GET", `/projects/${ctx.projectId}/plans`)).body as { id: string; status: string; tasks: { taskId: string; title: string; wave: number; state: string }[] }[];
    expect(plans[0]).toMatchObject({ id: planId, status: "proposed", tasks: [{ taskId: "TASK-001", title: "Add and list todos", wave: 0, state: "planned" }, { taskId: "TASK-002", wave: 1, state: "planned" }] });

    const approved = await ctx.api.request("POST", `/plans/${planId}/approve`);
    expect(approved.status).toBe(200);
    expect((await ctx.api.request("POST", `/plans/${planId}/approve`)).status).toBe(409);
    await waitFor(async () => (await ctx.api.runs()).find((r) => r.taskId === "TASK-001" && r.status === "running"), "TASK-001 to run");

    const status = await call("get_status");
    const queue = (status.body as { queue: { active: { taskId: string }[]; queued: { taskId: string; waitReason: string | null }[] } }).queue;
    expect(queue.active.map((a) => a.taskId)).toEqual(["TASK-001"]);
    expect(queue.queued).toEqual([expect.objectContaining({ taskId: "TASK-002", waitReason: "Waits for TASK-001 merge" })]);
    expect((await call("launch_pipeline", { plan_id: planId })).isError).toBe(false);

    expect(await call("cancel", { task_id: "TASK-002", reason: "The person wants it later" })).toEqual({ isError: false, body: "TASK-002 left the queue." });
    const after = (await ctx.api.request("GET", "/queue")).body as { queued: unknown[]; maxConcurrency: number };
    expect(after).toMatchObject({ queued: [], maxConcurrency: 2 });
  });

  it("refuses to approve a rejected plan and never lets another project's orchestrator see this one", async () => {
    const ctx = await setup();
    const { client, call } = await orchestratorClient(ctx.backend.url, ctx.backend.token, ctx.projectId);
    cleanups.push(() => client.close());
    const proposed = await call("propose_plan", { rationale: "one", waves: [{ tasks: [{ id: "TASK-001", modules: ["src"] }] }] });
    const planId = (proposed.body as { planId: string }).planId;
    expect((await ctx.api.request("POST", `/plans/${planId}/reject`)).status).toBe(200);
    expect((await ctx.api.request("POST", `/plans/${planId}/approve`)).body).toMatchObject({ message: "The plan is rejected" });

    const other = makeProject(join(ctx.root, "other"));
    const otherId = ((await ctx.api.request("POST", "/projects", { path: other })).body as { id: string }).id;
    const { client: otherClient, call: otherCall } = await orchestratorClient(ctx.backend.url, ctx.backend.token, otherId);
    cleanups.push(() => otherClient.close());
    expect(await otherCall("launch_pipeline", { plan_id: planId })).toEqual({ isError: true, body: `Unknown plan ${planId} for this project.` });
  });

  it("starts the orchestrator session in the project checkout without Bash or write tools", async () => {
    const root = scratch();
    // A stand-in for claude that records how it was started and stays alive like a session.
    const recorder = join(root, "claude-recorder.mjs");
    writeFileSync(recorder, `#!/usr/bin/env node\nimport { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(join(root, "argv.json"))}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }));\nsetInterval(() => {}, 60000);\n`);
    chmodSync(recorder, 0o755);
    const ctx = await setup({ claudeBin: recorder });
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));

    const started = await ctx.api.request("POST", `/projects/${ctx.projectId}/orchestrator`, { prompt: "Plan TASK-001 only" });
    expect(started.status).toBe(200);
    const recorded = await waitFor(() => (existsSync(join(root, "argv.json")) ? (JSON.parse(readFileSync(join(root, "argv.json"), "utf8")) as { argv: string[]; cwd: string }) : undefined), "the orchestrator to start");
    expect(recorded.cwd).toBe(ctx.project);
    const argv = recorded.argv;
    expect(argv[0]).toBe("Plan TASK-001 only");
    expect(argv.slice(argv.indexOf("--agent"), argv.indexOf("--agent") + 2)).toEqual(["--agent", "forge-orchestrator"]);
    expect(argv.slice(argv.indexOf("--permission-mode"), argv.indexOf("--permission-mode") + 2)).toEqual(["--permission-mode", "default"]);
    expect(argv.slice(argv.indexOf("--disallowedTools") + 1)).toEqual(["Bash", "Write", "Edit", "MultiEdit", "NotebookEdit", "WebFetch", "WebSearch", "Agent", "Task"]);
    const settings = readFileSync(argv[argv.indexOf("--settings") + 1]!, "utf8");
    expect(settings).not.toContain("{{");
    expect((JSON.parse(settings) as { permissions: { deny: string[] } }).permissions.deny).toContain(`Read(/${ctx.config.home}/**)`);
    const mcp = JSON.parse(readFileSync(argv[argv.indexOf("--mcp-config") + 1]!, "utf8")) as { mcpServers: { factory: { url: string } } };
    expect(mcp.mcpServers.factory.url).toBe(`${ctx.backend.url}/mcp/orchestrator/${ctx.projectId}`);

    const status = (await ctx.api.request("GET", `/projects/${ctx.projectId}/orchestrator`)).body as { session: { tmuxSession: string } | null };
    expect(status.session?.tmuxSession).toMatch(/^forge-orch-/);
    // Starting again reuses the live session.
    expect(((await ctx.api.request("POST", `/projects/${ctx.projectId}/orchestrator`, {})).body as { session: { startedAt: number } }).session).toEqual(status.session);
    expect((await ctx.api.request("DELETE", `/projects/${ctx.projectId}/orchestrator`)).body).toEqual({ stopped: true });
    expect(((await ctx.api.request("GET", `/projects/${ctx.projectId}/orchestrator`)).body as { session: null }).session).toBeNull();
    expect(await ctx.tmux.hasSession(status.session!.tmuxSession)).toBe(false);
  });
});
