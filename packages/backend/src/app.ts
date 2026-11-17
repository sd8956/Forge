import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parse } from "yaml";
import { loadOrCreateToken } from "./auth.js";
import { baseUrl, type ForgeConfig } from "./config.js";
import { openDatabase } from "./db/client.js";
import { RunStore } from "./db/run-store.js";
import { StepStore } from "./db/step-store.js";
import { LoginCodes } from "./http/panel-auth.js";
import { loginUrl } from "./http/panel-routes.js";
import { buildServer } from "./http/server.js";
import { ProjectStore } from "./db/project-store.js";
import { EventBus } from "./events/event-bus.js";
import { PrThreadStore } from "./db/pr-thread-store.js";
import { GhCliClient, type GitHubClient } from "./github/github-client.js";
import { PrWatcher } from "./github/pr-watcher.js";
import { EngramAdapter, type MemoryAdapter } from "./memory/memory-adapter.js";
import { Tmux } from "./runner/tmux.js";
import { archiveDirFor, RunService } from "./runs/run-service.js";
import { SchedulerService } from "./runs/scheduler-service.js";
import { PlanStore } from "./db/plan-store.js";
import { OrchestratorService } from "./orchestrator/orchestrator-service.js";
import { DefinitionService } from "./definition/definition-service.js";
import { DefinitionStore } from "./db/definition-store.js";
import { routeStepPolicy } from "./steps/policy-router.js";
import { StepService } from "./steps/step-service.js";

export interface Backend {
  url: string;
  token: string;
  store: StepStore;
  runs: RunStore;
  service: StepService;
  runService: RunService;
  reconciled: { resumed: string[]; orphaned: string[] };
  projects: ProjectStore;
  /** A fresh one-time link that logs a browser into the panel. */
  loginLink: () => string;
  watcher: PrWatcher;
  threads: PrThreadStore;
  plans: PlanStore;
  scheduler: SchedulerService;
  orchestrator: OrchestratorService;
  definition: DefinitionService;
  /** Stops the HTTP server and timers. tmux sessions are left running on purpose. */
  close: () => Promise<void>;
}

/** Engram project of a target project: `name` in `.factory/project.yaml`, else the folder name. */
export function memoryProjectFor(projectPath: string): string {
  const file = join(projectPath, ".factory", "project.yaml");
  if (existsSync(file)) {
    const name = (parse(readFileSync(file, "utf8")) as { name?: unknown } | null)?.name;
    if (typeof name === "string" && name) return name;
  }
  return basename(projectPath);
}

export async function startBackend(config: ForgeConfig, opts: { logger?: boolean; memory?: MemoryAdapter; github?: GitHubClient } = {}): Promise<Backend> {
  const token = loadOrCreateToken(config.home);
  const { db, close: closeDb } = openDatabase(join(config.home, "forge.db"));
  const bus = new EventBus();
  const store = new StepStore(db, Date.now, (event) => bus.publish(event));
  const runs = new RunStore(db, Date.now, (event) => bus.publish(event));
  const tmux = new Tmux(config.tmuxSocket);
  const log = (msg: string, extra?: Record<string, unknown>) => {
    if (opts.logger) console.error(`[forge] ${msg}`, extra ?? "");
  };
  let url = baseUrl(config);
  const service = new StepService({ config, store, tmux, token, log, url: () => url });
  const memory = opts.memory ?? new EngramAdapter(config.engramUrl);
  const threads = new PrThreadStore(db);
  // The scheduler is created right after; the run service asks it whether launches are on hold.
  const schedulerRef: { current?: SchedulerService } = {};
  const runService = new RunService({
    config,
    runs,
    steps: service,
    threads,
    memory,
    memoryProject: memoryProjectFor,
    log,
    launchHold: () => schedulerRef.current?.launchHold() ?? null,
  });
  const projects = new ProjectStore(db);
  const plans = new PlanStore(db, Date.now, (event) => bus.publish(event));
  const queue = new SchedulerService({ config, plans, runs, threads, runService, log });
  schedulerRef.current = queue;
  const orchestrator = new OrchestratorService({ config, tmux, plans, token, url: () => url });
  const definitionStore = new DefinitionStore(db, Date.now, (event) => bus.publish(event));
  const github = opts.github ?? new GhCliClient(config.ghBin);
  const definition = new DefinitionService({ config, store: definitionStore, steps: service, stepStore: store, projects, github, log });
  service.policy = routeStepPolicy(runService, definition);
  service.onRateLimit = (step) => queue.onRateLimit(step.id);
  const watcher = new PrWatcher({
    runs,
    threads,
    projects,
    github,
    runService,
    onFeedback: () => queue.tick(),
    intervalMs: config.prPollIntervalMs,
    log,
  });
  const codes = new LoginCodes();
  let port = config.port;

  // Steps first (orphans are marked but runs do not react yet), then listen, then advance runs,
  // so a relaunched session never starts before its hooks and MCP server can answer.
  const reconciled = await service.reconcile();
  const app = await buildServer({
    token,
    store,
    service,
    runs,
    runService,
    memory,
    memoryProject: memoryProjectFor,
    projects,
    codes,
    port: () => port,
    baseUrl: () => url,
    webDist: config.webDist,
    archiveDir: (runId) => archiveDirFor(config.home, runId),
    threads,
    scheduler: queue,
    plans,
    orchestrator,
    definition,
    config,
    bus,
    tmuxSocket: config.tmuxSocket,
    logger: opts.logger ?? false,
  });
  await app.listen({ host: config.host, port: config.port });
  const address = app.server.address();
  port = typeof address === "object" && address ? address.port : config.port;
  url = baseUrl({ host: config.host, port });
  await runService.reconcile();
  definition.reconcile();
  definition.startWatching(config.prPollIntervalMs);
  service.startSweeper();
  watcher.start();
  queue.start();
  // A run that changes status may free a slot or a module.
  const unsubscribe = bus.subscribe((event) => {
    if (event.entity === "run" && event.type === "transition") void queue.tick();
  });

  return {
    url,
    token,
    store,
    runs,
    service,
    runService,
    reconciled,
    projects,
    loginLink: () => loginUrl({ baseUrl: () => url, codes }),
    watcher,
    threads,
    plans,
    scheduler: queue,
    orchestrator,
    definition,
    close: async () => {
      unsubscribe();
      await queue.stop();
      await definition.stopWatching();
      await watcher.stop();
      await app.close();
      await service.shutdown();
      closeDb();
    },
  };
}
