import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface ForgeConfig {
  /** Backend state: database, token and rendered per-step settings. Never inside a worktree. */
  home: string;
  host: "127.0.0.1";
  port: number;
  /** Dedicated tmux socket (`tmux -L <socket>`) so Forge never touches the user's own sessions. */
  tmuxSocket: string;
  /** Claude Code executable. Tests point it to a fake. */
  claudeBin: string;
  defaultTimeoutMs: number;
  maxStopBlocks: number;
  /** Delay between report_step and kill-session, so the tool result and last hooks can flush. */
  closeGraceMs: number;
  /** How often live steps are checked against `tmux ls`. */
  sweepIntervalMs: number;
  /** Extra environment passed to every step session. Used by tests. */
  extraEnv: Record<string, string>;
  /** Claude Code config read (never written) to check that a project is trusted. */
  claudeConfigFile: string;
  checkTrust: boolean;
  /** Timeout of exit commands such as `make check`. */
  checkTimeoutMs: number;
  /** Engram HTTP API. */
  engramUrl: string;
  /** Built panel served at `/`. */
  webDist: string;
  /** GitHub CLI used by the PR watcher. Tests point it to a fake. */
  ghBin: string;
  /** Default interval between PR polls. */
  prPollIntervalMs: number;
  /** Sessions the scheduler runs at once, across projects. */
  maxConcurrency: number;
  /** The scheduler stops launching while the 5-hour usage window is at or above this percentage. */
  usagePausePercent: number;
  /** How often the scheduler looks at the queue (it also wakes on run events). */
  schedulerIntervalMs: number;
  /** Project template a definition copies (agents, skills, pipeline, step settings). */
  templateDir: string;
  /** How often projects are checked for newer Forge files (0 turns the automatic check off). */
  templateSyncIntervalMs: number;
}

function intFromEnv(value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`Invalid integer: ${value}`);
  return parsed;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): ForgeConfig {
  return {
    home: resolve(env.FORGE_HOME ?? join(cwd, ".forge")),
    host: "127.0.0.1",
    port: intFromEnv(env.FORGE_PORT, 7420),
    tmuxSocket: env.FORGE_TMUX_SOCKET ?? "forge",
    claudeBin: env.FORGE_CLAUDE_BIN ?? "claude",
    defaultTimeoutMs: intFromEnv(env.FORGE_STEP_TIMEOUT_MS, 30 * 60_000),
    maxStopBlocks: intFromEnv(env.FORGE_MAX_STOP_BLOCKS, 3),
    closeGraceMs: intFromEnv(env.FORGE_CLOSE_GRACE_MS, 1500),
    sweepIntervalMs: intFromEnv(env.FORGE_SWEEP_INTERVAL_MS, 5000),
    extraEnv: {},
    claudeConfigFile: env.FORGE_CLAUDE_CONFIG ?? join(homedir(), ".claude.json"),
    checkTrust: env.FORGE_CHECK_TRUST !== "0",
    checkTimeoutMs: intFromEnv(env.FORGE_CHECK_TIMEOUT_MS, 10 * 60_000),
    engramUrl: env.FORGE_ENGRAM_URL ?? "http://127.0.0.1:7437",
    webDist: resolve(env.FORGE_WEB_DIST ?? join(import.meta.dirname, "..", "..", "web", "dist")),
    ghBin: env.FORGE_GH_BIN ?? "gh",
    prPollIntervalMs: intFromEnv(env.FORGE_PR_POLL_MS, 120_000),
    maxConcurrency: Math.max(1, intFromEnv(env.FORGE_MAX_CONCURRENCY, 3)),
    usagePausePercent: intFromEnv(env.FORGE_USAGE_PAUSE_PERCENT, 90),
    schedulerIntervalMs: intFromEnv(env.FORGE_SCHEDULER_INTERVAL_MS, 5000),
    templateSyncIntervalMs: intFromEnv(env.FORGE_TEMPLATE_SYNC_MS, 6 * 60 * 60_000),
    templateDir: resolve(env.FORGE_TEMPLATE_DIR ?? join(import.meta.dirname, "..", "..", "..", "fixtures", "demo-project")),
  };
}

export function baseUrl(config: Pick<ForgeConfig, "host" | "port">): string {
  return `http://${config.host}:${config.port}`;
}
