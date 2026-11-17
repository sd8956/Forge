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
 * Dependencies whose latest Forge run did not end merged (`done`). A task
 * branch with no commits yet is an ancestor of the base branch, so git alone
 * would call it merged while its run is open, failed or cancelled. A
 * dependency Forge never ran is left to git.
 */
export function unfinishedDependencyRuns(runs: { projectPath: string; taskId: string; status: string; createdAt: number }[], projectPath: string, deps: string[]): string[] {
  return deps.filter((dep) => {
    const latest = runs.filter((r) => r.projectPath === projectPath && r.taskId === dep).sort((a, b) => a.createdAt - b.createdAt).at(-1);
    return latest !== undefined && latest.status !== "done";
  });
}
