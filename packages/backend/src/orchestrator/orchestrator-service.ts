import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ForgeConfig } from "../config.js";
import type { PlanStore } from "../db/plan-store.js";
import type { ProjectRow } from "../db/schema.js";
import { shellQuote, type Tmux } from "../runner/tmux.js";
import { isTrusted } from "../runs/trust.js";

export const ORCHESTRATOR_AGENT = "forge-orchestrator";
const SETTINGS_TEMPLATE = join(".factory", "orchestrator.settings.json");
/** Tools the orchestrator never gets, whatever the template or agent file say. */
export const ORCHESTRATOR_DISALLOWED_TOOLS = ["Bash", "Write", "Edit", "MultiEdit", "NotebookEdit", "WebFetch", "WebSearch", "Agent", "Task"];

const DEFAULT_PROMPT =
  "Call list_backlog, read the specs of the tasks that are not merged yet in .factory/backlog/, and propose an execution plan with propose_plan. Then tell me the plan is ready for approval in the panel.";

export interface OrchestratorSession {
  projectId: string;
  tmuxSession: string;
  startedAt: number;
}

export class OrchestratorError extends Error {}

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
 * One orchestrator Claude Code session per project, in the project's own
 * checkout. It can read the code and talk to the person, and it acts only
 * through the `factory` tools (no Bash, no writes). The person talks to it
 * through the panel terminal.
 */
export class OrchestratorService {
  private readonly now: () => number;

  constructor(private readonly deps: Deps) {
    this.now = deps.now ?? Date.now;
  }

  sessionName(project: ProjectRow): string {
    return `forge-orch-${project.id.slice(0, 8)}`;
  }

  async status(project: ProjectRow): Promise<OrchestratorSession | null> {
    const saved = this.deps.plans.getSetting<OrchestratorSession>(`orchestrator.${project.id}`);
    if (!saved) return null;
    return (await this.deps.tmux.hasSession(saved.tmuxSession)) ? saved : null;
  }

  async start(project: ProjectRow, prompt?: string): Promise<OrchestratorSession> {
    const running = await this.status(project);
    if (running) return running;
    const path = project.repoPath;
    if (!existsSync(join(path, ".claude", "agents", `${ORCHESTRATOR_AGENT}.md`))) {
      throw new OrchestratorError(`Missing .claude/agents/${ORCHESTRATOR_AGENT}.md in ${path}`);
    }
    const template = join(path, SETTINGS_TEMPLATE);
    if (!existsSync(template)) throw new OrchestratorError(`Missing ${SETTINGS_TEMPLATE} in ${path}`);
    if (this.deps.config.checkTrust && !isTrusted(this.deps.config.claudeConfigFile, path)) {
      throw new OrchestratorError(`Claude Code does not trust ${path} yet. Run \`claude\` in that folder once and accept the trust dialog.`);
    }

    // Rendered outside the project: both files carry the local token.
    const dir = join(this.deps.config.home, "orchestrator", project.id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const url = this.deps.url();
    const settings = readFileSync(template, "utf8")
      .replaceAll("{{FORGE_URL}}", url)
      .replaceAll("{{FORGE_TOKEN}}", this.deps.token)
      .replaceAll("{{FORGE_HOME}}", this.deps.config.home);
    const parsed = JSON.parse(settings) as Record<string, unknown>;
    const helper = this.deps.apiKeyHelper?.() ?? null;
    const rendered = JSON.stringify(helper ? { ...parsed, apiKeyHelper: helper } : parsed, null, 2);
    const files = { settings: join(dir, "settings.json"), mcp: join(dir, "mcp.json") };
    writeFileSync(files.settings, rendered, { mode: 0o600 });
    writeFileSync(
      files.mcp,
      JSON.stringify({ mcpServers: { factory: { type: "http", url: `${url}/mcp/orchestrator/${project.id}`, headers: { "x-forge-token": this.deps.token } } } }, null, 2),
      { mode: 0o600 },
    );

    const session: OrchestratorSession = { projectId: project.id, tmuxSession: this.sessionName(project), startedAt: this.now() };
    // The prompt goes first: --mcp-config and --disallowedTools are variadic.
    const args = [
      this.deps.config.claudeBin,
      prompt?.trim() || DEFAULT_PROMPT,
      "--agent", ORCHESTRATOR_AGENT,
      "--permission-mode", "default",
      "--setting-sources", "project",
      "--settings", files.settings,
      "--mcp-config", files.mcp,
      "--disallowedTools", ...ORCHESTRATOR_DISALLOWED_TOOLS,
    ];
    await this.deps.tmux.killSession(session.tmuxSession);
    await this.deps.tmux.newSession({
      name: session.tmuxSession,
      cwd: path,
      command: args.map(shellQuote).join(" "),
      env: { FORGE_ORCHESTRATOR_PROJECT: project.id, ...this.deps.config.extraEnv },
    });
    this.deps.plans.setSetting(`orchestrator.${project.id}`, session);
    this.deps.plans.recordEvent("plan", project.id, "orchestrator_started", { tmuxSession: session.tmuxSession });
    return session;
  }

  async stop(project: ProjectRow): Promise<boolean> {
    const saved = this.deps.plans.getSetting<OrchestratorSession>(`orchestrator.${project.id}`);
    if (!saved) return false;
    const killed = await this.deps.tmux.killSession(saved.tmuxSession);
    this.deps.plans.deleteSetting(`orchestrator.${project.id}`);
    this.deps.plans.recordEvent("plan", project.id, "orchestrator_stopped", { killed });
    return killed;
  }
}
