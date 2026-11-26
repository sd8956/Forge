import { execFile } from "node:child_process";
import { cpSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { isTerminalStepStatus, type ReportStepInput, type StepKind } from "@forge/shared";
import type { ForgeConfig } from "../config.js";
import type { PrThreadStore } from "../db/pr-thread-store.js";
import type { RunStore } from "../db/run-store.js";
import type { MemoryAdapter } from "../memory/memory-adapter.js";
import type { RunRow, StepRow } from "../db/schema.js";
import { decideNext, firstStep, stepsFor, type Attempts, type RunMode, type StepOutcome } from "../domain/next-action.js";
import { isOpenRunStatus } from "../domain/run-machine.js";
import { STEP_CONTRACTS } from "../handoff/contracts.js";
import { parseFrontmatter } from "../handoff/frontmatter.js";
import { outputDirFor, renderInput, type PreviousStep } from "../handoff/input-builder.js";
import { validateReport } from "../handoff/output-validator.js";
import { loadPipeline, modelFor, parseTaskSize, stepById, type Pipeline } from "../pipeline/pipeline.js";
import { runShell } from "../runner/shell.js";
import { branchFor, ensureWorktree } from "../runner/worktree.js";
import type { StepPolicy, StepService } from "../steps/step-service.js";
import { loadProjectConfig } from "../projects/project-config.js";
import { BaseSync, type BaseSyncResult } from "./base-sync.js";
import { parseDependencies, unfinishedDependencyRuns, unmergedDependencies } from "./dependencies.js";
import { taskReviewDepth } from "./review-diff.js";
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
  threads: PrThreadStore;
  memory: MemoryAdapter;
  /** Engram project of a target project path. */
  memoryProject: (projectPath: string) => string;
  /** Why no step may launch right now (the queue is paused), or null. */
  launchHold?: () => string | null;
  /** Brings the project's base branch up to date before a task branches from it. */
  baseSync?: BaseSync;
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

  private readonly baseSync: BaseSync;

  constructor(private readonly deps: Deps) {
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? (() => undefined);
    // Every task start fetches: a merge on GitHub must reach the very next task.
    this.baseSync = deps.baseSync ?? new BaseSync(0);
    deps.steps.policy = this;
  }

  // ------------------------------------------------------------------ start

  async start(req: StartRunRequest): Promise<RunRow> {
    const projectPath = resolve(req.projectPath);
    const pipeline = this.validateProject(projectPath, req.taskId);
    const baseBranch = (await git("git", ["-C", projectPath, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" })).stdout.trim();
    // A task branches from the base: pull what was merged on GitHub first (a clean checkout on the base only).
    const synced = await this.baseSync.sync(projectPath, baseBranch);
    const deps = parseDependencies(readFileSync(join(projectPath, ".factory", "backlog", `${req.taskId}.md`), "utf8"));
    const unfinished = unfinishedDependencyRuns(this.deps.runs.list(), projectPath, deps);
    const unmerged = [...new Set([...unfinished, ...(await unmergedDependencies(projectPath, baseBranch, deps))])];
    if (unmerged.length) {
      const list = unmerged.join(", ");
      throw new RunRequestError(
        `${req.taskId} depends on ${list}, which ${unmerged.length > 1 ? "are" : "is"} not merged into ${baseBranch} yet. Merge ${unmerged.length > 1 ? "their pull requests" : "its pull request"}, update ${baseBranch} in the project and run again.`,
      );
    }
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
    this.recordBaseSync(run.id, baseBranch, synced);
    await this.advance(run.id);
    return this.mustGet(run.id);
  }

  private recordBaseSync(runId: string, base: string, synced: BaseSyncResult): void {
    if (synced.status === "updated") this.deps.runs.recordEvent(runId, "base_updated", { base });
    else if (synced.status === "blocked") this.deps.runs.recordEvent(runId, "base_not_updated", { base, why: synced.why });
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
    if (step.status === "running") {
      // The step that needed a person is working again (a tool ran or the person typed).
      const run = this.deps.runs.get(runId);
      if (run?.status === "needs_human" && this.deps.runs.latestStep(runId)?.id === step.id) {
        this.deps.runs.transition(runId, "resume", {}, { cause: "step_resumed", step: step.kind });
      }
      return;
    }
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
      const action = decideNext(pipeline, run.attempts, outcomeOf(latest), run.mode);
      if (latest.kind === "review_fix" && latest.status === "done") {
        // The report was validated against these threads, so they are answered now.
        this.deps.threads.markHandled(runId, this.deps.threads.unhandled(runId).map((t) => t.externalId), latest.id);
      }
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
    const hold = this.deps.launchHold?.() ?? null;
    if (hold) {
      // The scheduler advances held runs again when the queue resumes.
      runs.recordEvent(runId, "launch_held", { step: run.currentStep, reason: hold });
      return;
    }
    if (!(await this.agentPreflight(run))) return;
    try {
      await this.launch(run, run.currentStep);
    } catch (error) {
      // The step was marked launch_failed; its change event queues the next advance, which fails the run.
      runs.recordEvent(runId, "launch_error", { step: run.currentStep, error: error instanceof Error ? error.message : String(error) });
    }
  }

  private async launch(run: RunRow, kind: StepKind): Promise<StepRow> {
    const pipeline = loadPipeline(run.projectPath);
    const def = stepsFor(pipeline, run.mode).find((s) => s.id === kind) ?? stepById(pipeline, kind);
    const contract = STEP_CONTRACTS[kind];
    const history = this.deps.runs.steps(run.id);
    const attempt = this.attemptFor(run, kind);
    const outputDir = outputDirFor(run.taskId, kind, attempt);
    const rel = (p: string) => relative(run.worktreePath, p);

    const modeSteps = stepsFor(pipeline, run.mode);
    // In review mode the context is the build's plan, design and development, then the review steps so far.
    const order = run.mode === "build" ? pipeline.steps : [...pipeline.steps.filter((s) => !modeSteps.some((m) => m.id === s.id)), ...modeSteps];
    const previous: PreviousStep[] = [];
    for (const step of order) {
      if (step.id === kind) break;
      const done = history.filter((s) => s.kind === step.id && s.status === "done").at(-1);
      if (done) previous.push({ kind: step.id, output: rel(done.outputPath), summary: done.summary ?? "", artifacts: done.artifacts ?? [] });
    }

    const last = run.lastHandledStepId ? history.find((s) => s.id === run.lastHandledStepId) : undefined;
    const lastDef = last ? (modeSteps.find((s) => s.id === last.kind) ?? pipeline.steps.find((s) => s.id === last.kind)) : undefined;
    const failure =
      // A usage limit is not a failure of the work, so the retry gets no failure context.
      last && lastDef && last.status === "failed" && last.exitReason !== "rate_limited"
        ? {
            kind: last.kind as StepKind,
            output: rel(last.outputPath),
            summary: last.summary ?? `The step ended without a report (${last.exitReason ?? "unknown"}).`,
            artifacts: last.artifacts ?? [],
            failures: run.attempts[last.kind as StepKind] ?? 0,
            limit: (last.exitReason === "reported_failed" ? lastDef.on_fail?.max_attempts : undefined) ?? lastDef.max_attempts,
          }
        : undefined;

    const baseCommit = await git("git", ["-C", run.worktreePath, "merge-base", "HEAD", run.baseBranch], { encoding: "utf8" }).then(
      (r) => r.stdout.trim(),
      () => undefined,
    );
    // The backend, never the agent, decides how deep code_review goes (ADR 0015).
    const lenses = kind === "code_review" ? await taskReviewDepth(run.worktreePath, run.baseBranch) : undefined;
    if (lenses) this.deps.runs.recordEvent(run.id, "review_depth", { ...lenses });
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
      baseCommit,
      exit: def.exit,
      previous,
      failure,
      lenses,
      pullRequest: run.prNumber && run.prUrl ? { number: run.prNumber, url: run.prUrl } : undefined,
      threads:
        kind === "review_fix"
          ? this.deps.threads.unhandled(run.id).map((t) => ({
              id: t.externalId,
              kind: t.kind,
              author: t.author,
              location: t.path ? `${t.path}${t.line ? `:${t.line}` : ""}` : null,
              url: t.url,
              body: t.body,
            }))
          : undefined,
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
      permissionMode: this.permissionPolicy(run.projectPath) === "auto" ? "auto" : undefined,
    });
  }

  /** `policies.permission_mode` of the project (ADR 0010); a missing or broken project.yaml keeps the default. */
  private permissionPolicy(projectPath: string): "auto" | "agent" {
    try {
      return loadProjectConfig(projectPath).policies.permission_mode;
    } catch {
      return "auto";
    }
  }

  /** 1-based number of this step kind for the task, across runs, so output directories never collide. */
  private attemptFor(run: RunRow, kind: StepKind): number {
    const dir = join(run.worktreePath, ".factory", "runs", run.taskId, kind);
    let n = 1;
    while (existsSync(join(dir, String(n)))) n++;
    return n;
  }

  /**
   * Claude Code loads agents from the task worktree, so a worktree created before
   * an agent existed cannot run that step. Instead of a failed launch, hand the run
   * to a person with the fix: `forge resume <run> --merge-base`.
   */
  private async agentPreflight(run: RunRow): Promise<boolean> {
    const pipeline = loadPipeline(run.projectPath);
    const def = stepsFor(pipeline, run.mode).find((s) => s.id === run.currentStep) ?? stepById(pipeline, run.currentStep);
    const agentFile = `.claude/agents/${def.agent}.md`;
    if (existsSync(join(run.worktreePath, agentFile))) return true;
    const onBase = await git("git", ["-C", run.projectPath, "cat-file", "-e", `${run.baseBranch}:${agentFile}`]).then(
      () => true,
      () => false,
    );
    this.deps.runs.recordEvent(run.id, "agent_missing", {
      agent: def.agent,
      step: run.currentStep,
      onBase,
      fix: onBase
        ? `Merge ${run.baseBranch} into ${run.branch}: pnpm forge resume ${run.id} --merge-base`
        : `Add ${agentFile} to ${run.baseBranch}, then: pnpm forge resume ${run.id} --merge-base`,
    });
    this.deps.runs.transition(run.id, "attention", { exitReason: `agent_missing:${def.agent}` });
    return false;
  }

  /** Merges the base branch into the task branch (a person asked for it with --merge-base). */
  private async mergeBase(run: RunRow): Promise<{ ok: true } | { ok: false; message: string }> {
    const status = (await git("git", ["-C", run.worktreePath, "status", "--porcelain", "--untracked-files=no"], { encoding: "utf8" })).stdout.trim();
    if (status) return { ok: false, message: `The worktree has uncommitted changes; commit or discard them before merging ${run.baseBranch}.` };
    // Use the repository's own identity; fall back to a neutral one so the merge commit never fails.
    const email = await git("git", ["-C", run.worktreePath, "config", "user.email"], { encoding: "utf8" }).then((r) => r.stdout.trim(), () => "");
    const identity = email ? [] : ["-c", "user.name=Forge", "-c", "user.email=forge@localhost"];
    try {
      await git("git", ["-C", run.worktreePath, ...identity, "merge", "--no-edit", run.baseBranch], { encoding: "utf8" });
    } catch (error) {
      await git("git", ["-C", run.worktreePath, "merge", "--abort"]).catch(() => undefined);
      return { ok: false, message: `Merging ${run.baseBranch} into ${run.branch} conflicts; resolve it by hand in ${run.worktreePath}. ${String((error as { stderr?: string }).stderr ?? "").trim().slice(0, 300)}` };
    }
    const head = (await git("git", ["-C", run.worktreePath, "rev-parse", "--short", "HEAD"], { encoding: "utf8" })).stdout.trim();
    this.deps.runs.recordEvent(run.id, "base_merged", { base: run.baseBranch, head });
    return { ok: true };
  }

  // ------------------------------------------------------- resume, cancel

  async resume(runId: string, opts: { mergeBase?: boolean } = {}): Promise<{ ok: boolean; message: string }> {
    const run = this.deps.runs.get(runId);
    if (!run) return { ok: false, message: `Unknown run ${runId}` };
    if (!isOpenRunStatus(run.status)) return { ok: false, message: `Run is ${run.status}; nothing to resume.` };
    if (opts.mergeBase) {
      const merged = await this.mergeBase(run);
      if (!merged.ok) return merged;
    }

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

  // ------------------------------------------------------------ review loop

  /**
   * The PR watcher found new comments or a failed check: start a review round
   * (review_fix, then the re-verification steps), or hand the run to a person
   * when the rounds are spent.
   */
  async requestReview(runId: string, cause: string): Promise<void> {
    const run = this.mustGet(runId);
    if (run.status !== "waiting_review") return;
    const pipeline = loadPipeline(run.projectPath);
    if (!pipeline.review) {
      this.deps.runs.recordEvent(runId, "review_skipped", { cause, why: "pipeline has no review loop" });
      return;
    }
    const round = run.reviewRound + 1;
    const latest = this.deps.runs.latestStep(runId);
    const mode: RunMode = "review";
    this.deps.runs.transition(
      runId,
      "review_requested",
      { mode, reviewRound: round, currentStep: firstStep(pipeline, mode), attempts: {}, lastHandledStepId: latest?.id ?? null, exitReason: null, endedAt: null },
      { cause, round },
    );
    if (round > pipeline.review.max_rounds) {
      this.deps.runs.transition(runId, "attention", { exitReason: `review_rounds_exhausted:${pipeline.review.max_rounds}` });
      return;
    }
    await this.advance(runId);
  }

  /**
   * The PR was merged: archive the handoffs, remove the worktree and keep what
   * review taught, then mark the run done, so `done` always means cleaned up.
   */
  async onPrMerged(runId: string): Promise<void> {
    const run = this.mustGet(runId);
    if (run.status !== "waiting_review") return;
    const handoffs = join(run.worktreePath, ".factory", "runs", run.taskId);
    if (existsSync(handoffs)) {
      const archive = archiveDirFor(this.deps.config.home, run.id);
      mkdirSync(archive, { recursive: true });
      cpSync(handoffs, archive, { recursive: true });
    }
    const removed = await git("git", ["-C", run.projectPath, "worktree", "remove", "--force", run.worktreePath], { encoding: "utf8" }).then(
      () => true,
      (error: unknown) => {
        this.deps.runs.recordEvent(runId, "worktree_remove_failed", { error: String(error) });
        return false;
      },
    );
    if (removed) this.deps.runs.recordEvent(runId, "worktree_removed", { path: run.worktreePath });

    const handled = this.deps.threads.list(runId).filter((t) => t.handledByStepId && t.kind !== "check");
    if (handled.length) {
      const content = [
        `**What**: Review feedback on ${run.taskId}, merged as PR #${run.prNumber ?? "?"}.`,
        ...handled.map((t) => `- ${t.author ? `@${t.author}` : "CI"}${t.path ? ` on ${t.path}` : ""}: ${t.body.replaceAll("\n", " ").slice(0, 300)}`),
        "**Learned**: reviewers asked for the above; check for it before opening the next PR.",
        `Ref: ${run.taskId}/review`,
      ].join("\n");
      await this.deps.memory
        .save(this.deps.memoryProject(run.projectPath), { title: `Review feedback on ${run.taskId}`, type: "learning", content })
        .then(
          (id) => this.deps.runs.recordEvent(runId, "review_feedback_saved", { observationId: id }),
          (error: unknown) => this.deps.runs.recordEvent(runId, "review_feedback_not_saved", { error: String(error) }),
        );
    }
    this.deps.runs.transition(runId, "merged", { endedAt: this.now(), exitReason: "merged" });
  }

  onPrClosed(runId: string): void {
    this.deps.runs.transition(runId, "pr_closed", { endedAt: this.now(), exitReason: "pr_closed_without_merge" });
  }

  // ------------------------------------------------------------ StepPolicy

  async validateReport(step: StepRow, input: ReportStepInput): Promise<{ ok: true } | { ok: false; issues: string[] }> {
    if (!step.runId) return { ok: true };
    const run = this.mustGet(step.runId);
    const pipeline = loadPipeline(run.projectPath);
    const def = stepsFor(pipeline, run.mode).find((s) => s.id === step.kind) ?? stepById(pipeline, step.kind as StepKind);
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
      threadIds: step.kind === "review_fix" ? this.deps.threads.unhandled(run.id).map((t) => t.externalId) : undefined,
      // Recomputed the same way as at launch: the step never commits, so HEAD has not moved.
      lenses: step.kind === "code_review" ? (await taskReviewDepth(step.worktreePath, run.baseBranch)).lenses : undefined,
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

/** Where a merged run's handoffs are kept once its worktree is removed. */
export function archiveDirFor(home: string, runId: string): string {
  return join(home, "archive", runId);
}

export function outcomeOf(step: StepRow): StepOutcome {
  const kind = step.kind as StepKind;
  if (step.status === "done") return { step: kind, result: "done", cause: "reported" };
  if (step.status === "blocked") return { step: kind, result: "blocked", cause: "reported" };
  if (step.exitReason === "reported_failed") return { step: kind, result: "failed", cause: "reported" };
  if (step.exitReason === "launch_failed") return { step: kind, result: "failed", cause: "launch" };
  if (step.exitReason === "rate_limited") return { step: kind, result: "failed", cause: "rate_limit" };
  return { step: kind, result: "failed", cause: "infrastructure" };
}

