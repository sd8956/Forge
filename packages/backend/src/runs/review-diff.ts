import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseUnifiedDiff, REVIEW_LENSES, reviewDepth, type ReviewDepth } from "../domain/review-depth.js";

const run = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run("git", ["-C", cwd, "-c", "core.quotePath=false", ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

/**
 * Review depth of a task: the diff of its branch (HEAD of the worktree) against
 * the merge base with its base branch. Computed the same way when the
 * code_review step launches and when it reports, since the step never commits.
 * A diff that cannot be read gets every lens: the depth never drops on an error.
 */
export async function taskReviewDepth(worktreePath: string, baseBranch: string): Promise<ReviewDepth> {
  try {
    const base = (await git(worktreePath, ["merge-base", "HEAD", baseBranch])).trim();
    const diff = await git(worktreePath, ["diff", "--unified=0", "--no-color", "--no-ext-diff", "-M", base, "HEAD"]);
    return reviewDepth(parseUnifiedDiff(diff));
  } catch (error) {
    const message = error instanceof Error ? error.message.split("\n")[0] : String(error);
    return { tier: "high", lenses: [...REVIEW_LENSES], reasons: [`could not read the diff against ${baseBranch}, so every lens applies (${message})`] };
  }
}
