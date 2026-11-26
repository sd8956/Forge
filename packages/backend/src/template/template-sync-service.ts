import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { parse } from "yaml";
import type { ForgeConfig } from "../config.js";
import type { PlanStore } from "../db/plan-store.js";
import type { ProjectStore } from "../db/project-store.js";
import type { ProjectRow } from "../db/schema.js";
import { slugFromRemote } from "../github/pr-diff.js";
import { applySync, planSync, templateHistory } from "./template-sync.js";

const run = promisify(execFile);
export const SYNC_BRANCH = "forge/template-update";
const PR_TITLE = "chore: update Forge files";

export interface TemplateSyncResult {
  /** pr_opened: a new PR; pr_updated: the open PR got a new commit; pr_open: the open PR already has it. */
  status: "up_to_date" | "pr_opened" | "pr_updated" | "pr_open" | "skipped" | "failed";
  reason?: string;
  prUrl: string | null;
  updated: string[];
  added: string[];
  customized: string[];
  checkedAt: number;
}

interface Deps {
  config: ForgeConfig;
  projects: ProjectStore;
  plans: PlanStore;
  now?: () => number;
}

/**
 * Keeps a project's Forge files (agents, skills, pipeline, step settings) on the latest template, through a PR the
 * person merges. The changes are prepared in a worktree from origin/<base>, so the person's checkout never changes,
 * and files the project changed itself are listed, never overwritten.
 */
export class TemplateSyncService {
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<unknown> = Promise.resolve();
  private readonly now: () => number;

  constructor(private readonly deps: Deps) {
    this.now = deps.now ?? Date.now;
  }

  /** Checks every project now and then every `intervalMs`. */
  start(intervalMs: number): void {
    if (this.timer) return;
    const all = () => {
      for (const project of this.deps.projects.list()) void this.sync(project);
    };
    all();
    this.timer = setInterval(all, intervalMs);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.running.catch(() => undefined);
  }

  last(projectId: string): TemplateSyncResult | null {
    return this.deps.plans.getSetting<TemplateSyncResult>(`template.${projectId}`) ?? null;
  }

  /** One sync at a time: they share git worktrees and the gh CLI. */
  sync(project: ProjectRow): Promise<TemplateSyncResult> {
    const next = this.running.catch(() => undefined).then(() => this.syncNow(project));
    this.running = next;
    return next;
  }

