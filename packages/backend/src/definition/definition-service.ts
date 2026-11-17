import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { DEFINITION_STAGES, type DefinitionStage, type DefinitionView, type ReportStepInput } from "@forge/shared";
import { parse } from "yaml";
import type { ForgeConfig } from "../config.js";
import type { DefinitionStore } from "../db/definition-store.js";
import type { ProjectStore } from "../db/project-store.js";
import type { DefinitionRow, StepRow } from "../db/schema.js";
import type { StepStore } from "../db/step-store.js";
import { nextStage, stageAgent, stageKind, stageOfKind } from "../domain/definition.js";
import { prototypeScreens, validateStage, type FactoryFiles } from "../domain/definition-validators.js";
import { isTrusted } from "../runs/trust.js";
import type { StepService } from "../steps/step-service.js";
import { renderStageInput } from "./stage-input.js";
import { copyTemplate, renameMemoryProject } from "./template.js";

const git = promisify(execFile);
export const DEFINITION_BRANCH = "forge/definition";

export class DefinitionError extends Error {}

interface Deps {
  config: ForgeConfig;
  store: DefinitionStore;
  steps: StepService;
  stepStore: StepStore;
  projects: ProjectStore;
  now?: () => number;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}

/** Every file under `.factory/` of a worktree except run handoffs, keyed by repo-relative path. */
export function readFactory(worktree: string): FactoryFiles {
  const files: FactoryFiles = {};
  const walk = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      const rel = relative(worktree, path);
      if (rel === ".factory/runs" || rel === ".factory/steps") continue;
      if (statSync(path).isDirectory()) walk(path);
      else if (statSync(path).size <= 512 * 1024) files[rel] = readFileSync(path, "utf8");
    }
  };
  walk(join(worktree, ".factory"));
  return files;
}

/**
 * Runs a project's definition: six stages, each a Claude Code session in the
 * definition worktree, each ending in a person's gate. Sessions only write
 * `.factory/`; Forge copies its template, commits approved stages and opens
 * the definition pull request. The stage status moves only through the table.
 */
export class DefinitionService {
  private ready = false;
  private readonly now: () => number;

  constructor(private readonly deps: Deps) {
    this.now = deps.now ?? Date.now;
  }

  // ------------------------------------------------------------------ begin

  async begin(path: string, idea: string): Promise<DefinitionView> {
    const repoPath = resolve(path);
    if (!isAbsolute(path) || !existsSync(repoPath) || !statSync(repoPath).isDirectory()) throw new DefinitionError(`Not a directory: ${repoPath}`);
    if (!existsSync(join(repoPath, ".git"))) throw new DefinitionError(`Not a git repository: ${repoPath}. Clone it or run git init there first.`);
    if (this.deps.config.checkTrust && !isTrusted(this.deps.config.claudeConfigFile, repoPath)) {
      throw new DefinitionError(`Claude Code does not trust ${repoPath} yet. Run \`claude\` in that folder once and accept the trust dialog.`);
    }
    const existing = this.deps.projects.getByPath(repoPath);
    if (existing && this.deps.store.get(existing.id)) throw new DefinitionError(`${repoPath} already has a definition`);
    if (existsSync(join(repoPath, ".factory", "project.yaml"))) throw new DefinitionError(`${repoPath} already has a .factory/project.yaml; it is defined already.`);

    // Worktrees need a commit to branch from; an empty clone has none yet.
    if (!(await this.git(repoPath, ["rev-parse", "--verify", "HEAD"]).then(() => true, () => false))) {
      await this.git(repoPath, [...(await this.identity(repoPath)), "commit", "--allow-empty", "-q", "-m", "chore: start the project"]);
    }
    const worktreePath = join(repoPath, ".worktrees", "definition");
    if (!existsSync(worktreePath)) {
      const branchExists = await this.git(repoPath, ["rev-parse", "--verify", DEFINITION_BRANCH]).then(() => true, () => false);
      await this.git(repoPath, ["worktree", "add", "-q", ...(branchExists ? [worktreePath, DEFINITION_BRANCH] : ["-b", DEFINITION_BRANCH, worktreePath])]);
    }
    // The worktree lives inside the repo; keep it out of `git status` without touching tracked files.
    this.exclude(repoPath, ".worktrees/");

    const name = basename(repoPath).toLowerCase().replace(/[^a-z0-9-]+/g, "-");
    copyTemplate(this.deps.config.templateDir, worktreePath, name);
    await this.commit(worktreePath, ["."], "chore: add the Forge template");

    const project = this.deps.projects.upsert(repoPath, { fallbackName: name });
    this.deps.store.create({ projectId: project.id, repoPath, worktreePath, branch: DEFINITION_BRANCH, idea });
    this.deps.store.recordEvent(project.id, "definition_started", { repoPath });
    await this.startStage(project.id, "intake");
    return this.view(project.id);
  }

