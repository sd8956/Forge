import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { branchFor } from "../runner/worktree.js";

const run = promisify(execFile);

/** Task ids listed on the `- Depends on:` line of a backlog task; `none` means no dependencies. */
export function parseDependencies(spec: string): string[] {
  const line = /^\s*-\s*Depends on:\s*(.+)$/im.exec(spec)?.[1] ?? "";
  return [...new Set(line.match(/\bTASK-\d{3,}\b/g) ?? [])];
}

async function git(projectPath: string, args: string[]): Promise<{ ok: boolean; stdout: string }> {
  try {
    const { stdout } = await run("git", ["-C", projectPath, ...args], { encoding: "utf8" });
    return { ok: true, stdout: stdout.trim() };
  } catch {
    return { ok: false, stdout: "" };
  }
}

/**
 * A dependency counts as merged when its task branch is an ancestor of the base
 * branch (merge commit or fast-forward) or when the base history has a commit
 * naming the task as `(TASK-xxx)`, which is how a squash merge of a Forge PR
 * titled "... (TASK-xxx)" lands.
 */
export async function unmergedDependencies(projectPath: string, baseBranch: string, deps: string[]): Promise<string[]> {
  const unmerged: string[] = [];
  for (const dep of deps) {
    const ancestor = await git(projectPath, ["merge-base", "--is-ancestor", branchFor(dep), baseBranch]);
    if (ancestor.ok) continue;
    const squashed = await git(projectPath, ["log", baseBranch, "--fixed-strings", "--grep", `(${dep})`, "--format=%H", "-n", "1"]);
    if (squashed.ok && squashed.stdout) continue;
    unmerged.push(dep);
  }
  return unmerged;
}

/**
 * Dependencies whose Forge run has not finished. A fresh task branch with no
 * commits yet is an ancestor of the base branch, so git alone would call it
 * merged; a run that is still open or waiting for review says it is not.
 */
export function unfinishedDependencyRuns(runs: { projectPath: string; taskId: string; status: string }[], projectPath: string, deps: string[]): string[] {
  const pending = new Set(["queued", "running", "needs_human", "waiting_review"]);
  return deps.filter((dep) => runs.some((r) => r.projectPath === projectPath && r.taskId === dep && pending.has(r.status)));
}
