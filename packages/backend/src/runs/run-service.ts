import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { isTerminalStepStatus, type ReportStepInput, type StepKind } from "@forge/shared";
import type { ForgeConfig } from "../config.js";
import type { RunStore } from "../db/run-store.js";
import type { RunRow, StepRow } from "../db/schema.js";
import { decideNext, firstStep, type Attempts, type StepOutcome } from "../domain/next-action.js";
import { isOpenRunStatus } from "../domain/run-machine.js";
import { STEP_CONTRACTS } from "../handoff/contracts.js";
import { parseFrontmatter } from "../handoff/frontmatter.js";
import { outputDirFor, renderInput, type PreviousStep } from "../handoff/input-builder.js";
import { validateReport } from "../handoff/output-validator.js";
import { loadPipeline, modelFor, parseTaskSize, stepById, type Pipeline } from "../pipeline/pipeline.js";
import { runShell } from "../runner/shell.js";
import { branchFor, ensureWorktree } from "../runner/worktree.js";
import type { StepPolicy, StepService } from "../steps/step-service.js";
import { isTrusted } from "./trust.js";

const git = promisify(execFile);

export class RunRequestError extends Error {}

export interface StartRunRequest {
  projectPath: string;
  taskId: string;
}

interface Deps {
  config: ForgeConfig;
  runs: RunStore;
  steps: StepService;
  now?: () => number;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}

/**
 * Drives a task through the pipeline. The LLM never moves the run: each step
 * ends through report_step or a hook, and this service applies the pure
 * decision in `decideNext` and launches the next step.
 */
export class RunService implements StepPolicy {
  private ready = false;
  private readonly chains = new Map<string, Promise<void>>();
  private readonly now: () => number;
  private readonly log: NonNullable<Deps["log"]>;

  constructor(private readonly deps: Deps) {
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? (() => undefined);
    deps.steps.policy = this;
  }

  // ------------------------------------------------------------------ start