  // ----------------------------------------------------------------- stages

  async startStage(projectId: string, stage: DefinitionStage): Promise<void> {
    const def = this.mustGet(projectId);
    const row = this.deps.store.stage(projectId, stage);
    const kind = stageKind(stage);
    const taskId = `DEF-${projectId.slice(0, 8)}`;
    const attempt = this.attemptFor(def, taskId, kind);
    const outputDir = `.factory/runs/${taskId}/${kind}/${attempt}`;
    const previous = row.stepId ? this.deps.stepStore.get(row.stepId) : undefined;
    const approved = this.deps.store
      .stages(projectId)
      .filter((s) => s.status === "approved")
      .map((s) => ({ stage: s.stage, summary: s.summary }));
    const input = renderStageInput({
      stage,
      stepKind: kind,
      taskId,
      attempt,
      outputDir,
      idea: def.idea,
      approved,
      changes: row.status === "changes_requested" && row.feedback ? { feedback: row.feedback, previousOutput: previous ? relative(def.worktreePath, previous.outputPath) : null } : undefined,
    });
    const stepId = randomUUID();
    if (!this.deps.store.transition(projectId, stage, "start", { stepId, lastError: null })) {
      throw new DefinitionError(`${stage} is ${row.status}; it cannot start`);
    }
    try {
      await this.deps.steps.start({
        id: stepId,
        runId: null,
        projectPath: def.repoPath,
        taskId,
        kind,
        attempt,
        agent: stageAgent(stage),
        model: "opus",
        worktreePath: def.worktreePath,
        settingsTemplate: join(def.worktreePath, ".factory", "steps", "definition.settings.json"),
        inputPath: join(def.worktreePath, outputDir, "input.md"),
        outputPath: join(def.worktreePath, outputDir, "output.md"),
        input,
        prompt: `Read ${join(def.worktreePath, outputDir, "input.md")} and run the step it describes.`,
        // Stages talk with the person, so they get twice a step's time.
        timeoutMs: this.deps.config.defaultTimeoutMs * 2,
      });
    } catch (error) {
      // The step failed to launch: its status change already moved the stage back to pending.
      this.deps.log?.(`definition stage ${stage} did not launch`, { error: String(error) });
    }
  }

  /** report_stage: the files the stage must leave are checked before the person sees them. */
  validateReport(step: StepRow, input: ReportStepInput): Promise<{ ok: true } | { ok: false; issues: string[] }> {
    const stage = stageOfKind(step.kind);
    if (!stage || input.status !== "done") return Promise.resolve({ ok: true });
    const issues: string[] = [];
    if (!existsSync(step.outputPath)) issues.push(`${relative(step.worktreePath, step.outputPath)} is missing`);
    const result = validateStage(stage, readFactory(step.worktreePath));
    if (!result.ok) issues.push(...result.issues);
    return Promise.resolve(issues.length ? { ok: false, issues } : { ok: true });
  }

  onStepChanged(step: StepRow): void {
    if (!this.ready) return;
    this.apply(step);
  }

  private apply(step: StepRow): void {
    const row = this.deps.store.byStep(step.id);
    if (!row || row.status !== "running") return;
    if (step.status === "done") {
      const result = validateStage(row.stage, readFactory(step.worktreePath));
      this.deps.store.transition(row.projectId, row.stage, "report", { summary: result.ok ? result.summary : null, feedback: null }, { stepId: step.id });
    } else if (step.status === "failed" || step.status === "blocked") {
      const why = step.status === "blocked" ? `The session reported blocked: ${step.summary ?? ""}`.trim() : `The session ended without a valid report (${step.exitReason ?? "unknown"}).`;
      this.deps.store.transition(row.projectId, row.stage, "session_failed", { lastError: why }, { stepId: step.id });
    }
  }

