import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { RunView, StepView } from "@forge/shared";
import type { ForgeConfig } from "../src/config.js";
import type { EventRow } from "../src/db/schema.js";
import type { Memory, MemoryAdapter } from "../src/memory/memory-adapter.js";
import type { Tmux } from "../src/runner/tmux.js";

export const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..");
export const FAKE_CLAUDE = join(import.meta.dirname, "fake-claude", "fake-claude.mjs");
export const FAKE_GH = join(import.meta.dirname, "fake-gh", "fake-gh.mjs");
export const FIXTURE = join(REPO_ROOT, "fixtures", "demo-project");

/** A one-step pipeline for tests about a single session's lifecycle. */
export const PLAN_ONLY_PIPELINE = `version: 1
defaults: { max_attempts: 1 }
steps:
  - { id: plan, agent: forge-planner, model: opus, settings: steps/planner.settings.json,
      exit: { requires: [plan.md, test-plan.md], every_ac_has_tc: true } }
`;

/** Scratch directory outside the repository. */
export function scratch(prefix = "forge-test-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Kills a test tmux server and removes its socket file, which tmux leaves behind. */
export async function disposeTmux(tmux: Tmux, socket: string): Promise<void> {
  await tmux.killServer();
  const uid = process.getuid?.() ?? 0;
  rmSync(join(process.env.TMUX_TMPDIR ?? "/tmp", `tmux-${uid}`, socket), { force: true });
}

/** Copies the demo fixture into a fresh git repository, optionally with another pipeline. */
export function makeProject(root: string, opts: { pipeline?: string } = {}): string {
  const project = join(root, "demo-project");
  cpSync(FIXTURE, project, { recursive: true, filter: (src) => !src.includes("node_modules") });
  if (opts.pipeline) writeFileSync(join(project, ".factory", "pipeline.yaml"), opts.pipeline);
  const git = (...args: string[]) => execFileSync("git", ["-C", project, ...args], { stdio: "pipe" });
  git("init", "-q", "-b", "main");
  git("add", ".");
  git("-c", "user.name=forge-test", "-c", "user.email=forge-test@example.invalid", "commit", "-qm", "init");
  return project;
}

export function testConfig(root: string, overrides: Partial<ForgeConfig> = {}): ForgeConfig {
  return {
    home: join(root, "home"),
    host: "127.0.0.1",
    port: 0,
    tmuxSocket: `forge-test-${randomBytes(4).toString("hex")}`,
    claudeBin: FAKE_CLAUDE,
    defaultTimeoutMs: 60_000,
    maxStopBlocks: 2,
    closeGraceMs: 100,
    sweepIntervalMs: 200,
    extraEnv: {},
    claudeConfigFile: join(root, "claude.json"),
    checkTrust: false,
    checkTimeoutMs: 60_000,
    engramUrl: "http://127.0.0.1:9",
    webDist: join(root, "no-web"),
    ghBin: FAKE_GH,
    prPollIntervalMs: 200,
    ...overrides,
  };
}

export function fakeEnv(root: string, script: Record<string, string[] | string> = {}): Record<string, string> {
  return {
    FAKE_CLAUDE_SCRIPT: JSON.stringify(script),
    FAKE_CLAUDE_TRACE: join(root, "trace.jsonl"),
    FAKE_CLAUDE_RELEASE: join(root, "release"),
    FAKE_CLAUDE_RELEASE_2: join(root, "release-2"),
    FAKE_CLAUDE_TRANSCRIPT_DIR: root,
  };
}

export function readTrace(root: string): Record<string, unknown>[] {
  const file = join(root, "trace.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
}

/** In-memory MemoryAdapter so integration tests never depend on a running Engram. */
export class StubMemory implements MemoryAdapter {
  constructor(readonly items: Memory[] = []) {}
  search(): Promise<Memory[]> {
    return Promise.resolve(this.items);
  }
  listByTask(_project: string, taskId: string): Promise<Memory[]> {
    return Promise.resolve(this.items.filter((m) => m.ref?.startsWith(`${taskId}/`)));
  }
  readonly saved: { project: string; title: string; type: string; content: string }[] = [];
  save(project: string, observation: { title: string; type: string; content: string }): Promise<number> {
    this.saved.push({ project, ...observation });
    return Promise.resolve(this.saved.length);
  }
}

export async function waitFor<T>(probe: () => T | undefined | false | Promise<T | undefined | false>, what: string, timeoutMs = 30_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = await probe();
    if (value !== undefined && value !== false) return value;
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

export type RunDetail = RunView & {
  steps: StepView[];
  events: EventRow[];
  prThreads: { id: string; kind: string; author: string | null; path: string | null; line: number | null; url: string | null; handled: boolean; body: string }[];
  memories: { available: boolean; items: { id: number; title: string; ref: string | null }[] };
};

export class Api {
  constructor(readonly url: string, readonly token: string) {}

  async request(method: string, path: string, body?: unknown, token: string | null = this.token): Promise<{ status: number; body: unknown }> {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers["content-type"] = "application/json";
    if (token !== null) headers["x-forge-token"] = token;
    const response = await fetch(`${this.url}${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const text = await response.text();
    return { status: response.status, body: text ? (JSON.parse(text) as unknown) : null };
  }

  async startRun(projectPath: string, taskId = "TASK-001"): Promise<RunView> {
    const res = await this.request("POST", "/runs", { projectPath, taskId });
    if (res.status !== 201) throw new Error(`start failed: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body as RunView;
  }

  async run(id: string): Promise<RunDetail> {
    return (await this.request("GET", `/runs/${id}`)).body as RunDetail;
  }

  async runs(): Promise<RunView[]> {
    return (await this.request("GET", "/runs")).body as RunView[];
  }

  async step(id: string): Promise<StepView & { events: EventRow[] }> {
    return (await this.request("GET", `/steps/${id}`)).body as StepView & { events: EventRow[] };
  }

  async waitForRun(id: string, status: RunView["status"], timeoutMs = 30_000): Promise<RunDetail> {
    return waitFor(async () => {
      const run = await this.run(id);
      return run.status === status ? run : undefined;
    }, `run ${id} to be ${status}`, timeoutMs);
  }
}
