import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import type { PrSnapshot } from "./pr-diff.js";

const run = promisify(execFile);

export interface GitHubClient {
  snapshot(slug: string, prNumber: number): Promise<PrSnapshot>;
  /** Tail of the failed log of a GitHub Actions run, from a check's details URL. */
  failedCheckLog(slug: string, checkUrl: string | null): Promise<string | null>;
}

export class GitHubError extends Error {}

const prView = z.object({
  state: z.enum(["OPEN", "MERGED", "CLOSED"]),
  headRefOid: z.string(),
  statusCheckRollup: z
    .array(
      z.looseObject({
        __typename: z.string().optional(),
        name: z.string().optional(),
        context: z.string().optional(),
        status: z.string().optional(),
        conclusion: z.string().nullable().optional(),
        state: z.string().optional(),
        detailsUrl: z.string().nullable().optional(),
        targetUrl: z.string().nullable().optional(),
      }),
    )
    .default([]),
});

const comment = z.object({ id: z.number(), login: z.string(), body: z.string().nullable(), url: z.string() });
const reviewComment = comment.extend({ path: z.string().nullable(), line: z.number().nullable() });
const review = comment.extend({ state: z.string() });

/** `gh api --paginate --jq '.[] | {...}'` prints one compact JSON object per line. */
function lines<T>(stdout: string, schema: z.ZodType<T>): T[] {
  return stdout
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => schema.parse(JSON.parse(l)));
}

/** GitHub through the `gh` CLI, so Forge reuses the person's existing GitHub login. */
export class GhCliClient implements GitHubClient {
  constructor(private readonly ghBin = "gh") {}

  async snapshot(slug: string, prNumber: number): Promise<PrSnapshot> {
    const view = prView.parse(JSON.parse(await this.gh(["pr", "view", String(prNumber), "--repo", slug, "--json", "state,headRefOid,statusCheckRollup"])));
    const pull = `repos/${slug}/pulls/${prNumber}`;
    const [reviewComments, issueComments, reviews] = await Promise.all([
      this.gh(["api", `${pull}/comments`, "--paginate", "--jq", ".[] | {id, login: .user.login, body, path, line: (.line // .original_line), url: .html_url}"]),
      this.gh(["api", `repos/${slug}/issues/${prNumber}/comments`, "--paginate", "--jq", ".[] | {id, login: .user.login, body, url: .html_url}"]),
      this.gh(["api", `${pull}/reviews`, "--paginate", "--jq", ".[] | {id, login: .user.login, body, state, url: .html_url}"]),
    ]);
    return {
      state: view.state,
      headSha: view.headRefOid,
      checks: view.statusCheckRollup.map((c) =>
        c.__typename === "StatusContext"
          ? { name: c.context ?? "status", status: "COMPLETED", conclusion: c.state ?? "", url: c.targetUrl ?? null }
          : { name: c.name ?? "check", status: c.status ?? "", conclusion: c.conclusion ?? "", url: c.detailsUrl ?? null },
      ),
      reviewComments: lines(reviewComments, reviewComment).map((c) => ({ ...c, body: c.body ?? "" })),
      issueComments: lines(issueComments, comment).map((c) => ({ ...c, body: c.body ?? "" })),
      reviews: lines(reviews, review).map((c) => ({ ...c, body: c.body ?? "" })),
    };
  }

  async failedCheckLog(slug: string, checkUrl: string | null): Promise<string | null> {
    const runId = /\/actions\/runs\/(\d+)/.exec(checkUrl ?? "")?.[1];
    if (!runId) return null;
    try {
      return (await this.gh(["run", "view", runId, "--repo", slug, "--log-failed"])).slice(-4000);
    } catch {
      return null;
    }
  }

  private async gh(args: string[]): Promise<string> {
    try {
      return (await run(this.ghBin, args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 })).stdout;
    } catch (error) {
      const stderr = (error as { stderr?: string }).stderr ?? String(error);
      throw new GitHubError(`gh ${args.slice(0, 3).join(" ")} failed: ${stderr.trim().slice(0, 300)}`);
    }
  }
}
