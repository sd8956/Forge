import { execFileSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startBackend, type Backend } from "../src/app.js";
import type { ForgeConfig } from "../src/config.js";
import { Tmux } from "../src/runner/tmux.js";
import { Api, disposeTmux, fakeEnv, FIXTURE, makeProject, PLAN_ONLY_PIPELINE, scratch, StubMemory, testConfig, waitFor } from "./helpers.js";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** Backlog tasks shaped like TASK-001, so the fake planner finds their acceptance criteria. */
function addTask(project: string, id: string, dependsOn: string[] = []) {
  const spec = readFileSync(join(FIXTURE, ".factory", "backlog", "TASK-001.md"), "utf8")
    .replace("TASK-001", id)
    .replace("- Depends on: none", `- Depends on: ${dependsOn.length ? dependsOn.join(", ") : "none"}`);
  writeFileSync(join(project, ".factory", "backlog", `${id}.md`), spec);
}

async function setup(overrides: Partial<ForgeConfig> = {}, script: Record<string, string[]> = { plan: ["wait-release"] }, env: Record<string, string> = {}) {
  const root = scratch();
  const project = makeProject(root, { pipeline: PLAN_ONLY_PIPELINE });
  const git = (...args: string[]) => execFileSync("git", ["-C", project, "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], { encoding: "utf8" });
  for (const [id, deps] of [["TASK-010", []], ["TASK-011", ["TASK-010"]], ["TASK-012", []], ["TASK-013", []]] as const) addTask(project, id, [...deps]);
  git("add", ".");
  git("commit", "-qm", "backlog");
  const config = testConfig(root, { extraEnv: { ...fakeEnv(root, script), ...env }, ...overrides });
  const tmux = new Tmux(config.tmuxSocket);
  const memory = new StubMemory();
  let backend: Backend = await startBackend(config, { memory });
  cleanups.push(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  cleanups.push(() => disposeTmux(tmux, config.tmuxSocket));
  cleanups.push(() => backend.close());
  const api = () => new Api(backend.url, backend.token);
  const release = () => writeFileSync(join(root, "release"), "");
  const restart = async () => {
    await backend.close();
    backend = await startBackend({ ...config, port: Number(new URL(backend.url).port) }, { memory });
  };
  return { root, project, git, api, release, restart, backend: () => backend };
}

const task = (taskId: string, wave: number, modules: string[], dependsOn: string[] = []) => ({ taskId, wave, modules, priority: 0, dependsOn });
const runsByTask = async (api: Api) => Object.fromEntries((await api.runs()).map((r) => [r.taskId, r]));

describe("scheduler with fake claude", () => {
  it("runs independent tasks in parallel up to the cap and starts a dependent only after its dependency merges", async () => {
    const ctx = await setup({ maxConcurrency: 2 });
    const plans = ctx.backend().plans;
    const plan = plans.propose(ctx.project, "A and C first, B after A", [task("TASK-010", 0, ["src/server"]), task("TASK-012", 0, ["public"]), task("TASK-011", 1, ["src/server"], ["TASK-010"])], "test");

    // Nothing runs before the plan is approved.
    await ctx.backend().scheduler.tick();
    expect(await ctx.api().runs()).toEqual([]);

    expect(plans.approve(plan.id)).toEqual({ ok: true });
    await ctx.backend().scheduler.tick();
    const both = await waitFor(async () => {
      const runs = await runsByTask(ctx.api());
      return runs["TASK-010"]?.status === "running" && runs["TASK-012"]?.status === "running" ? runs : undefined;
    }, "TASK-010 and TASK-012 to run at the same time");
    expect(both["TASK-011"]).toBeUndefined();
    const waiting = () => plans.tasks(plan.id).find((t) => t.taskId === "TASK-011");
    expect(waiting()?.waitReason).toBe("Waits for TASK-010 merge");

    ctx.release();
    await waitFor(async () => {
      const runs = await runsByTask(ctx.api());
      return runs["TASK-010"]?.status === "waiting_review" && runs["TASK-012"]?.status === "waiting_review";
    }, "both runs to finish");
    // Slots are free, but TASK-010 is not merged yet.
    await ctx.backend().scheduler.tick();
    expect((await runsByTask(ctx.api()))["TASK-011"]).toBeUndefined();
    expect(waiting()?.state).toBe("queued");

    // What the PR watcher does when GitHub reports the merge (and the base branch was pulled).
    ctx.git("merge", "-q", "--no-ff", "feat/TASK-010", "-m", "Merge TASK-010");
    await ctx.backend().runService.onPrMerged(both["TASK-010"]!.id);
    expect((await runsByTask(ctx.api()))["TASK-010"]?.status).toBe("done");
    const dependent = await waitFor(async () => (await runsByTask(ctx.api()))["TASK-011"], "TASK-011 to start");
    // start() inserts the run before its first step is up; the plan task is linked right after.
    await waitFor(() => waiting()?.state === "launched", "TASK-011 to be linked");
    expect(waiting()).toMatchObject({ state: "launched", runId: dependent.id, waitReason: null });
  });

  it("never runs two tasks that share a module, not even while the first waits for review", async () => {
    const ctx = await setup({ maxConcurrency: 3 });
    const plans = ctx.backend().plans;
    const plan = plans.propose(ctx.project, "same module", [task("TASK-010", 0, ["src/server"]), task("TASK-012", 0, ["src/server/routes"]), task("TASK-013", 0, ["public"])], "test");
    plans.approve(plan.id);
    await ctx.backend().scheduler.tick();
    await waitFor(async () => {
      const runs = await runsByTask(ctx.api());
      return runs["TASK-010"]?.status === "running" && runs["TASK-013"]?.status === "running";
    }, "TASK-010 and TASK-013 to run");
    await ctx.backend().scheduler.tick();
    expect((await runsByTask(ctx.api()))["TASK-012"]).toBeUndefined();
    expect(plans.tasks(plan.id).find((t) => t.taskId === "TASK-012")?.waitReason).toBe("Module busy: src/server (TASK-010)");

    // TASK-010 opens its PR: it frees its slot but keeps its module until the merge.
    ctx.release();
    const reviewing = await waitFor(async () => {
      const runs = await runsByTask(ctx.api());
      return runs["TASK-010"]?.status === "waiting_review" ? runs : undefined;
    }, "TASK-010 to wait for review");
    await ctx.backend().scheduler.tick();
    expect((await runsByTask(ctx.api()))["TASK-012"]).toBeUndefined();
    expect(plans.tasks(plan.id).find((t) => t.taskId === "TASK-012")?.waitReason).toBe("Module busy: src/server (TASK-010, waiting for review)");

    ctx.git("merge", "-q", "--no-ff", "feat/TASK-010", "-m", "Merge TASK-010");
    await ctx.backend().runService.onPrMerged(reviewing["TASK-010"]!.id);
    await ctx.backend().scheduler.tick();
    await waitFor(async () => (await runsByTask(ctx.api()))["TASK-012"], "TASK-012 to start once TASK-010 merges");
  });

  it("launches nothing while paused, and continues after a restart without launching twice", async () => {
    const ctx = await setup({ maxConcurrency: 1 });
    const { plans } = ctx.backend();
    ctx.backend().scheduler.pause("Paused by a person");
    const plan = plans.propose(ctx.project, "two", [task("TASK-010", 0, ["a"]), task("TASK-012", 0, ["b"])], "test");
    plans.approve(plan.id);
    await ctx.backend().scheduler.tick();
    expect(await ctx.api().runs()).toEqual([]);
    expect(plans.tasks(plan.id).map((t) => t.waitReason)).toEqual(["Queue paused: Paused by a person", "Queue paused: Paused by a person"]);

    await ctx.restart();
    await ctx.backend().scheduler.tick();
    expect(await ctx.api().runs()).toEqual([]);
    expect(ctx.backend().scheduler.resume()).toBe(true);
    await waitFor(async () => (await runsByTask(ctx.api()))["TASK-010"]?.status === "running", "TASK-010 to start");

    await ctx.restart();
    await ctx.backend().scheduler.tick();
    const runs = await ctx.api().runs();
    expect(runs.map((r) => r.taskId)).toEqual(["TASK-010"]);
    expect(ctx.backend().plans.tasks(plan.id).find((t) => t.taskId === "TASK-012")?.waitReason).toBe("Waiting for a slot (1 of 1 sessions busy)");

    ctx.release();
    await waitFor(async () => (await runsByTask(ctx.api()))["TASK-012"], "TASK-012 to start");
    expect((await ctx.api().runs()).filter((r) => r.taskId === "TASK-010")).toHaveLength(1);
  });

  it("stops launching while the usage window is over the threshold", async () => {
    const ctx = await setup();
    const { plans, scheduler } = ctx.backend();
    scheduler.recordUsage({ fiveHour: { percent: 95, resetsAt: Date.now() + 3_600_000 }, sevenDay: null });
    const plan = plans.propose(ctx.project, "one", [task("TASK-010", 0, ["a"])], "test");
    plans.approve(plan.id);
    await scheduler.tick();
    expect(await ctx.api().runs()).toEqual([]);
    expect(plans.tasks(plan.id)[0]?.waitReason).toBe("Usage window at 95% (pause at 90%)");
    scheduler.recordUsage({ fiveHour: { percent: 40, resetsAt: Date.now() + 3_600_000 }, sevenDay: null });
    await scheduler.tick();
    await waitFor(async () => (await runsByTask(ctx.api()))["TASK-010"], "TASK-010 to start");
  });

  it("pauses the whole queue on a usage limit and retries the step without spending an attempt", async () => {
    const ctx = await setup({ maxConcurrency: 1 }, { plan: ["rate-limit", "done"] }, { FAKE_USAGE_PERCENT: "97" });
    const { plans, scheduler } = ctx.backend();
    const plan = plans.propose(ctx.project, "two", [task("TASK-010", 0, ["a"]), task("TASK-012", 0, ["b"])], "test");
    plans.approve(plan.id);
    await scheduler.tick();
    const first = await waitFor(async () => {
      const id = (await runsByTask(ctx.api()))["TASK-010"]?.id;
      const run = id ? await ctx.api().run(id) : undefined;
      return run?.events.some((e) => e.type === "launch_held") ? run : undefined;
    }, "TASK-010 to be held after the usage limit");
    expect(first.steps.map((s) => `${s.kind}#${s.attempt}:${s.status}:${s.exitReason}`)).toEqual(["plan#1:failed:rate_limited"]);
    expect(first).toMatchObject({ status: "running", attempts: {} });

    // The status line reported the window, so the pause lifts by itself when it resets.
    const usage = scheduler.usage();
    expect(usage?.fiveHour?.percent).toBe(97);
    expect(scheduler.pauseState()).toMatchObject({ source: "rate_limit", reason: "Claude usage limit reached", until: usage?.fiveHour?.resetsAt });
    await scheduler.tick();
    expect(plans.tasks(plan.id).find((t) => t.taskId === "TASK-012")?.waitReason).toBe("Queue paused: Claude usage limit reached");
    expect((await runsByTask(ctx.api()))["TASK-012"]).toBeUndefined();

    // A person resumes early (the usage window is also lower now).
    scheduler.recordUsage({ fiveHour: { percent: 20, resetsAt: Date.now() + 3_600_000 }, sevenDay: null });
    expect(scheduler.resume()).toBe(true);
    const done = await ctx.api().waitForRun(first.id, "waiting_review");
    expect(done.steps.map((s) => `${s.kind}#${s.attempt}:${s.status}`)).toEqual(["plan#1:failed", "plan#2:done"]);
    expect(done.attempts).toEqual({});
    // The retried session reported 97% again through the status line, so nothing new starts.
    await scheduler.tick();
    expect(plans.tasks(plan.id).find((t) => t.taskId === "TASK-012")?.waitReason).toBe("Usage window at 97% (pause at 90%)");
    scheduler.recordUsage({ fiveHour: { percent: 20, resetsAt: Date.now() + 3_600_000 }, sevenDay: null });
    await scheduler.tick();
    await waitFor(async () => (await runsByTask(ctx.api()))["TASK-012"], "TASK-012 to start once usage is low");
  });
});