  async start(req: StartRunRequest): Promise<RunRow> {
    const projectPath = resolve(req.projectPath);
    const pipeline = this.validateProject(projectPath, req.taskId);
    const baseBranch = (await git("git", ["-C", projectPath, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" })).stdout.trim();
    const worktreePath = await ensureWorktree(projectPath, req.taskId);
    const run = this.deps.runs.insert({
      id: randomUUID(),
      projectPath,
      taskId: req.taskId,
      worktreePath,
      branch: branchFor(req.taskId),
      baseBranch,
      currentStep: firstStep(pipeline),
    });
    await this.advance(run.id);
    return this.mustGet(run.id);
  }

  private validateProject(projectPath: string, taskId: string): Pipeline {
    if (!isAbsolute(projectPath) || !existsSync(projectPath) || !statSync(projectPath).isDirectory()) {
      throw new RunRequestError(`Project path is not a directory: ${projectPath}`);
    }
    if (!existsSync(join(projectPath, ".git"))) throw new RunRequestError(`Project is not a git repository: ${projectPath}`);
    if (!existsSync(join(projectPath, ".factory", "project.yaml"))) throw new RunRequestError(`Missing .factory/project.yaml in ${projectPath}`);
    if (!existsSync(join(projectPath, ".factory", "backlog", `${taskId}.md`))) throw new RunRequestError(`Missing .factory/backlog/${taskId}.md in ${projectPath}`);
    if (this.deps.config.checkTrust && !isTrusted(this.deps.config.claudeConfigFile, projectPath)) {
      throw new RunRequestError(
        `Claude Code does not trust ${projectPath} yet. Run \`claude\` in that folder once and accept the trust dialog; task worktrees inherit it.`,
      );
    }
    try {
      return loadPipeline(projectPath);
    } catch (error) {
      throw new RunRequestError(error instanceof Error ? error.message : String(error));
    }
  }

  // ---------------------------------------------------------------- advance

  /** Called after listen: advances every open run once (idempotent). */
  async reconcile(): Promise<void> {
    this.ready = true;
    for (const run of this.deps.runs.listOpen()) await this.advance(run.id);
  }

  onStepChanged(step: StepRow): void {
    if (!step.runId || !this.ready) return;
    const runId = step.runId;
    if (step.status === "needs_human") {
      const run = this.deps.runs.get(runId);
      if (run?.status === "running") this.deps.runs.transition(runId, "attention", {}, { cause: "step_needs_human", step: step.kind });
      return;
    }
    if (isTerminalStepStatus(step.status)) this.deps.steps.track(this.advance(runId));
  }

  /** Serialized per run, so two events never advance the same run twice. */
  advance(runId: string): Promise<void> {
    const previous = this.chains.get(runId) ?? Promise.resolve();
    const next = previous.then(() => this.advanceNow(runId)).catch((error: unknown) => {
      this.log("advance failed", { runId, error: String(error) });
      this.deps.runs.recordEvent(runId, "advance_failed", { error: String(error) });
    });
    this.chains.set(runId, next);
    return next;
  }

  private async advanceNow(runId: string): Promise<void> {
    const runs = this.deps.runs;
    let run = this.mustGet(runId);
    if (!isOpenRunStatus(run.status)) return;

    const latest = runs.latestStep(runId);
    if (latest && !isTerminalStepStatus(latest.status)) {
      if (latest.status === "needs_human" && run.status === "running") runs.transition(runId, "attention", {}, { cause: "step_needs_human", step: latest.kind });
      return;
    }
    if (run.status === "queued") runs.transition(runId, "start");

    if (latest && latest.id !== run.lastHandledStepId) {
      const pipeline = loadPipeline(run.projectPath);
      const action = decideNext(pipeline, run.attempts, outcomeOf(latest));
      runs.recordEvent(runId, "step_outcome", { step: latest.kind, stepId: latest.id, status: latest.status, exitReason: latest.exitReason, action: action.kind });
      run = this.mustGet(runId);
      // The step that needed a person has finished: the run is back on track.
      if (run.status === "needs_human") runs.transition(runId, "resume", {}, { cause: "step_finished" });
      const handled = { lastHandledStepId: latest.id };
      switch (action.kind) {
        case "launch":
          runs.update(runId, { ...handled, attempts: action.attempts, currentStep: action.step });
          break;
        case "complete": {
          const pr = this.prOf(latest);
          runs.transition(runId, "complete", { ...handled, attempts: action.attempts, endedAt: this.now(), exitReason: "completed", ...pr });
          return;
        }
        case "needs_human":
          runs.transition(runId, "attention", { ...handled, attempts: action.attempts, currentStep: action.step, exitReason: `${action.reason}:${action.step}` });
          return;
        case "fail":
          runs.transition(runId, "fail", { ...handled, endedAt: this.now(), exitReason: `${action.reason}:${action.step}` });
          return;
      }
    }

    run = this.mustGet(runId);
    if (run.status !== "running") return;
    try {
      await this.launch(run, run.currentStep);
    } catch (error) {
      // The step was marked launch_failed; its change event queues the next advance, which fails the run.
      runs.recordEvent(runId, "launch_error", { step: run.currentStep, error: error instanceof Error ? error.message : String(error) });
    }
  }

  private async launch(run: RunRow, kind: StepKind): Promise<StepRow> {
    const pipeline = loadPipeline(run.projectPath);
    const def = stepById(pipeline, kind);
    const contract = STEP_CONTRACTS[kind];
    const history = this.deps.runs.steps(run.id);
    const attempt = this.attemptFor(run, kind);
    const outputDir = outputDirFor(run.taskId, kind, attempt);
    const rel = (p: string) => relative(run.worktreePath, p);

    const previous: PreviousStep[] = [];
    for (const step of pipeline.steps) {
      if (step.id === kind) break;
      const done = history.filter((s) => s.kind === step.id && s.status === "done").at(-1);
      if (done) previous.push({ kind: step.id, output: rel(done.outputPath), summary: done.summary ?? "", artifacts: done.artifacts ?? [] });
    }

    const last = run.lastHandledStepId ? history.find((s) => s.id === run.lastHandledStepId) : undefined;
    const lastDef = last ? pipeline.steps.find((s) => s.id === last.kind) : undefined;
    const failure =
      last && lastDef && last.status === "failed"
        ? {
            kind: last.kind as StepKind,
            output: rel(last.outputPath),
            summary: last.summary ?? `The step ended without a report (${last.exitReason ?? "unknown"}).`,
            artifacts: last.artifacts ?? [],
            failures: run.attempts[last.kind as StepKind] ?? 0,
            limit: (last.exitReason === "reported_failed" ? lastDef.on_fail?.max_attempts : undefined) ?? lastDef.max_attempts,
          }
        : undefined;

    const taskSpec = `.factory/backlog/${run.taskId}.md`;
    const size = parseTaskSize(/^\s*-\s*Size:\s*([SML])\b/m.exec(this.readOptional(join(run.worktreePath, taskSpec)))?.[1]);
    const inputPath = join(run.worktreePath, outputDir, "input.md");
    const stepId = randomUUID();
    const input = renderInput({
      runId: run.id,
      stepId,
      kind,
      attempt,
      agent: def.agent,
      taskId: run.taskId,
      taskSpec,
      outputDir,
      reads: contract.reads.filter((r) => existsSync(join(run.worktreePath, r))),
      branch: run.branch,
      baseBranch: run.baseBranch,
      exit: def.exit,
      previous,
      failure,
    });

    return this.deps.steps.start({
      id: stepId,
      runId: run.id,
      projectPath: run.projectPath,
      taskId: run.taskId,
      kind,
      attempt,
      agent: def.agent,
      model: modelFor(def, size),
      worktreePath: run.worktreePath,
      settingsTemplate: join(run.projectPath, ".factory", def.settings),
      inputPath,
      outputPath: join(run.worktreePath, outputDir, "output.md"),
      input,
      prompt: `Read ${outputDir}/input.md and run the step.`,
      timeoutMs: Math.round(def.timeout_minutes * 60_000),
    });
  }

  /** 1-based number of this step kind for the task, across runs, so output directories never collide. */
  private attemptFor(run: RunRow, kind: StepKind): number {
    const dir = join(run.worktreePath, ".factory", "runs", run.taskId, kind);
    let n = 1;
    while (existsSync(join(dir, String(n)))) n++;
    return n;
  }

  // ------------------------------------------------------- resume, cancel

  async resume(runId: string): Promise<{ ok: boolean; message: string }> {
    const run = this.deps.runs.get(runId);
    if (!run) return { ok: false, message: `Unknown run ${runId}` };
    if (!isOpenRunStatus(run.status)) return { ok: false, message: `Run is ${run.status}; nothing to resume.` };

    const latest = this.deps.runs.latestStep(runId);
    if (latest && !isTerminalStepStatus(latest.status) && (await this.deps.steps.isSessionAlive(latest))) {
      const hint = latest.status === "needs_human" ? " It is waiting for a person: attach and answer." : "";
      return { ok: true, message: `Step ${latest.kind} is still live in tmux session ${latest.tmuxSession}; nothing to relaunch.${hint}` };
    }
    if (latest && !isTerminalStepStatus(latest.status)) await this.deps.steps.sweep();

    if (run.status === "needs_human") {
      // A person looked at it: give the stuck step a fresh budget and run it again.
      const attempts: Attempts = { ...run.attempts };
      const exhausted = /^attempts_exhausted:(.+)$/.exec(run.exitReason ?? "")?.[1] as StepKind | undefined;
      if (exhausted) attempts[exhausted] = 0;
      this.deps.runs.transition(runId, "resume", { attempts, exitReason: null }, { cause: "manual_resume" });
    }
    this.deps.runs.recordEvent(runId, "resume_requested", {});
    await this.advance(runId);
    const after = this.mustGet(runId);
    return { ok: true, message: `Run is ${after.status}; current step ${after.currentStep}.` };
  }

  async cancel(runId: string): Promise<{ ok: boolean; message: string }> {
    const run = this.deps.runs.get(runId);
    if (!run) return { ok: false, message: `Unknown run ${runId}` };
    const result = this.deps.runs.transition(runId, "cancel", { endedAt: this.now(), exitReason: "cancelled" });
    if (!result.ok) return { ok: false, message: `Run is ${run.status}; it cannot be cancelled.` };
    const latest = this.deps.runs.latestStep(runId);
    if (latest && !isTerminalStepStatus(latest.status)) await this.deps.steps.cancel(latest.id);
    return { ok: true, message: "Run cancelled." };
  }

  // ------------------------------------------------------------ StepPolicy

  async validateReport(step: StepRow, input: ReportStepInput): Promise<{ ok: true } | { ok: false; issues: string[] }> {
    if (!step.runId) return { ok: true };
    const run = this.mustGet(step.runId);
    const pipeline = loadPipeline(run.projectPath);
    const def = stepById(pipeline, step.kind as StepKind);
    const plan = this.deps.runs.steps(run.id).filter((s) => s.kind === "plan" && s.status === "done").at(-1);
    const result = await validateReport({
      kind: step.kind as StepKind,
      taskId: step.taskId,
      attempt: step.attempt,
      worktreePath: step.worktreePath,
      outputDir: dirname(step.outputPath),
      exit: def.exit,
      reported: input,
      taskSpecPath: join(step.worktreePath, ".factory", "backlog", `${step.taskId}.md`),
      testPlanPath: plan ? join(dirname(plan.outputPath), "test-plan.md") : undefined,
      runCommand: (command, cwd) => runShell(command, cwd, this.deps.config.checkTimeoutMs),
    });
    return result.ok ? { ok: true } : result;
  }

  /** The development Stop hook runs the exit command and shows its result in the reminder. */
  async stopCheck(step: StepRow): Promise<string | null> {
    if (!step.runId) return null;
    const run = this.mustGet(step.runId);
    const command = stepById(loadPipeline(run.projectPath), step.kind as StepKind).exit.command;
    if (!command) return null;
    const result = await runShell(command, step.worktreePath, this.deps.config.checkTimeoutMs);
    return result.ok ? `\`${command}\` is green.` : `\`${command}\` is red. Fix it before reporting done:\n${result.output}`;
  }

  // ---------------------------------------------------------------- helpers

  private prOf(step: StepRow): { prUrl?: string; prNumber?: number } {
    if (step.kind !== "pr") return {};
    const parsed = parseFrontmatter(this.readOptional(step.outputPath));
    if (!parsed.ok) return {};
    const data = parsed.data as { pr_url?: unknown; pr_number?: unknown };
    return {
      ...(typeof data.pr_url === "string" ? { prUrl: data.pr_url } : {}),
      ...(typeof data.pr_number === "number" ? { prNumber: data.pr_number } : {}),
    };
  }

  private readOptional(file: string): string {
    return existsSync(file) ? readFileSync(file, "utf8") : "";
  }

  private mustGet(id: string): RunRow {
    const row = this.deps.runs.get(id);
    if (!row) throw new Error(`Unknown run ${id}`);
    return row;
  }
}

export function outcomeOf(step: StepRow): StepOutcome {
  const kind = step.kind as StepKind;
  if (step.status === "done") return { step: kind, result: "done", cause: "reported" };
  if (step.status === "blocked") return { step: kind, result: "blocked", cause: "reported" };
  if (step.exitReason === "reported_failed") return { step: kind, result: "failed", cause: "reported" };
  if (step.exitReason === "launch_failed") return { step: kind, result: "failed", cause: "launch" };
  return { step: kind, result: "failed", cause: "infrastructure" };
}