  private async syncNow(project: ProjectRow): Promise<TemplateSyncResult> {
    const base: Omit<TemplateSyncResult, "status"> = { prUrl: null, updated: [], added: [], customized: [], checkedAt: this.now() };
    const done = (result: TemplateSyncResult) => {
      this.deps.plans.setSetting(`template.${project.id}`, result);
      this.deps.plans.recordEvent("plan", project.id, "template_sync", { status: result.status, reason: result.reason ?? null, prUrl: result.prUrl });
      return result;
    };
    const repo = project.repoPath;
    // The configured URL, before any url.<x>.insteadOf rewriting.
    const remote = await this.git(repo, ["config", "--get", "remote.origin.url"]).catch(() => "");
    const slug = slugFromRemote(remote.trim());
    if (!slug) return done({ ...base, status: "skipped", reason: "The project has no GitHub remote" });
    if (!existsSync(join(repo, ".factory", "project.yaml"))) return done({ ...base, status: "skipped", reason: "The project is still being defined" });
    const branch = project.defaultBranch || "main";
    const worktree = join(repo, ".worktrees", "forge-template");
    try {
      await this.git(repo, ["fetch", "-q", "origin", branch]);
      await this.git(repo, ["worktree", "remove", "--force", worktree]).catch(() => undefined);
      await this.git(repo, ["worktree", "add", "-q", "-B", SYNC_BRANCH, worktree, `origin/${branch}`]);

      const name = (parse(readFileSync(join(worktree, ".factory", "project.yaml"), "utf8")) as { name?: string } | null)?.name ?? project.name;
      const templateDir = this.deps.config.templateDir;
      const plan = await planSync({ templateDir, projectRoot: worktree, projectName: name, history: (f) => templateHistory(templateDir, f) });
      const found = { updated: plan.update, added: plan.add, customized: plan.customized };
      if (plan.update.length + plan.add.length === 0) return done({ ...base, ...found, status: "up_to_date" });

      applySync({ templateDir, projectRoot: worktree, projectName: name, plan });
      await this.git(worktree, ["add", "--", ...plan.update, ...plan.add]);
      await this.git(worktree, [...(await this.identity(worktree)), "commit", "-q", "-m", PR_TITLE]);

      const open = (await this.gh(["pr", "list", "--repo", slug, "--head", SYNC_BRANCH, "--state", "open", "--json", "url", "--jq", '.[0].url // ""'])).trim();
      const remoteHead = (await this.git(repo, ["ls-remote", "--heads", "origin", SYNC_BRANCH])).split(/\s/)[0] ?? "";
      if (remoteHead) {
        await this.git(repo, ["fetch", "-q", "origin", SYNC_BRANCH]);
        // The fetch brought the remote branch's commit in; FETCH_HEAD would belong to the other worktree.
        const sameTree = (await this.git(worktree, ["rev-parse", "HEAD^{tree}"])).trim() === (await this.git(worktree, ["rev-parse", `${remoteHead}^{tree}`])).trim();
        if (sameTree && open) return done({ ...base, ...found, status: "pr_open", prUrl: open });
      }
      // The branch belongs to Forge and is rebuilt from origin/<base> on every sync.
      await this.git(worktree, ["push", "-q", remoteHead ? `--force-with-lease=${SYNC_BRANCH}:${remoteHead}` : "--set-upstream", "origin", `${SYNC_BRANCH}:${SYNC_BRANCH}`]);
      if (open) return done({ ...base, ...found, status: "pr_updated", prUrl: open });
      const created = await this.gh(["pr", "create", "--repo", slug, "--base", branch, "--head", SYNC_BRANCH, "--title", PR_TITLE, "--body", this.body(found)]);
      return done({ ...base, ...found, status: "pr_opened", prUrl: /https:\/\/\S+/.exec(created)?.[0] ?? created.trim() });
    } catch (error) {
      return done({ ...base, status: "failed", reason: String((error as { stderr?: string }).stderr ?? error).trim().slice(0, 400) });
    } finally {
      await this.git(repo, ["worktree", "remove", "--force", worktree]).catch(() => undefined);
    }
  }

  private body(found: { updated: string[]; added: string[]; customized: string[] }): string {
    const list = (files: string[]) => files.map((f) => `- \`${f}\``).join("\n");
    return [
      "Forge's agents, skills, pipeline and step settings changed since this project got them. This PR brings the files the project never changed up to date.",
      "",
      ...(found.updated.length ? ["**Updated**", "", list(found.updated), ""] : []),
      ...(found.added.length ? ["**Added**", "", list(found.added), ""] : []),
      ...(found.customized.length
        ? ["**Left alone** (changed in this project, so Forge did not overwrite them; compare them with Forge's template by hand)", "", list(found.customized), ""]
        : []),
      "Tasks already running keep their branch's copy until they merge the base branch.",
    ].join("\n");
  }

  private async git(cwd: string, args: string[]): Promise<string> {
    return (await run("git", ["-C", cwd, ...args], { encoding: "utf8" })).stdout;
  }

  private async gh(args: string[]): Promise<string> {
    return (await run(this.deps.config.ghBin, args, { encoding: "utf8" })).stdout;
  }

  private async identity(cwd: string): Promise<string[]> {
    const email = (await this.git(cwd, ["config", "user.email"]).catch(() => "")).trim();
    return email ? [] : ["-c", "user.name=Forge", "-c", "user.email=forge@localhost"];
  }
}
