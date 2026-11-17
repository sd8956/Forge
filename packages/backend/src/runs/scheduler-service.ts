import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ForgeConfig } from "../config.js";
import type { PlanStore } from "../db/plan-store.js";
import type { PrThreadStore } from "../db/pr-thread-store.js";
import type { RunStore } from "../db/run-store.js";
import { DuplicateRunError } from "../db/run-store.js";
import type { PlanTaskRow, RunRow } from "../db/schema.js";
import { schedule, type ActiveRun, type QueueItem, type ReviewCandidate } from "../domain/scheduler.js";
import { loadPipeline } from "../pipeline/pipeline.js";
import { loadProjectConfig } from "../projects/project-config.js";
import { BaseSync } from "./base-sync.js";
import { unfinishedDependencyRuns, unmergedDependencies } from "./dependencies.js";
import type { RunService } from "./run-service.js";

export const PAUSE_KEY = "queue.pause";
export const USAGE_KEY = "usage";

export interface QueuePause {
  reason: string;
  source: "manual" | "rate_limit";
  since: number;
  /** When a rate-limit pause lifts by itself (the usage window resets). */
  until: number | null;
}

export interface UsageWindow {
  percent: number;
  /** Epoch milliseconds. */
  resetsAt: number;
}

export interface UsageReport {
  fiveHour: UsageWindow | null;
  sevenDay: UsageWindow | null;
  reportedAt: number;
}

interface Deps {
  config: ForgeConfig;
  plans: PlanStore;
  runs: RunStore;
  threads: PrThreadStore;
  runService: RunService;
  baseSync?: BaseSync;
  now?: () => number;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}

const TERMINAL_RUN = new Set(["done", "failed", "cancelled"]);

/**
 * Owns the queue: on every pass it gathers the facts (open runs, merged
 * dependencies, pause, usage), asks the pure `schedule` what may start, and
 * starts it through the run service. It never moves a run by itself.
 */
export class SchedulerService {
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;
  private again = false;
  private stopped = false;
  private readonly now: () => number;
  private readonly baseSync: BaseSync;

  constructor(private readonly deps: Deps) {
    this.now = deps.now ?? Date.now;
    this.baseSync = deps.baseSync ?? new BaseSync();
  }

  start(): void {
    if (this.timer) return;
    this.stopped = false;
    this.timer = setInterval(() => void this.tick(), this.deps.config.schedulerIntervalMs);
    this.timer.unref();
    void this.tick();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    while (this.running) await this.running;
  }

