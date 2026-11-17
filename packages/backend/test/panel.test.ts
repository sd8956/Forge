import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startBackend, type Backend } from "../src/app.js";
import { Tmux } from "../src/runner/tmux.js";
import { Api, disposeTmux, fakeEnv, makeProject, PLAN_ONLY_PIPELINE, scratch, StubMemory, testConfig } from "./helpers.js";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup() {
  const root = scratch();
  const project = makeProject(root, { pipeline: PLAN_ONLY_PIPELINE });
  const config = testConfig(root, { extraEnv: fakeEnv(root, { plan: ["done"] }) });
  const tmux = new Tmux(config.tmuxSocket);
  const backend: Backend = await startBackend(config, { memory: new StubMemory() });
  cleanups.push(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  cleanups.push(() => disposeTmux(tmux, config.tmuxSocket));
  cleanups.push(() => backend.close());
  return { root, project, backend, api: new Api(backend.url, backend.token) };
}

async function raw(url: string, init: RequestInit & { headers?: Record<string, string> } = {}) {
  const res = await fetch(url, { redirect: "manual", ...init });
  return { status: res.status, headers: res.headers, text: await res.text() };
}

async function login(backend: Backend): Promise<string> {
  const res = await raw(backend.loginLink());
  expect(res.status).toBe(302);
  const cookie = res.headers.get("set-cookie") ?? "";
  expect(cookie).toMatch(/^forge_session=[^;]+; HttpOnly; SameSite=Strict; Path=\//);
  return cookie.split(";")[0] ?? "";
}

describe("panel access", () => {
  it("logs in once with a one-time link and then uses the session cookie", async () => {
    const { backend } = await setup();
    const link = backend.loginLink();
    const first = await raw(link);
    expect(first.status).toBe(302);
    expect((await raw(link)).status).toBe(401);

    const cookie = (first.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    expect((await raw(`${backend.url}/runs`, { headers: { cookie } })).status).toBe(200);
    expect((await raw(`${backend.url}/runs`)).status).toBe(401);
    expect((await raw(`${backend.url}/runs`, { headers: { cookie: "forge_session=forged.value" } })).status).toBe(401);
  });

  it("refuses cookie writes from another origin, and any request to a foreign Host", async () => {
    const { backend, project } = await setup();
    const cookie = await login(backend);
    const body = JSON.stringify({ path: project });
    const post = (origin?: string) =>
      raw(`${backend.url}/projects`, { method: "POST", body, headers: { cookie, "content-type": "application/json", ...(origin ? { origin } : {}) } });
    expect((await post("https://evil.example")).status).toBe(403);
    expect((await post()).status).toBe(403);
    expect((await post(backend.url)).status).toBe(201);
    // The CLI and hooks use the token header and need no Origin.
    expect((await raw(`${backend.url}/projects`, { method: "POST", body, headers: { "x-forge-token": backend.token, "content-type": "application/json" } })).status).toBe(201);

    const port = new URL(backend.url).port;
    const rebinding = await new Promise<number>((resolve) => {
      // fetch does not allow overriding Host, so use a raw HTTP request.
      void import("node:http").then(({ request }) => {
        const req = request({ host: "127.0.0.1", port, path: "/health", headers: { host: `evil.example:${port}` } }, (res) => resolve(res.statusCode ?? 0));
        req.end();
      });
    });
    expect(rebinding).toBe(403);
  });

  it("registers projects and lists their backlog with the latest run per task", async () => {
    const { api, project } = await setup();
    const created = await api.request("POST", "/projects", { path: project });
    expect(created).toMatchObject({ status: 201, body: { name: "demo-project", repoPath: project, defaultBranch: "main" } });
    const { id } = created.body as { id: string };
    const run = await api.startRun(project);
    const backlog = (await api.request("GET", `/projects/${id}/backlog`)).body as { id: string; latestRun: unknown }[];
    expect(backlog.map((t) => t.id)).toEqual(["TASK-001", "TASK-002"]);
    expect(backlog[0]?.latestRun).toMatchObject({ id: run.id });
    expect(backlog[1]?.latestRun).toBeNull();
    expect((await api.request("POST", "/projects", { path: join(project, "nope") })).status).toBe(400);
  });

  it("serves run files only from the task's handoff directory", async () => {
    const { api, backend, project, root } = await setup();
    const run = await api.waitForRun((await api.startRun(project)).id, "waiting_review");
    const file = (path: string) => raw(`${backend.url}/runs/${run.id}/files?path=${encodeURIComponent(path)}`, { headers: { "x-forge-token": backend.token } });
    const ok = await file("plan/1/output.md");
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toContain("text/markdown");
    expect(ok.headers.get("x-content-type-options")).toBe("nosniff");
    expect(ok.text).toContain("step: plan");
    for (const path of ["../../../.git/config", "/etc/passwd", "plan", "plan/1/missing.md"]) {
      expect((await file(path)).status, path).toBe(404);
    }
    const handoff = join(project, ".worktrees", "TASK-001", ".factory", "runs", "TASK-001");
    writeFileSync(join(root, "secret.txt"), "secret");
    mkdirSync(join(handoff, "evil"));
    symlinkSync(join(root, "secret.txt"), join(handoff, "evil", "link.txt"));
    expect((await file("evil/link.txt")).status).toBe(404);
  });

  it("summarises a run's test plan, evidence and security for the panel", async () => {
    const { api, project } = await setup();
    const run = await api.waitForRun((await api.startRun(project)).id, "waiting_review");
    const list = (await api.request("GET", "/runs")).body as { id: string; latestStep: { kind: string; status: string } }[];
    expect(list.find((r) => r.id === run.id)?.latestStep).toMatchObject({ kind: "plan", status: "done" });
    const evidence = (await api.request("GET", `/runs/${run.id}/evidence`)).body as { testPlan: { id: string; covers: string[] }[]; cases: unknown[]; security: unknown };
    expect(evidence.testPlan.map((t) => t.id)).toEqual(["TC-01", "TC-02", "TC-03", "TC-04"]);
    expect(evidence.testPlan[0]?.covers).toEqual(["AC-1"]);
    expect(evidence).toMatchObject({ cases: [], security: null });
  });

  it("explains how to build the panel when it is not built", async () => {
    const { backend } = await setup();
    const res = await raw(`${backend.url}/`);
    expect(res.status).toBe(200);
    expect(res.text).toContain("pnpm --filter @forge/web build");
  });
});
