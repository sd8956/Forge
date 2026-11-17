/** Marks comments Forge posts, so the watcher never treats its own replies as new feedback. */
export const FORGE_REPLY_MARKER = "<!-- forge:reply -->";

export interface PrSnapshot {
  state: "OPEN" | "MERGED" | "CLOSED";
  headSha: string;
  checks: { name: string; status: string; conclusion: string; url: string | null }[];
  reviewComments: { id: number; login: string; body: string; path: string | null; line: number | null; url: string }[];
  issueComments: { id: number; login: string; body: string; url: string }[];
  reviews: { id: number; login: string; body: string; state: string; url: string }[];
}

export interface NewThread {
  externalId: string;
  kind: "review_comment" | "issue_comment" | "review" | "check";
  author: string | null;
  path: string | null;
  line: number | null;
  body: string;
  url: string | null;
}

export interface DiffResult {
  merged: boolean;
  closed: boolean;
  threads: NewThread[];
}

const FAILED = new Set(["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE", "ERROR"]);

/**
 * What changed on a PR since the watcher last looked. Pure: the caller passes
 * the thread ids it already knows and the allowed authors from project.yaml.
 */
export function diffSnapshot(snapshot: PrSnapshot, opts: { known: Set<string>; allowedAuthors: string[] }): DiffResult {
  if (snapshot.state !== "OPEN") return { merged: snapshot.state === "MERGED", closed: snapshot.state === "CLOSED", threads: [] };

  const allowed = new Set(opts.allowedAuthors.map((a) => a.toLowerCase()));
  // "*" lets anyone's comments start a review round (opt-in in project.yaml).
  const allowedAuthor = (login: string) => allowed.has("*") || allowed.has(login.toLowerCase());
  const fromPerson = (login: string, body: string) => allowedAuthor(login) && body.trim() !== "" && !body.includes(FORGE_REPLY_MARKER);
  const threads: NewThread[] = [];
  const add = (thread: NewThread) => {
    if (!opts.known.has(thread.externalId)) threads.push(thread);
  };

  for (const c of snapshot.reviewComments) {
    if (fromPerson(c.login, c.body)) add({ externalId: `review_comment:${c.id}`, kind: "review_comment", author: c.login, path: c.path, line: c.line, body: c.body, url: c.url });
  }
  for (const c of snapshot.issueComments) {
    if (fromPerson(c.login, c.body)) add({ externalId: `issue_comment:${c.id}`, kind: "issue_comment", author: c.login, path: null, line: null, body: c.body, url: c.url });
  }
  for (const r of snapshot.reviews) {
    if (fromPerson(r.login, r.body)) add({ externalId: `review:${r.id}`, kind: "review", author: r.login, path: null, line: null, body: r.body, url: r.url });
  }
  for (const check of snapshot.checks) {
    if (check.status === "COMPLETED" && FAILED.has(check.conclusion)) {
      add({
        externalId: `check:${check.name}@${snapshot.headSha}`,
        kind: "check",
        author: null,
        path: null,
        line: null,
        body: `Check "${check.name}" failed (${check.conclusion}) on ${snapshot.headSha}.`,
        url: check.url,
      });
    }
  }
  return { merged: false, closed: false, threads };
}

/** `owner/repo` of a GitHub remote, or null for anything else. */
export function slugFromRemote(remote: string | null | undefined): string | null {
  const match = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(remote ?? "");
  return match ? `${match[1]}/${match[2]}` : null;
}
