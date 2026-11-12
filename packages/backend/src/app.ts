import { join } from "node:path";
import { loadOrCreateToken } from "./auth.js";
import { baseUrl, type ForgeConfig } from "./config.js";
import { openDatabase } from "./db/client.js";
import { StepStore } from "./db/step-store.js";
import { buildServer } from "./http/server.js";
import { Tmux } from "./runner/tmux.js";
import { StepService } from "./steps/step-service.js";

export interface Backend {
  url: string;
  token: string;
  store: StepStore;
  service: StepService;
  reconciled: { resumed: string[]; orphaned: string[] };
  /** Stops the HTTP server and timers. tmux sessions are left running on purpose. */
  close: () => Promise<void>;
}

export async function startBackend(config: ForgeConfig, opts: { logger?: boolean } = {}): Promise<Backend> {
  const token = loadOrCreateToken(config.home);
  const { db, close: closeDb } = openDatabase(join(config.home, "forge.db"));
  const store = new StepStore(db);
  const tmux = new Tmux(config.tmuxSocket);
  const log = (msg: string, extra?: Record<string, unknown>) => {
    if (opts.logger) console.error(`[forge] ${msg}`, extra ?? "");
  };
  let url = baseUrl(config);
  const service = new StepService({ config, store, tmux, token, log, url: () => url });

  const reconciled = await service.reconcile();
  const app = buildServer({ token, store, service, logger: opts.logger ?? false });
  await app.listen({ host: config.host, port: config.port });
  service.startSweeper();
  const address = app.server.address();
  const port = typeof address === "object" && address ? address.port : config.port;
  url = baseUrl({ host: config.host, port });

  return {
    url,
    token,
    store,
    service,
    reconciled,
    close: async () => {
      await app.close();
      await service.shutdown();
      closeDb();
    },
  };
}