  /** One pass over the queue. A call during a pass schedules exactly one more pass. */
  tick(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      do {
        this.again = false;
        try {
          await this.pass();
        } catch (error) {
          this.deps.log?.("scheduler pass failed", { error: String(error) });
        }
      } while (this.again && !this.stopped);
    })().finally(() => (this.running = undefined));
    return this.running;
  }

  // ------------------------------------------------------------ pause, usage

  pause(reason: string, source: QueuePause["source"] = "manual", until: number | null = null): void {
    const current = this.deps.plans.getSetting<QueuePause>(PAUSE_KEY);
    // A person's pause is never replaced by an automatic one.
    if (current?.source === "manual" && source !== "manual") return;
    this.deps.plans.setSetting(PAUSE_KEY, { reason, source, since: this.now(), until } satisfies QueuePause);
    this.deps.plans.recordEvent("queue", "global", "queue_paused", { reason, source, until });
  }

  resume(): boolean {
    if (!this.deps.plans.getSetting<QueuePause>(PAUSE_KEY)) return false;
    this.deps.plans.deleteSetting(PAUSE_KEY);
    this.deps.plans.recordEvent("queue", "global", "queue_resumed", {});
    void this.tick();
    return true;
  }

  pauseState(): QueuePause | null {
    const pause = this.deps.plans.getSetting<QueuePause>(PAUSE_KEY) ?? null;
    if (pause?.until !== null && pause?.until !== undefined && pause.until <= this.now()) {
      this.deps.plans.deleteSetting(PAUSE_KEY);
      this.deps.plans.recordEvent("queue", "global", "queue_resumed", { cause: "usage_window_reset" });
      return null;
    }
    return pause;
  }

  recordUsage(report: Omit<UsageReport, "reportedAt">): void {
    this.deps.plans.setSetting(USAGE_KEY, { ...report, reportedAt: this.now() } satisfies UsageReport);
  }

  usage(): UsageReport | null {
    const report = this.deps.plans.getSetting<UsageReport>(USAGE_KEY) ?? null;
    if (!report) return null;
    // A window whose reset time passed says nothing about the new window.
    const fresh = (w: UsageWindow | null) => (w && w.resetsAt > this.now() ? w : null);
    return { ...report, fiveHour: fresh(report.fiveHour), sevenDay: fresh(report.sevenDay) };
  }

  // -------------------------------------------------------------------- pass

  private async pass(): Promise<void> {
    const queued = this.deps.plans.queued();
    const open = this.deps.runs.listOpen();
    this.relink(queued, open);
    const items = this.deps.plans.queued();

    const blockedBase = new Map<string, string>();
    const queueItems: QueueItem[] = [];
    for (const item of items) {
      queueItems.push({
        id: item.id,
        projectPath: item.projectPath,
        taskId: item.taskId,
        modules: item.modules,
        priority: item.priority,
        wave: item.wave,
        queuedAt: item.queuedAt ?? item.createdAt,
        unmergedDeps: await this.unmerged(item, blockedBase),
      });
    }

    const active: ActiveRun[] = this.deps.runs
      .listOpen()
      .map((r) => ({ runId: r.id, projectPath: r.projectPath, taskId: r.taskId, modules: this.deps.plans.launchedFor(r.id)?.modules ?? [] }));
    const reviews = this.reviewCandidates();
    const projectCaps: Record<string, number> = {};
    for (const path of new Set(items.map((i) => i.projectPath))) {
      const cap = this.policyCap(path);
      if (cap !== undefined) projectCaps[path] = cap;
    }

    const decision = schedule({
      items: queueItems,
      active,
      reviews,
      maxConcurrency: this.deps.config.maxConcurrency,
      projectCaps,
      paused: this.pauseState(),
      usage: this.usage()?.fiveHour ?? null,
      usagePausePercent: this.deps.config.usagePausePercent,
      now: this.now(),
    });

    let changed = false;
    for (const item of items) {
      let reason = decision.waits[item.id] ?? null;
      const why = blockedBase.get(item.projectPath);
      if (reason?.startsWith("Waits for") && why) reason = `${reason} (cannot update the base branch: ${why})`;
      if (!decision.launches.includes(item.id) && reason !== item.waitReason) {
        this.deps.plans.setWaitReason(item.id, reason);
        changed = true;
      }
    }
    if (changed) this.deps.plans.recordEvent("queue", "global", "queue_changed", {});

    for (const runId of decision.reviews) {
      if (this.stopped) return;
      const threads = this.deps.threads.unhandled(runId);
      await this.deps.runService.requestReview(runId, threads.map((t) => t.externalId).join(","));
    }
    for (const id of decision.launches) {
      if (this.stopped) return;
      const item = items.find((i) => i.id === id);
      if (item) await this.launch(item);
    }
    this.finishPlans();
  }

  private async launch(item: PlanTaskRow): Promise<void> {
    try {
      const run = await this.deps.runService.start({ projectPath: item.projectPath, taskId: item.taskId });
      // start() returns after the first step launched; link it unless relink already did.
      if (this.deps.plans.task(item.id)?.state === "queued") this.deps.plans.markLaunched(item.id, run.id);
      this.deps.plans.recordEvent("plan", item.planId, "task_launched", { taskId: item.taskId, runId: run.id });
    } catch (error) {
      if (error instanceof DuplicateRunError) {
        this.deps.plans.markLaunched(item.id, error.runId);
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      this.deps.plans.cancelTask(item.id, `Launch failed: ${message}`);
      this.deps.plans.recordEvent("plan", item.planId, "task_launch_failed", { taskId: item.taskId, error: message });
    }
  }

  /**
   * A queued task whose run is already open was launched before a restart
   * (start() inserted the run, the backend stopped before linking): link it
   * instead of launching it again.
   */
  private relink(queued: PlanTaskRow[], open: RunRow[]): void {
    for (const item of queued) {
      const run = open.find((r) => r.projectPath === item.projectPath && r.taskId === item.taskId && r.createdAt >= (item.queuedAt ?? 0));
      if (run && !this.deps.plans.launchedFor(run.id)) {
        this.deps.plans.markLaunched(item.id, run.id);
        this.deps.plans.recordEvent("plan", item.planId, "task_relinked", { taskId: item.taskId, runId: run.id });
      }
    }
  }

  private async unmerged(item: PlanTaskRow, blockedBase: Map<string, string>): Promise<string[]> {
    if (item.dependsOn.length === 0) return [];
    // A dependency still in the queue, or whose run has not finished, is not merged whatever git says.
    const queuedDeps = this.deps.plans
      .queued()
      .filter((q) => q.projectPath === item.projectPath && item.dependsOn.includes(q.taskId))
      .map((q) => q.taskId);
    const pending = [...new Set([...queuedDeps, ...unfinishedDependencyRuns(this.deps.runs.list(), item.projectPath, item.dependsOn)])];
    if (pending.length) return pending;
    const base = await this.baseBranch(item.projectPath);
    let unmerged = await unmergedDependencies(item.projectPath, base, item.dependsOn);
    if (unmerged.length === 0) return [];
    const synced = await this.baseSync.sync(item.projectPath, base);
    if (synced.status === "updated") {
      this.deps.plans.recordEvent("queue", "global", "base_updated", { projectPath: item.projectPath, base });
      unmerged = await unmergedDependencies(item.projectPath, base, item.dependsOn);
    } else if (synced.status === "blocked") {
      blockedBase.set(item.projectPath, synced.why);
    }
    return unmerged;
  }

  private async baseBranch(projectPath: string): Promise<string> {
    const { stdout } = await promisify(execFile)("git", ["-C", projectPath, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" });
    return stdout.trim();
  }

  private reviewCandidates(): ReviewCandidate[] {
    const candidates: ReviewCandidate[] = [];
    for (const run of this.deps.runs.list().filter((r) => r.status === "waiting_review" && r.prNumber)) {
      const threads = this.deps.threads.unhandled(run.id);
      if (threads.length === 0) continue;
      try {
        if (!loadPipeline(run.projectPath).review) continue;
      } catch {
        continue;
      }
      candidates.push({ runId: run.id, taskId: run.taskId, requestedAt: Math.min(...threads.map((t) => t.createdAt)) });
    }
    return candidates;
  }

  private policyCap(projectPath: string): number | undefined {
    try {
      return loadProjectConfig(projectPath).policies.max_concurrency;
    } catch {
      return undefined;
    }
  }

  /** An approved plan is done once every task was cancelled or its run finished. */
  private finishPlans(): void {
    for (const plan of this.deps.plans.approvedPlans()) {
      const tasks = this.deps.plans.tasks(plan.id);
      const finished = tasks.every((t) => t.state === "cancelled" || (t.state === "launched" && t.runId && TERMINAL_RUN.has(this.deps.runs.get(t.runId)?.status ?? "")));
      if (finished && this.deps.plans.finish(plan.id, "complete")) this.deps.plans.recordEvent("plan", plan.id, "plan_done", {});
    }
  }
}