  /** Called after listen: applies outcomes of stage sessions that ended while the backend was down. */
  reconcile(): void {
    this.ready = true;
    for (const def of this.deps.store.list()) {
      for (const row of this.deps.store.stages(def.projectId)) {
        const step = row.stepId ? this.deps.stepStore.get(row.stepId) : undefined;
        if (step) this.apply(step);
      }
    }
  }

  async retry(projectId: string, stage: DefinitionStage): Promise<void> {
    if (this.deps.store.stage(projectId, stage).status !== "pending") throw new DefinitionError(`${stage} is not waiting to start`);
    this.ensureTurn(projectId, stage);
    await this.startStage(projectId, stage);
  }

  // ------------------------------------------------------------------- gate

  approveScreen(projectId: string, screen: string): void {
    const def = this.mustGet(projectId);
    const row = this.deps.store.stage(projectId, "design");
    if (row.status !== "in_review") throw new DefinitionError("The design is not in review");
    if (!prototypeScreens(Object.keys(readFactory(def.worktreePath))).includes(screen)) throw new DefinitionError(`Unknown screen ${screen}`);
    this.deps.store.update(projectId, "design", { approvedScreens: [...new Set([...row.approvedScreens, screen])] });
    this.deps.store.recordEvent(projectId, "screen_approved", { screen });
  }

  async approve(projectId: string, stage: DefinitionStage): Promise<DefinitionView> {
    const def = this.mustGet(projectId);
    const row = this.deps.store.stage(projectId, stage);
    if (row.status !== "in_review") throw new DefinitionError(`${stage} is ${row.status}, not in review`);
    const files = readFactory(def.worktreePath);
    const result = validateStage(stage, files);
    if (!result.ok) throw new DefinitionError(`The ${stage} files changed and no longer pass: ${result.issues.join("; ")}`);
    if (stage === "design") {
      const left = prototypeScreens(Object.keys(files)).filter((s) => !row.approvedScreens.includes(s));
      if (left.length) throw new DefinitionError(`Approve every screen first: ${left.join(", ")}`);
    }
    if (stage === "intake") {
      // The project name is decided at intake; point the agents' memory at it.
      const name = (parse(files[".factory/project.yaml"] ?? "") as { name?: string } | null)?.name;
      if (name) renameMemoryProject(def.worktreePath, name);
    }
    const commit = await this.commit(def.worktreePath, [".factory", ".claude"], `docs(definition): approve the ${stage.replace("_", " ")}`);
    this.deps.store.transition(projectId, stage, "approve", { approvedAt: this.now(), commit, summary: result.summary });
    const next = nextStage(stage);
    if (next) await this.startStage(projectId, next);
    else await this.openPullRequest(def);
    return this.view(projectId);
  }

  async requestChanges(projectId: string, stage: DefinitionStage, feedback: string): Promise<DefinitionView> {
    if (!this.deps.store.transition(projectId, stage, "request_changes", { feedback, approvedScreens: [] })) {
      throw new DefinitionError(`${stage} is ${this.deps.store.stage(projectId, stage).status}, not in review`);
    }
    await this.startStage(projectId, stage);
    return this.view(projectId);
  }

  private async openPullRequest(def: DefinitionRow): Promise<void> {
    try {
      await this.git(def.worktreePath, ["push", "-q", "-u", "origin", DEFINITION_BRANCH]);
      const base = (await this.git(def.repoPath, ["rev-parse", "--abbrev-ref", "HEAD"])).trim() || "main";
      const stages = this.deps.store.stages(def.projectId).map((s) => `- ${s.stage.replace("_", " ")}: ${s.summary ?? "approved"} (${s.commit ?? ""})`);
      const body = ["Project definition approved stage by stage in the Forge panel.", "", ...stages, "", "Merge it to let the Execution panel plan and run the backlog."].join("\n");
      const { stdout } = await promisify(execFile)(this.deps.config.ghBin, ["pr", "create", "--base", base, "--head", DEFINITION_BRANCH, "--title", "docs: project definition", "--body", body], {
        cwd: def.worktreePath,
        encoding: "utf8",
      });
      const url = /https:\/\/\S+/.exec(stdout)?.[0] ?? stdout.trim();
      this.deps.store.setPrUrl(def.projectId, url);
      this.deps.store.recordEvent(def.projectId, "definition_pr_opened", { url });
    } catch (error) {
      this.deps.store.recordEvent(def.projectId, "definition_pr_failed", { error: String((error as { stderr?: string }).stderr ?? error).slice(0, 500) });
    }
  }

