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
  };
}

export function baseUrl(config: Pick<ForgeConfig, "host" | "port">): string {
  return `http://${config.host}:${config.port}`;
}
