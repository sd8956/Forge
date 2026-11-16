import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parse } from "yaml";
import { loadOrCreateToken } from "./auth.js";
import { baseUrl, type ForgeConfig } from "./config.js";
import { openDatabase } from "./db/client.js";
import { RunStore } from "./db/run-store.js";
import { StepStore } from "./db/step-store.js";
import { buildServer } from "./http/server.js";
import { EngramAdapter, type MemoryAdapter } from "./memory/memory-adapter.js";
import { Tmux } from "./runner/tmux.js";
import { RunService } from "./runs/run-service.js";
import { StepService } from "./steps/step-service.js";

export interface Backend {
  url: string;
  token: string;
  store: StepStore;
  runs: RunStore;
  service: StepService;
  runService: RunService;
  reconciled: { resumed: string[]; orphaned: string[] };
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

export async function startBackend(config: ForgeConfig, opts: { logger?: boolean; memory?: MemoryAdapter } = {}): Promise<Backend> {
  const token = loadOrCreateToken(config.home);
  const { db, close: closeDb } = openDatabase(join(config.home, "forge.db"));
  const store = new StepStore(db);
  const runs = new RunStore(db);
  const tmux = new Tmux(config.tmuxSocket);
  const log = (msg: string, extra?: Record<string, unknown>) => {
    if (opts.logger) console.error(`[forge] ${msg}`, extra ?? "");
  };
  let url = baseUrl(config);
  const service = new StepService({ config, store, tmux, token, log, url: () => url });
  const runService = new RunService({ config, runs, steps: service, log });
  const memory = opts.memory ?? new EngramAdapter(config.engramUrl);

  // Steps first (orphans are marked but runs do not react yet), then listen, then advance runs,
  // so a relaunched session never starts before its hooks and MCP server can answer.
  const reconciled = await service.reconcile();
  const app = buildServer({ token, store, service, runs, runService, memory, memoryProject: memoryProjectFor, logger: opts.logger ?? false });
  await app.listen({ host: config.host, port: config.port });
  const address = app.server.address();
  const port = typeof address === "object" && address ? address.port : config.port;
  url = baseUrl({ host: config.host, port });
  await runService.reconcile();
  service.startSweeper();

  return {
    url,
    token,
    store,
    runs,
    service,
    runService,
    reconciled,
    close: async () => {
      await app.close();
      await service.shutdown();
      closeDb();
    },
  };
}
