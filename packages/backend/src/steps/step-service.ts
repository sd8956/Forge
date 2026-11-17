import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  type ActivityHookInput,
  ATTENTION_NOTIFICATION_TYPES,
  isTerminalStepStatus,
  type NotificationHookInput,
  type PreToolUseHookInput,
  type ReportStepInput,
  type SessionEndHookInput,
  type StopFailureHookInput,
  type DefinitionStage,
  type StepKind,
  type StopHookInput,
} from "@forge/shared";
import type { ForgeConfig } from "../config.js";
import type { StepRow } from "../db/schema.js";
import type { StepStore } from "../db/step-store.js";
import { reportEvent, type StepEvent } from "../domain/step-machine.js";
import { decideStop } from "../domain/stop-policy.js";
import { guardTool } from "../domain/tool-guard.js";
import { shellQuote, type Tmux } from "../runner/tmux.js";
import { agentPermissionMode } from "./agent-file.js";

export class StepRequestError extends Error {}

export type StopHookResponse = { decision: "block"; reason: string } | null;

export type PreToolUseResponse = {
  hookSpecificOutput: { hookEventName: "PreToolUse"; permissionDecision: "deny"; permissionDecisionReason: string };
} | null;

export type ReportResult = { ok: true; message: string } | { ok: false; message: string };

/** Everything needed to launch one step session. The run service builds it. */
export interface StepLaunchSpec {
  id: string;
  runId: string | null;
  projectPath: string;
  taskId: string;
  /** A pipeline step, or `def_<stage>` for a definition stage. */
  kind: StepKind | `def_${DefinitionStage}`;
  attempt: number;
  agent: string;
  model: string;
  worktreePath: string;
  /** Absolute path of the settings template (read from the project's main checkout). */
  settingsTemplate: string;
  /** Absolute paths inside the worktree. */
  inputPath: string;
  outputPath: string;
  input: string;
  /** First prompt; must name the input file. */
  prompt: string;
  timeoutMs: number;
}

/**
 * What a step's owner decides: whether a report is acceptable, what the Stop
 * hook adds to its reminder, and what happens after a status change.
 */
const STATUS_LINE_SCRIPT = join(import.meta.dirname, "..", "..", "scripts", "forge-statusline.mjs");

/**
 * Adds what Forge itself needs to every step's settings, whatever the template
 * says: a StopFailure hook (usage limits and API errors) and a status line
 * that forwards the usage window. The status line reads the URL and token from
 * a private file, so the token never appears in a command line.
 */
export function withForgeSignals(settings: Record<string, unknown>, url: string, token: string, statusLineConfig: string): Record<string, unknown> {
  const hooks = { ...((settings.hooks as Record<string, unknown> | undefined) ?? {}) };
  hooks.StopFailure = [{ hooks: [{ type: "http", url: `${url}/hooks/stop-failure`, headers: { "x-forge-token": token }, timeout: 10 }] }];
  return {
    ...settings,
    hooks,
    statusLine: { type: "command", command: [process.execPath, STATUS_LINE_SCRIPT, statusLineConfig].map(shellQuote).join(" "), padding: 0 },
  };
}

export interface StepPolicy {
  validateReport(step: StepRow, input: ReportStepInput): Promise<{ ok: true } | { ok: false; issues: string[] }>;
  stopCheck(step: StepRow): Promise<string | null>;
  onStepChanged(step: StepRow): void;
}

const NO_POLICY: StepPolicy = {
  validateReport: () => Promise.resolve({ ok: true }),
  stopCheck: () => Promise.resolve(null),
  onStepChanged: () => undefined,
};

interface Deps {
  config: ForgeConfig;
  store: StepStore;
  tmux: Tmux;
  token: string;
  /** Base URL of this backend, as reachable from the step sessions. */
  url: () => string;
  now?: () => number;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}

/**
 * Owns the lifecycle of step sessions: launch, hooks, report_step, timeout,
 * close and startup reconciliation. It never reads the tmux screen.
 */
