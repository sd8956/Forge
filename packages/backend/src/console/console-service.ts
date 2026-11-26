import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ForgeConfig } from "../config.js";
import type { PlanStore } from "../db/plan-store.js";
import type { ProjectRow } from "../db/schema.js";
import { shellQuote, type Tmux } from "../runner/tmux.js";

export interface ConsoleSession {
  projectId: string;
  tmuxSession: string;
  startedAt: number;
}

/** What the console is for, and the two rules that keep it from stepping on the pipeline. */
export const CONSOLE_PROMPT = [
  "You are the Forge console for this project. The person asks you about the project, about the state of its tasks",
  "and pipeline steps, and delegates fixing what is blocked. The `factory` MCP tools show and change Forge's state:",
  "get_status, list_runs, get_run, active_steps, resume_run, cancel_run, start_task, pause_queue and resume_queue.",
  "Before editing files in a task's worktree (.worktrees/TASK-xxx), call active_steps: never edit a worktree whose step",
  "session is live; pause the queue or wait. Change run and queue state only through those tools, never by hand",
  "(no editing Forge's database, no killing tmux sessions). A person merges every pull request.",
].join(" ");

interface Deps {
  config: ForgeConfig;
  tmux: Tmux;
  plans: PlanStore;
  token: string;
  url: () => string;
  apiKeyHelper?: () => string | null;
  now?: () => number;
}

/**
 * One Claude Code session per project for the person: their own settings, the project's checkout, Forge's tools, and
 * the default permission mode so every command or edit is theirs to approve in the panel terminal.
 */
export class ConsoleService {
  private readonly now: () => number;

  constructor(private readonly deps: Deps) {
    this.now = deps.now ?? Date.now;
  }

  private key = (project: ProjectRow) => `console.${project.id}`;

  async status(project: ProjectRow): Promise<ConsoleSession | null> {
    const saved = this.deps.plans.getSetting<ConsoleSession>(this.key(project));
    return saved && (await this.deps.tmux.hasSession(saved.tmuxSession)) ? saved : null;
  }

  async start(project: ProjectRow): Promise<ConsoleSession> {
    const running = await this.status(project);
    if (running) return running;
    const dir = join(this.deps.config.home, "console", project.id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const url = this.deps.url();
    const helper = this.deps.apiKeyHelper?.() ?? null;
    const files = { settings: join(dir, "settings.json"), mcp: join(dir, "mcp.json") };
    // Added on top of the person's own settings: bypass stays off, and the API key setting applies.
    writeFileSync(files.settings, JSON.stringify({ permissions: { disableBypassPermissionsMode: "disable" }, ...(helper ? { apiKeyHelper: helper } : {}) }, null, 2), { mode: 0o600 });
    writeFileSync(files.mcp, JSON.stringify({ mcpServers: { factory: { type: "http", url: `${url}/mcp/console/${project.id}`, headers: { "x-forge-token": this.deps.token } } } }, null, 2), { mode: 0o600 });
    const session: ConsoleSession = { projectId: project.id, tmuxSession: `forge-console-${project.id.slice(0, 8)}`, startedAt: this.now() };
    const args = [
      this.deps.config.claudeBin,
      "--permission-mode", "default",
      "--settings", files.settings,
      "--append-system-prompt", CONSOLE_PROMPT,
      "--mcp-config", files.mcp,
    ];
    await this.deps.tmux.killSession(session.tmuxSession);
    await this.deps.tmux.newSession({ name: session.tmuxSession, cwd: project.repoPath, command: args.map(shellQuote).join(" "), env: { ...this.deps.config.extraEnv } });
    this.deps.plans.setSetting(this.key(project), session);
    this.deps.plans.recordEvent("plan", project.id, "console_started", { tmuxSession: session.tmuxSession });
    return session;
  }

  async stop(project: ProjectRow): Promise<boolean> {
    const saved = this.deps.plans.getSetting<ConsoleSession>(this.key(project));
    if (!saved) return false;
    const killed = await this.deps.tmux.killSession(saved.tmuxSession);
    this.deps.plans.deleteSetting(this.key(project));
    this.deps.plans.recordEvent("plan", project.id, "console_stopped", { killed });
    return killed;
  }
}
