import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import type { StepView } from "@forge/shared";
import type { EventRow } from "../src/db/schema.js";
import type { ForgeConfig } from "../src/config.js";
import type { Tmux } from "../src/runner/tmux.js";

export const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..");
export const FAKE_CLAUDE = join(import.meta.dirname, "fake-claude", "fake-claude.mjs");
export const FIXTURE = join(REPO_ROOT, "fixtures", "demo-project");

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

/** Copies the demo fixture into a fresh git repository. */
export function makeProject(root: string): string {
  const project = join(root, "demo-project");
  cpSync(FIXTURE, project, { recursive: true });
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
    ...overrides,
  };
}

export function fakeEnv(root: string, scenario: string): Record<string, string> {
  return {
    FAKE_CLAUDE_SCENARIO: scenario,
    FAKE_CLAUDE_TRACE: join(root, "trace.jsonl"),
    FAKE_CLAUDE_RELEASE: join(root, "release"),
    FAKE_CLAUDE_TRANSCRIPT_DIR: root,
  };
}

export function readTrace(root: string): Record<string, unknown>[] {
  const file = join(root, "trace.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
}

export async function waitFor<T>(probe: () => T | undefined | Promise<T | undefined>, what: string, timeoutMs = 15_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = await probe();
    if (value !== undefined && value !== false) return value;
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

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

  async startStep(projectPath: string, extra: Record<string, unknown> = {}): Promise<StepView> {
    const res = await this.request("POST", "/steps", { projectPath, taskId: "TASK-001", step: "plan", ...extra });
    if (res.status !== 201) throw new Error(`start failed: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body as StepView;
  }

  async step(id: string): Promise<StepView & { events: EventRow[] }> {
    const res = await this.request("GET", `/steps/${id}`);
    return res.body as StepView & { events: EventRow[] };
  }

  async steps(): Promise<StepView[]> {
    return (await this.request("GET", "/steps")).body as StepView[];
  }
}