export class StepService {
  policy: StepPolicy = NO_POLICY;
  /** Called after a step stopped on a usage limit; the scheduler pauses the queue. */
  onRateLimit: (step: StepRow) => void = () => undefined;
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private sweepTimer: NodeJS.Timeout | undefined;
  private readonly pending = new Set<Promise<unknown>>();
  private readonly now: () => number;
  private readonly log: NonNullable<Deps["log"]>;

  constructor(private readonly deps: Deps) {
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? (() => undefined);
  }

  private get store() {
    return this.deps.store;
  }

  // ---------------------------------------------------------------- launch

  async start(spec: StepLaunchSpec): Promise<StepRow> {
    const row = this.store.insert({
      id: spec.id,
      runId: spec.runId,
      projectPath: spec.projectPath,
      taskId: spec.taskId,
      kind: spec.kind,
      attempt: spec.attempt,
      agent: spec.agent,
      model: spec.model,
      // The attempt keeps names unique: a delayed close of attempt n must never kill attempt n+1.
      tmuxSession: `forge-${spec.taskId}-${spec.kind}-${spec.attempt}`,
      claudeSessionId: randomUUID(),
      worktreePath: spec.worktreePath,
      inputPath: spec.inputPath,
      outputPath: spec.outputPath,
      timeoutMs: spec.timeoutMs,
    });

    try {
      const permissionMode = agentPermissionMode(spec.worktreePath, spec.agent);
      mkdirSync(dirname(spec.inputPath), { recursive: true });
      writeFileSync(spec.inputPath, spec.input);
      const files = this.renderSessionFiles(row, spec.settingsTemplate);
      // A stale session with the same name can only belong to a finished step.
      await this.deps.tmux.killSession(row.tmuxSession);
      await this.deps.tmux.newSession({
        name: row.tmuxSession,
        cwd: spec.worktreePath,
        command: this.claudeCommand(row, files, permissionMode, spec.prompt),
        env: { FORGE_STEP_ID: row.id, ...this.deps.config.extraEnv },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.transition(row.id, "launch_failed", { exitReason: "launch_failed", endedAt: this.now() }, { error: message });
      throw new StepRequestError(`Could not launch step ${spec.kind}: ${message}`);
    }

    const startedAt = this.now();
    this.transition(row.id, "launch", { startedAt, deadlineAt: startedAt + row.timeoutMs });
    this.armTimeout(row.id, row.timeoutMs);
    return this.mustGet(row.id);
  }

  /**
   * Renders the step's settings template and its MCP config into the backend
   * home (outside the worktree), because both carry the local token and port.
   */
  private renderSessionFiles(row: StepRow, settingsTemplate: string) {
    if (!existsSync(settingsTemplate)) throw new Error(`Missing step settings template: ${settingsTemplate}`);
    const dir = join(this.deps.config.home, "steps", row.id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const url = this.deps.url();
    const rendered = readFileSync(settingsTemplate, "utf8").replaceAll("{{FORGE_URL}}", url).replaceAll("{{FORGE_TOKEN}}", this.deps.token);
    const statusLineConfig = join(dir, "statusline.json");
    writeFileSync(statusLineConfig, JSON.stringify({ url: `${url}/hooks/usage`, token: this.deps.token }), { mode: 0o600 });
    const settings = JSON.stringify(withForgeSignals(JSON.parse(rendered) as Record<string, unknown>, url, this.deps.token, statusLineConfig), null, 2);
    const mcp = {
      mcpServers: {
        factory: { type: "http", url: `${url}/mcp/${row.id}`, headers: { "x-forge-token": this.deps.token } },
      },
    };
    const files = { settings: join(dir, "settings.json"), mcp: join(dir, "mcp.json"), exitCode: join(dir, "exit-code") };
    writeFileSync(files.settings, settings, { mode: 0o600 });
    writeFileSync(files.mcp, JSON.stringify(mcp, null, 2), { mode: 0o600 });
    return files;
  }

  private claudeCommand(row: StepRow, files: { settings: string; mcp: string; exitCode: string }, permissionMode: string, prompt: string): string {
    // The prompt goes first: --mcp-config is variadic and would swallow a trailing prompt.
    const args = [
      this.deps.config.claudeBin,
      prompt,
      "--agent", row.agent,
      "--permission-mode", permissionMode,
      ...(row.model ? ["--model", row.model] : []),
      "--session-id", row.claudeSessionId,
      "--setting-sources", "project",
      "--settings", files.settings,
      "--mcp-config", files.mcp,
    ];
    return `${args.map(shellQuote).join(" ")}; printf '%s' "$?" > ${shellQuote(files.exitCode)}`;
  }

  // ------------------------------------------------------------ report_step

  async report(stepId: string, input: ReportStepInput): Promise<ReportResult> {
    const step = this.store.get(stepId);
    if (!step) return { ok: false, message: `Unknown step ${stepId}.` };
    if (isTerminalStepStatus(step.status)) {
      return { ok: false, message: `This step was already closed as "${step.status}". Stop working now.` };
    }
    const validation = await this.policy.validateReport(step, input);
    if (!validation.ok) {
      this.store.recordEvent(stepId, "report_rejected", { status: input.status, issues: validation.issues });
      return {
        ok: false,
        message: `Report rejected. Fix these problems, update output.md, and call report_step again:\n- ${validation.issues.join("\n- ")}`,
      };
    }
    const result = this.transition(
      stepId,
      reportEvent(input.status),
      { summary: input.summary, artifacts: input.artifacts, reportedAt: this.now(), exitReason: `reported_${input.status}` },
      { summary: input.summary, artifacts: input.artifacts },
    );
    if (!result.ok) return { ok: false, message: `Cannot report from status "${result.from}".` };
    this.scheduleClose(stepId, this.deps.config.closeGraceMs, "reported");
    return { ok: true, message: `Step reported as "${input.status}". The session will now be closed. Do not do any more work.` };
  }

  // ------------------------------------------------------------------ hooks

  async onStop(input: StopHookInput): Promise<StopHookResponse> {
    const step = this.stepForHook(input.session_id, "Stop", input);
    if (!step) return null;
    const decision = decideStop({
      reported: step.reportedAt !== null,
      stepStatus: step.status,
      stopHookActive: input.stop_hook_active,
      blockCount: step.stopBlockCount,
      maxBlocks: this.deps.config.maxStopBlocks,
      backgroundTasks: input.background_tasks?.length ?? 0,
    });
    if (decision.action === "block") {
      const count = this.store.incrementStopBlocks(step.id);
      const check = await this.policy.stopCheck(step);
      this.store.recordEvent(step.id, "stop_blocked", { count, stopHookActive: input.stop_hook_active, check });
      return { decision: "block", reason: check ? `${check}\n\n${decision.reason}` : decision.reason };
    }
    this.store.recordEvent(step.id, "stop_allowed", { why: decision.why });
    if (decision.why === "block_limit" && step.status === "running") {
      this.transition(step.id, "attention", {}, { cause: "stop_block_limit" });
    }
    return null;
  }

  /**
   * Denies tool calls that would stop the step on a permission prompt or leave
   * the worktree, with a reason the agent can act on. Everything else falls
   * through to Claude Code's normal permission flow.
   */
  onPreToolUse(input: PreToolUseHookInput): PreToolUseResponse {
    const step = this.store.getBySessionId(input.session_id);
    if (!step || isTerminalStepStatus(step.status)) return null;
    // Definition stages may only write inside .factory/; Forge owns everything else in the worktree.
    const writeRoot = step.kind.startsWith("def_") ? join(step.worktreePath, ".factory") : undefined;
    const result = guardTool(input.tool_name, input.tool_input, step.worktreePath, writeRoot);
    if (result.allow) return null;
    const count = this.store.increment(step.id, "toolDenials");
    this.store.recordEvent(step.id, "tool_denied", { tool: input.tool_name, rule: result.rule, input: input.tool_input, count });
    return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: result.reason } };
  }

  /** A tool finished or the person typed: a step waiting for attention is working again. */
  onActivity(input: ActivityHookInput): void {
    const step = this.store.getBySessionId(input.session_id);
    if (step?.status !== "needs_human") return;
    this.transition(step.id, "resume_work", {}, { cause: input.hook_event_name, tool: input.tool_name ?? null });
  }

  onNotification(input: NotificationHookInput): void {
    const step = this.stepForHook(input.session_id, "Notification", input);
    if (!step) return;
    const type = input.notification_type ?? "";
    if (type === "permission_prompt") this.store.increment(step.id, "permissionPrompts");
    if ((ATTENTION_NOTIFICATION_TYPES as readonly string[]).includes(type) && step.status === "running") {
      this.transition(step.id, "attention", {}, { cause: type, message: input.message ?? null });
    }
  }

  /**
   * The turn ended on an API error. A usage limit closes the step without
   * spending an attempt (the run retries it when the queue resumes); any other
   * error needs a person.
   */
  async onStopFailure(input: StopFailureHookInput): Promise<void> {
    const step = this.stepForHook(input.session_id, "StopFailure", input);
    if (!step || isTerminalStepStatus(step.status)) return;
    if (input.error === "rate_limit") {
      // Pause first, so the run that reacts to this step's end already sees the queue on hold.
      this.onRateLimit(step);
      const result = this.transition(step.id, "rate_limited", { exitReason: "rate_limited" }, { message: input.last_assistant_message ?? null });
      if (!result.ok) return;
      this.clearTimeout(step.id);
      await this.close(step.id, "rate_limited");
      return;
    }
    if (step.status === "running") this.transition(step.id, "attention", {}, { cause: `api_error:${input.error}`, message: input.last_assistant_message ?? null });
  }

  onSessionEnd(input: SessionEndHookInput): void {
    const step = this.stepForHook(input.session_id, "SessionEnd", input);
    if (!step) return;
    if (step.endedAt === null) this.store.update(step.id, { endedAt: this.now() });
    if (!isTerminalStepStatus(step.status)) {
      this.clearTimeout(step.id);
      this.transition(step.id, "session_ended", { exitReason: `session_ended_without_report:${input.reason ?? "unknown"}` });
    }
  }

  /** Records every hook as an event and keeps the latest transcript path. */
  private stepForHook(sessionId: string, hook: string, input: { transcript_path?: string | undefined }): StepRow | undefined {
    const step = this.store.getBySessionId(sessionId);
    if (!step) {
      this.store.recordEvent(sessionId, "hook_unknown_session", { hook }, "session");
      return undefined;
    }
    if (input.transcript_path && input.transcript_path !== step.transcriptPath) {
      this.store.update(step.id, { transcriptPath: input.transcript_path });
    }
    this.store.recordEvent(step.id, "hook", { hook, input });
    return this.mustGet(step.id);
  }

  // --------------------------------------------------------- timeout, close

  /** Ends a live step because its run was cancelled, and closes its session. */
  async cancel(stepId: string): Promise<void> {
    const result = this.transition(stepId, "cancel", { exitReason: "cancelled" });
    if (result.ok) await this.close(stepId, "cancelled");
  }

  async isSessionAlive(step: StepRow): Promise<boolean> {
    return this.deps.tmux.hasSession(step.tmuxSession);
  }

  private armTimeout(stepId: string, ms: number): void {
    this.clearTimeout(stepId);
    const timer = setTimeout(() => this.track(this.onTimeout(stepId)), Math.max(0, ms));
    timer.unref();
    this.timers.set(stepId, timer);
  }

  private clearTimeout(stepId: string): void {
    const timer = this.timers.get(stepId);
    if (timer) clearTimeout(timer);
    this.timers.delete(stepId);
  }

  private async onTimeout(stepId: string): Promise<void> {
    this.timers.delete(stepId);
    const result = this.transition(stepId, "timeout", { exitReason: "timeout" });
    if (result.ok) await this.close(stepId, "timeout");
  }

  private scheduleClose(stepId: string, delayMs: number, why: string): void {
    this.clearTimeout(stepId);
    const timer = setTimeout(() => this.track(this.close(stepId, why)), delayMs);
    timer.unref();
  }

  private async close(stepId: string, why: string): Promise<void> {
    const step = this.store.get(stepId);
    if (!step) return;
    const killed = await this.deps.tmux.killSession(step.tmuxSession);
    const latest = this.mustGet(stepId);
    if (latest.endedAt === null) this.store.update(stepId, { endedAt: this.now() });
    this.store.recordEvent(stepId, "session_closed", { why, killed });
    this.log(`step ${stepId} closed (${why})`);
  }

  // ---------------------------------------------------- liveness, recovery

  /** Marks live steps whose tmux session disappeared without a SessionEnd hook. */
  async sweep(): Promise<void> {
    // Read the live steps before the session list: a step launched while tmux answers
    // is not in this snapshot of steps, so it can never be mistaken for a vanished one.
    const live = this.store.listLive();
    const sessions = new Set(await this.deps.tmux.listSessions());
    for (const step of live) {
      if (step.status === "queued" || sessions.has(step.tmuxSession)) continue;
      if (this.store.get(step.id)?.status !== step.status) continue; // changed meanwhile
      const exitCode = this.readExitCode(step.id);
      this.clearTimeout(step.id);
      this.transition(step.id, "session_ended", { exitReason: "session_vanished", endedAt: this.now() }, { exitCode });
    }
  }

  /**
   * Runs once at startup. Live steps with a tmux session are resumed (timeout
   * re-armed from the stored deadline); the rest are marked as orphaned.
   */
  async reconcile(): Promise<{ resumed: string[]; orphaned: string[] }> {
    const sessions = new Set(await this.deps.tmux.listSessions());
    const resumed: string[] = [];
    const orphaned: string[] = [];
    for (const step of this.store.listLive()) {
      if (step.status !== "queued" && sessions.has(step.tmuxSession)) {
        resumed.push(step.id);
        this.store.recordEvent(step.id, "resumed_after_restart", { status: step.status });
        this.armTimeout(step.id, (step.deadlineAt ?? this.now()) - this.now());
        continue;
      }
      orphaned.push(step.id);
      const reason = step.status === "queued" ? "orphaned_before_launch" : "orphaned_session_missing";
      this.transition(step.id, "orphaned", { exitReason: reason, endedAt: this.now() }, { exitCode: this.readExitCode(step.id) });
    }
    // Sessions of finished steps that were never killed (backend died during the close grace).
    const live = new Set(this.store.listLive().map((s) => s.tmuxSession));
    for (const step of this.store.list()) {
      if (isTerminalStepStatus(step.status) && sessions.has(step.tmuxSession) && !live.has(step.tmuxSession)) {
        await this.close(step.id, "reconcile_finished_step");
        sessions.delete(step.tmuxSession);
      }
    }
    return { resumed, orphaned };
  }

  startSweeper(): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => this.track(this.sweep()), this.deps.config.sweepIntervalMs);
    this.sweepTimer.unref();
  }

  /** Stops timers without touching tmux: sessions must outlive the backend. */
  async shutdown(): Promise<void> {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    await Promise.allSettled([...this.pending]);
  }

  /** Every status change goes through here so the step's owner hears about it. */
  private transition(id: string, event: StepEvent, patch: Parameters<StepStore["transition"]>[2] = {}, payload: Record<string, unknown> = {}) {
    const result = this.store.transition(id, event, patch, payload);
    if (result.ok) this.policy.onStepChanged(this.mustGet(id));
    return result;
  }

  private readExitCode(stepId: string): string | null {
    const file = join(this.deps.config.home, "steps", stepId, "exit-code");
    return existsSync(file) ? readFileSync(file, "utf8").trim() : null;
  }

  track(promise: Promise<unknown>): void {
    const tracked = promise.catch((error: unknown) => this.log("background task failed", { error: String(error) }));
    this.pending.add(tracked);
    void tracked.finally(() => this.pending.delete(tracked));
  }

  private mustGet(id: string): StepRow {
    const row = this.store.get(id);
    if (!row) throw new Error(`Unknown step ${id}`);
    return row;
  }
}
