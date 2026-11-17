import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DefinitionView } from "@forge/shared";
import { afterEach, describe, expect, it } from "vitest";
import { startBackend, type Backend } from "../src/app.js";
import { Tmux } from "../src/runner/tmux.js";
import { Api, disposeTmux, FAKE_GH, fakeEnv, readTrace, scratch, StubMemory, testConfig, waitFor } from "./helpers.js";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const IDEA = "A link shortener for a small team: paste a URL, get a short link, see how often it was opened.";

/** An empty clone of a new GitHub repo: no commits, an `origin` remote (a local bare repo here). */
async function setup(script: Record<string, string[]> = {}) {
  const root = scratch();
  const repo = join(root, "shortener");
  const origin = join(root, "origin.git");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  mkdirSync(repo);
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], { encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("remote", "add", "origin", origin);
  const ghState = join(root, "gh.json");
  writeFileSync(ghState, JSON.stringify({ login: "sd8956", prs: {}, logs: {} }));
  process.env.FAKE_GH_STATE = ghState;
  const config = testConfig(root, { extraEnv: { ...fakeEnv(root, script), FAKE_GH_STATE: ghState }, ghBin: FAKE_GH });
  const tmux = new Tmux(config.tmuxSocket);
  const memory = new StubMemory();
  let backend: Backend = await startBackend(config, { memory });
  cleanups.push(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  cleanups.push(() => disposeTmux(tmux, config.tmuxSocket));
  cleanups.push(() => backend.close());
  const api = () => new Api(backend.url, backend.token);
  const restart = async () => {
    await backend.close();
    backend = await startBackend({ ...config, port: Number(new URL(backend.url).port) }, { memory });
  };
  return { root, repo, origin, git, api, restart, ghState, release: () => writeFileSync(join(root, "release"), "") };
}

async function begin(ctx: Awaited<ReturnType<typeof setup>>): Promise<DefinitionView> {
  const res = await ctx.api().request("POST", "/definitions", { path: ctx.repo, idea: IDEA });
  if (res.status !== 201) throw new Error(`begin failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body as DefinitionView;
}

const view = async (ctx: Awaited<ReturnType<typeof setup>>, projectId: string) => (await ctx.api().request("GET", `/projects/${projectId}/definition`)).body as DefinitionView;
const stageOf = (v: DefinitionView, stage: string) => v.stages.find((s) => s.stage === stage)!;
const waitStage = (ctx: Awaited<ReturnType<typeof setup>>, projectId: string, stage: string, status: string) =>
  waitFor(async () => {
    const v = await view(ctx, projectId);
    return stageOf(v, stage).status === status ? v : undefined;
  }, `${stage} to be ${status}`);

describe("project definition with fake claude", () => {
  it("runs the six stages from an empty repo, each behind the person's gate, and opens the definition PR", async () => {
    const ctx = await setup();
    const started = await begin(ctx);
    const id = started.projectId;
    expect(started.stages.map((s) => `${s.stage}:${s.status}`)).toEqual(["intake:running", "requirements:pending", "architecture:pending", "test_strategy:pending", "design:pending", "backlog:pending"]);

    // Forge's template is in the worktree; the person's checkout stays clean.
    expect(ctx.git("-C", started.worktreePath, "log", "--format=%s")).toBe("chore: add the Forge template\nchore: start the project\n");
    expect(ctx.git("status", "--porcelain")).toBe("");

    const summaries: Record<string, string> = { intake: "shortener · web", requirements: "2 FR · 1 NFR", architecture: "1 ADR · STRIDE", test_strategy: "Test strategy ready", design: "2 screens", backlog: "1 task" };
    for (const stage of ["intake", "requirements", "architecture", "test_strategy", "design", "backlog"]) {
      const inReview = await waitStage(ctx, id, stage, "in_review");
      expect(stageOf(inReview, stage).summary).toBe(summaries[stage]);
      // Nothing moves on until the person decides.
      const next = inReview.stages[inReview.stages.findIndex((s) => s.stage === stage) + 1];
      if (next) expect(next.status).toBe("pending");
      if (stage === "design") {
        const early = await ctx.api().request("POST", `/projects/${id}/definition/design/approve`);
        expect(early).toMatchObject({ status: 409, body: { message: "Approve every screen first: index.html, stats.html" } });
        for (const screen of ["index.html", "stats.html"]) expect((await ctx.api().request("POST", `/projects/${id}/definition/screens/approve`, { screen })).status).toBe(200);
      }
      const approved = await ctx.api().request("POST", `/projects/${id}/definition/${stage}/approve`);
      expect(approved.status).toBe(200);
      expect(stageOf(approved.body as DefinitionView, stage)).toMatchObject({ status: "approved", commit: expect.stringMatching(/^[0-9a-f]{7,}$/) as string });
    }

    const done = await waitFor(async () => {
      const v = await view(ctx, id);
      return v.prUrl ? v : undefined;
    }, "the definition PR");
    expect(done.prUrl).toMatch(/^https:\/\/github\.com\/example\/repo\/pull\/\d+$/);
    const gh = JSON.parse(readFileSync(ctx.ghState, "utf8")) as { prs: Record<string, { headRefName: string; title: string }> };
    expect(Object.values(gh.prs)).toEqual([expect.objectContaining({ headRefName: "forge/definition", title: "docs: project definition" })]);
    expect(execFileSync("git", ["-C", ctx.origin, "branch", "--list", "forge/definition"], { encoding: "utf8" })).toContain("forge/definition");
    expect(ctx.git("-C", done.worktreePath, "log", "--format=%s", "-6").trim().split("\n")).toEqual([
      "docs(definition): approve the backlog",
      "docs(definition): approve the design",
      "docs(definition): approve the test strategy",
      "docs(definition): approve the architecture",
      "docs(definition): approve the requirements",
      "docs(definition): approve the intake",
    ]);
    // The agents' memory points at the project name decided at intake.
    expect(readFileSync(join(done.worktreePath, ".claude", "agents", "forge-planner.md"), "utf8")).toContain('"--project", "shortener"');
    // Every stage ran as its own agent, in the definition worktree, reporting with report_stage.
    const reports = readTrace(ctx.root).filter((t) => t.type === "report_step");
    expect(reports.map((r) => r.kind)).toEqual(["def_intake", "def_requirements", "def_architecture", "def_test_strategy", "def_design", "def_backlog"]);
    expect(reports.every((r) => r.isError === false)).toBe(true);
    expect(readTrace(ctx.root).filter((t) => t.type === "started").map((t) => t.agent)).toEqual([
      "forge-def-intake",
      "forge-def-requirements",
      "forge-def-architecture",
      "forge-def-test-strategy",
      "forge-def-design",
      "forge-def-backlog",
    ]);
  }, 120_000);

  it("serves the documents and an isolated prototype, never handoffs, settings or files outside .factory/", async () => {
    const ctx = await setup();
    const { projectId: id } = await begin(ctx);
    for (const stage of ["intake", "requirements", "architecture", "test_strategy"]) {
      await waitStage(ctx, id, stage, "in_review");
      await ctx.api().request("POST", `/projects/${id}/definition/${stage}/approve`);
    }
    await waitStage(ctx, id, "design", "in_review");
    const get = (path: string) => fetch(`${ctx.api().url}/projects/${id}/definition/files/${path}`, { headers: { "x-forge-token": ctx.api().token } });
    const requirements = await get("requirements.md");
    expect(requirements.status).toBe(200);
    expect(await requirements.text()).toContain("### FR-001 Shorten a link");
    const screen = await get("prototype/index.html");
    expect(screen.headers.get("content-security-policy")).toBe("default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; sandbox allow-scripts");
    expect(screen.headers.get("content-type")).toBe("text/html; charset=utf-8");
    for (const path of ["steps/definition.settings.json", "runs/x/output.md", "..%2Fpackage.json", "missing.md"]) expect((await get(path)).status).toBe(404);
  }, 90_000);

  it("relaunches a stage with the person's changes, keeping what was approved", async () => {
    const ctx = await setup();
    const { projectId: id } = await begin(ctx);
    await waitStage(ctx, id, "intake", "in_review");
    await ctx.api().request("POST", `/projects/${id}/definition/intake/approve`);
    const review = await waitStage(ctx, id, "requirements", "in_review");
    const firstStep = stageOf(review, "requirements").stepId;

    const changed = await ctx.api().request("POST", `/projects/${id}/definition/requirements/changes`, { feedback: "Add a requirement for expiring links" });
    expect(changed.status).toBe(200);
    const again = await waitStage(ctx, id, "requirements", "in_review");
    expect(stageOf(again, "requirements").stepId).not.toBe(firstStep);
    expect(stageOf(again, "intake")).toMatchObject({ status: "approved" });
    expect(readFileSync(join(again.worktreePath, ".factory", "requirements.md"), "utf8")).toContain("Changed after review: Add a requirement for expiring links");
    // The relaunched session saw the request and its earlier report.
    const input = readFileSync(join(again.worktreePath, ".factory", "runs", `DEF-${id.slice(0, 8)}`, "def_requirements", "2", "input.md"), "utf8");
    expect(input).toContain("## Changes the person asked for");
    expect(input).toContain("def_requirements/1/output.md");
    expect((await ctx.api().request("POST", `/projects/${id}/definition/intake/changes`, { feedback: "too late" })).status).toBe(409);
  }, 90_000);

  it("rejects a report whose files do not pass, and the session fixes them", async () => {
    const ctx = await setup({ def_intake: ["def-invalid-then-fix"] });
    const { projectId: id } = await begin(ctx);
    await waitStage(ctx, id, "intake", "in_review");
    const rejected = readTrace(ctx.root).find((t) => t.type === "def_rejected") as { isError: boolean; text: string };
    expect(rejected.isError).toBe(true);
    expect(rejected.text).toContain(".factory/project.yaml is missing");
  }, 60_000);

  it("never lets a stage write outside .factory/", async () => {
    const ctx = await setup({ def_intake: ["write-outside"] });
    const { projectId: id } = await begin(ctx);
    await waitStage(ctx, id, "intake", "in_review");
    const guard = readTrace(ctx.root).find((t) => t.type === "guard") as { outside: { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string } }; inside: unknown };
    expect(guard.outside.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(guard.outside.hookSpecificOutput.permissionDecisionReason).toContain("writes only inside");
    expect(guard.inside).toBeNull();
  }, 60_000);

  it("survives a restart mid-stage, and a session that ends without a report can be retried", async () => {
    const ctx = await setup({ def_intake: ["wait-release"], def_requirements: ["exit-without-report", "done"] });
    const { projectId: id } = await begin(ctx);
    await ctx.restart();
    expect(stageOf(await view(ctx, id), "intake").status).toBe("running");
    ctx.release();
    await waitStage(ctx, id, "intake", "in_review");
    await ctx.api().request("POST", `/projects/${id}/definition/intake/approve`);

    const failed = await waitStage(ctx, id, "requirements", "pending");
    expect(stageOf(failed, "requirements").lastError).toContain("ended without a valid report");
    expect((await ctx.api().request("POST", `/projects/${id}/definition/architecture/retry`)).status).toBe(409);
    expect((await ctx.api().request("POST", `/projects/${id}/definition/requirements/retry`)).status).toBe(200);
    await waitStage(ctx, id, "requirements", "in_review");
  }, 90_000);

  it("refuses a folder that is not a repo or is already defined", async () => {
    const ctx = await setup();
    expect((await ctx.api().request("POST", "/definitions", { path: join(ctx.root, "nope"), idea: IDEA })).body).toMatchObject({ message: expect.stringContaining("Not a directory") as string });
    mkdirSync(join(ctx.root, "plain"));
    expect((await ctx.api().request("POST", "/definitions", { path: join(ctx.root, "plain"), idea: IDEA })).body).toMatchObject({ message: expect.stringContaining("Not a git repository") as string });
    await begin(ctx);
    expect((await ctx.api().request("POST", "/definitions", { path: ctx.repo, idea: IDEA })).body).toMatchObject({ message: expect.stringContaining("already has a definition") as string });
  }, 60_000);
});
