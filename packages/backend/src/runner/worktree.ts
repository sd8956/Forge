import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export function worktreePathFor(projectPath: string, taskId: string): string {
  return join(projectPath, ".worktrees", taskId);
}

export function branchFor(taskId: string): string {
  return `feat/${taskId}`;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run("git", ["-C", cwd, ...args], { encoding: "utf8" });
  return stdout.trim();
}

async function branchExists(projectPath: string, branch: string): Promise<boolean> {
  try {
    await git(projectPath, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

/** Creates the task worktree on its first step and reuses it afterwards. */
export async function ensureWorktree(projectPath: string, taskId: string): Promise<string> {
  const path = worktreePathFor(projectPath, taskId);
  if (existsSync(join(path, ".git"))) return path;
  const branch = branchFor(taskId);
  const args = (await branchExists(projectPath, branch))
    ? ["worktree", "add", path, branch]
    : ["worktree", "add", path, "-b", branch];
  await git(projectPath, args);
  return path;
}