  // ------------------------------------------------------------------- view

  view(projectId: string): DefinitionView {
    const def = this.mustGet(projectId);
    const files = Object.keys(readFactory(def.worktreePath)).sort();
    return {
      projectId,
      repoPath: def.repoPath,
      worktreePath: def.worktreePath,
      branch: def.branch,
      idea: def.idea,
      prUrl: def.prUrl,
      files,
      prototypeScreens: prototypeScreens(files),
      stages: this.deps.store.stages(projectId).map((s) => ({
        stage: s.stage,
        status: s.status,
        summary: s.summary,
        stepId: s.stepId,
        feedback: s.feedback,
        lastError: s.lastError,
        approvedScreens: s.approvedScreens,
        approvedAt: s.approvedAt,
        commit: s.commit,
      })),
    };
  }

  /** A file of the definition worktree, only under `.factory/` (never handoffs or settings). */
  filePath(projectId: string, path: string): string | null {
    const def = this.mustGet(projectId);
    const root = join(def.worktreePath, ".factory");
    const full = resolve(def.worktreePath, path);
    const rel = relative(root, full);
    if (rel.startsWith("..") || isAbsolute(rel) || rel.startsWith("runs") || rel.startsWith("steps")) return null;
    return existsSync(full) && statSync(full).isFile() ? full : null;
  }

  get(projectId: string): DefinitionRow | undefined {
    return this.deps.store.get(projectId);
  }

  list(): { projectId: string; repoPath: string; prUrl: string | null }[] {
    return this.deps.store.list().map((d) => ({ projectId: d.projectId, repoPath: d.repoPath, prUrl: d.prUrl }));
  }

  // -------------------------------------------------------------- internals

  private ensureTurn(projectId: string, stage: DefinitionStage): void {
    const index = DEFINITION_STAGES.indexOf(stage);
    const earlier = this.deps.store.stages(projectId).slice(0, index);
    if (earlier.some((s) => s.status !== "approved")) throw new DefinitionError(`Approve the earlier stages before ${stage}`);
  }

  private mustGet(projectId: string): DefinitionRow {
    const def = this.deps.store.get(projectId);
    if (!def) throw new DefinitionError(`No definition for project ${projectId}`);
    return def;
  }

  private attemptFor(def: DefinitionRow, taskId: string, kind: string): number {
    const dir = join(def.worktreePath, ".factory", "runs", taskId, kind);
    let n = 1;
    while (existsSync(join(dir, String(n)))) n++;
    return n;
  }

  private async git(cwd: string, args: string[]): Promise<string> {
    return (await git("git", ["-C", cwd, ...args], { encoding: "utf8" })).stdout;
  }

  private async identity(cwd: string): Promise<string[]> {
    const email = await this.git(cwd, ["config", "user.email"]).then((s) => s.trim(), () => "");
    return email ? [] : ["-c", "user.name=Forge", "-c", "user.email=forge@localhost"];
  }

  /** Commits the given paths if they changed; returns the short commit of HEAD. */
  private async commit(cwd: string, paths: string[], message: string): Promise<string> {
    await this.git(cwd, ["add", "--", ...paths.filter((p) => p === "." || existsSync(join(cwd, p)))]);
    const staged = await this.git(cwd, ["diff", "--cached", "--quiet"]).then(() => false, () => true);
    if (staged) await this.git(cwd, [...(await this.identity(cwd)), "commit", "-q", "-m", message]);
    return (await this.git(cwd, ["rev-parse", "--short", "HEAD"])).trim();
  }

  private exclude(repoPath: string, pattern: string): void {
    const file = join(repoPath, ".git", "info", "exclude");
    try {
      const text = existsSync(file) ? readFileSync(file, "utf8") : "";
      if (!text.split("\n").includes(pattern)) {
        appendFileSync(file, `${text.endsWith("\n") || !text ? "" : "\n"}${pattern}\n`);
      }
    } catch {
      // Not fatal: the worktree just shows up as untracked.
    }
  }
}
