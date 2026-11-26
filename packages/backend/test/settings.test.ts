import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startBackend, type Backend } from "../src/app.js";
import { Tmux } from "../src/runner/tmux.js";
import { Api, disposeTmux, fakeEnv, makeProject, PLAN_ONLY_PIPELINE, scratch, StubMemory, testConfig, waitFor, removeScratch } from "./helpers.js";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const KEY = "sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdef-wxyz";

async function setup() {
  const root = scratch();
  const project = makeProject(root, { pipeline: PLAN_ONLY_PIPELINE });
  const config = testConfig(root, { extraEnv: fakeEnv(root, { plan: ["done"] }), maxConcurrency: 3, usagePausePercent: 90 });
  const tmux = new Tmux(config.tmuxSocket);
  const backend: Backend = await startBackend(config, { memory: new StubMemory() });
  cleanups.push(() => removeScratch(root));
  cleanups.push(() => disposeTmux(tmux, config.tmuxSocket));
  cleanups.push(() => backend.close());
  return { root, project, config, backend, api: new Api(backend.url, backend.token) };
}


describe("settings", () => {
  it("overrides the session cap and the usage threshold from the panel, over the environment defaults", async () => {
    const ctx = await setup();
    expect((await ctx.api.request("GET", "/settings")).body).toEqual({ maxConcurrency: 3, usagePausePercent: 90, auth: "subscription", apiKey: { configured: false, last4: null } });
    const saved = await ctx.api.request("PATCH", "/settings", { maxConcurrency: 1, usagePausePercent: 75 });
    expect(saved.body).toMatchObject({ maxConcurrency: 1, usagePausePercent: 75 });
    expect((await ctx.api.request("GET", "/queue")).body).toMatchObject({ maxConcurrency: 1, usagePausePercent: 75 });
    expect((await ctx.api.request("PATCH", "/settings", { maxConcurrency: 0 })).status).toBe(400);
    expect((await ctx.api.request("PATCH", "/settings", { usagePausePercent: 101 })).status).toBe(400);
  });

  it("stores an API key only in a private file, never in the database or a response, and steps read it through apiKeyHelper", async () => {
    const ctx = await setup();
    expect((await ctx.api.request("PATCH", "/settings", { auth: "api_key" })).body).toMatchObject({ message: "Save an API key before switching to it" });
    expect((await ctx.api.request("PUT", "/settings/api-key", { key: "not-a-key" })).status).toBe(400);

    const stored = await ctx.api.request("PUT", "/settings/api-key", { key: KEY });
    expect(stored.body).toMatchObject({ apiKey: { configured: true, last4: "wxyz" } });
    expect(JSON.stringify(stored.body)).not.toContain(KEY);
    const file = join(ctx.config.home, "anthropic-api-key");
    expect(readFileSync(file, "utf8")).toBe(KEY);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(ctx.config.home, "forge.db")).includes(Buffer.from(KEY))).toBe(false);

    expect((await ctx.api.request("PATCH", "/settings", { auth: "api_key" })).body).toMatchObject({ auth: "api_key" });
    const { id } = await ctx.api.startRun(ctx.project);
    const run = await ctx.api.waitForRun(id, "waiting_review");
    const settings = JSON.parse(readFileSync(join(ctx.config.home, "steps", run.steps[0]!.id, "settings.json"), "utf8")) as { apiKeyHelper?: string };
    expect(settings.apiKeyHelper).toBe(`cat ${file}`);
    expect(JSON.stringify(settings)).not.toContain(KEY);
    expect(readFileSync(join(ctx.config.home, "forge.db")).includes(Buffer.from(KEY))).toBe(false);

    // The key in use cannot be removed; switching back to the subscription first can.
    expect((await ctx.api.request("DELETE", "/settings/api-key")).status).toBe(409);
    await ctx.api.request("PATCH", "/settings", { auth: "subscription" });
    expect((await ctx.api.request("DELETE", "/settings/api-key")).body).toMatchObject({ apiKey: { configured: false, last4: null } });
    // Back on the subscription, a new step gets no apiKeyHelper (the first run only waits for review, so TASK-001 can run again).
    const { id: second } = await ctx.api.startRun(ctx.project);
    const done = await waitFor(async () => {
      const r = await ctx.api.run(second);
      return r.steps[0] ? r : undefined;
    }, "the second step");
    const plain = JSON.parse(readFileSync(join(ctx.config.home, "steps", done.steps[0]!.id, "settings.json"), "utf8")) as { apiKeyHelper?: string };
    expect(plain.apiKeyHelper).toBeUndefined();
  }, 60_000);

  it("shows a project's settings from project.yaml, read-only", async () => {
    const ctx = await setup();
    const { id } = (await ctx.api.request("POST", "/projects", { path: ctx.project })).body as { id: string };
    const res = await ctx.api.request("GET", `/projects/${id}/settings`);
    expect(res.body).toMatchObject({
      file: join(ctx.project, ".factory", "project.yaml"),
      permissionMode: "auto",
      allowedAuthors: ["sd8956"],
      pollIntervalSeconds: 60,
      maxConcurrency: null,
      commands: expect.objectContaining({ check: "make check" }) as Record<string, string>,
    });
  });
});
