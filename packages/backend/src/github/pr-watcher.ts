import type { PrThreadStore } from "../db/pr-thread-store.js";
import type { ProjectStore } from "../db/project-store.js";
import type { RunStore } from "../db/run-store.js";
import type { RunRow } from "../db/schema.js";
import { projectConfigSchema } from "../projects/project-config.js";
import type { RunService } from "../runs/run-service.js";
import type { GitHubClient } from "./github-client.js";
import { diffSnapshot, slugFromRemote } from "./pr-diff.js";

interface Deps {
  runs: RunStore;
  threads: PrThreadStore;
  projects: ProjectStore;
  github: GitHubClient;
  runService: RunService;
  /** New feedback arrived: the scheduler starts the review round when a session slot is free. */
  onFeedback: (runId: string) => Promise<void>;
  /** Default polling interval; a project can override it with review.poll_interval_seconds. */
  intervalMs: number;
  now?: () => number;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}

/**
 * Polls GitHub for runs waiting for review (a webhook on a local machine would
 * need a tunnel). It only records what changed and asks the run service to act;
 * it never decides how a run moves.
 */
export class PrWatcher {
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;
  private readonly lastPoll = new Map<string, number>();
  private readonly now: () => number;

  constructor(private readonly deps: Deps) {
    this.now = deps.now ?? Date.now;
  }

  start(): void {
    if (this.timer) return;
    // Tick often and let each project's own interval decide whether to poll.
    this.timer = setInterval(() => void this.tick(), Math.min(this.deps.intervalMs, 5000));
    this.timer.unref();
  }

  stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    return this.running ?? Promise.resolve();
  }

  /** One pass over every run waiting for review. Never overlaps with itself. */
  tick(): Promise<void> {
    this.running ??= this.pass().finally(() => (this.running = undefined));
    return this.running;
  }

  private async pass(): Promise<void> {
    for (const run of this.deps.runs.list().filter((r) => r.status === "waiting_review" && r.prNumber)) {
      try {
        await this.check(run);
      } catch (error) {
        this.deps.runs.recordEvent(run.id, "watcher_error", { error: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  /**
   * Whose comments count: everyone with write access to the repository (they can push code anyway), plus the
   * extra logins of `review.allowed_authors`; `"*"` there means anyone.
   */
  private async authors(run: RunRow, slug: string, extra: string[]): Promise<string[]> {
    if (extra.includes("*")) return ["*"];
    try {
      return [...new Set([...(await this.deps.github.writers(slug)), ...extra])];
    } catch (error) {
      // Listing collaborators needs push access; without it only the listed authors count.
      this.deps.runs.recordEvent(run.id, "watcher_writers_unavailable", { error: error instanceof Error ? error.message : String(error) });
      return extra;
    }
  }

  private async check(run: RunRow): Promise<void> {
    const project = this.deps.projects.getByPath(run.projectPath) ?? this.deps.projects.upsert(run.projectPath);
    const config = projectConfigSchema.parse(project.config);
    const interval = config.review.poll_interval_seconds ? config.review.poll_interval_seconds * 1000 : this.deps.intervalMs;
    if (this.now() - (this.lastPoll.get(run.id) ?? 0) < interval) return;
    this.lastPoll.set(run.id, this.now());

    const slug = slugFromRemote(project.remote);
    if (!slug || !run.prNumber) return;
    const snapshot = await this.deps.github.snapshot(slug, run.prNumber);
    const diff = diffSnapshot(snapshot, { known: this.deps.threads.externalIds(run.id), allowedAuthors: await this.authors(run, slug, config.review.allowed_authors) });

    if (diff.merged) return this.deps.runService.onPrMerged(run.id);
    if (diff.closed) return this.deps.runService.onPrClosed(run.id);

    const inserted = this.deps.threads.insertNew(run.id, diff.threads);
    if (inserted.length === 0) return;
    for (const thread of inserted.filter((t) => t.kind === "check")) {
      const log = await this.deps.github.failedCheckLog(slug, thread.url);
      if (log) this.deps.threads.setBody(thread.id, `${thread.body}\n\nFailed log (tail):\n${log}`);
    }
    this.deps.runs.recordEvent(run.id, "review_feedback", { threads: inserted.map((t) => t.externalId) });
    await this.deps.onFeedback(run.id);
  }
}
