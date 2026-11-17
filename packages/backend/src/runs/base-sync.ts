import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<{ ok: boolean; stdout: string }> {
  try {
    const { stdout } = await run("git", ["-C", cwd, ...args], { encoding: "utf8" });
    return { ok: true, stdout: stdout.trim() };
  } catch {
    return { ok: false, stdout: "" };
  }
}

export type BaseSyncResult = { status: "updated" | "current" | "no_remote" | "skipped" } | { status: "blocked"; why: string };

/**
 * Brings the project's base branch up to date with `origin` so a dependency
 * merged on GitHub counts as merged here, the way a person would pull main
 * before starting the next task. It only fast-forwards a clean checkout that is
 * on the base branch; anything else is left alone and reported.
 */
export class BaseSync {
  private readonly last = new Map<string, number>();

  constructor(
    private readonly minIntervalMs = 30_000,
    private readonly now: () => number = Date.now,
  ) {}

  async sync(projectPath: string, baseBranch: string): Promise<BaseSyncResult> {
    const key = `${projectPath}\0${baseBranch}`;
    if (this.now() - (this.last.get(key) ?? -Infinity) < this.minIntervalMs) return { status: "skipped" };
    this.last.set(key, this.now());
    if (!(await git(projectPath, ["remote", "get-url", "origin"])).ok) return { status: "no_remote" };
    if (!(await git(projectPath, ["fetch", "-q", "origin", baseBranch])).ok) return { status: "blocked", why: `git fetch origin ${baseBranch} failed` };
    const behind = await git(projectPath, ["rev-list", "--count", `${baseBranch}..origin/${baseBranch}`]);
    if (!behind.ok || behind.stdout === "0") return { status: "current" };
    const head = await git(projectPath, ["rev-parse", "--abbrev-ref", "HEAD"]);
    if (head.stdout !== baseBranch) return { status: "blocked", why: `the project checkout is on ${head.stdout || "a detached HEAD"}, not ${baseBranch}` };
    const dirty = await git(projectPath, ["status", "--porcelain", "--untracked-files=no"]);
    if (!dirty.ok || dirty.stdout) return { status: "blocked", why: "the project checkout has uncommitted changes" };
    const merged = await git(projectPath, ["merge", "--ff-only", "-q", `origin/${baseBranch}`]);
    return merged.ok ? { status: "updated" } : { status: "blocked", why: `${baseBranch} cannot fast-forward to origin/${baseBranch}` };
  }
}
