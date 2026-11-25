import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Duplex } from "node:stream";
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { activityHookInput, notificationHookInput, preToolUseHookInput, sessionEndHookInput, startRunRequest, stopFailureHookInput, stopHookInput, usageReportInput } from "@forge/shared";
import { z } from "zod";
import { TOKEN_HEADER, tokenMatches } from "../auth.js";
import type { SchedulerService } from "../runs/scheduler-service.js";
import type { PlanStore } from "../db/plan-store.js";
import type { OrchestratorService } from "../orchestrator/orchestrator-service.js";
import type { ForgeConfig } from "../config.js";
import { registerOrchestratorRoutes } from "./orchestrator-routes.js";
import { registerDefinitionRoutes } from "./definition-routes.js";
import type { DefinitionService } from "../definition/definition-service.js";
import { apiKeyInput, settingsPatch, SettingsError, type SettingsService } from "../settings/settings-service.js";
import { loadProjectConfig } from "../projects/project-config.js";
import type { PrThreadStore } from "../db/pr-thread-store.js";
import type { ProjectStore } from "../db/project-store.js";
import { DuplicateRunError, toRunView, type RunStore } from "../db/run-store.js";
import { toStepView, type StepStore } from "../db/step-store.js";
import { createFactoryMcpServer } from "../mcp/factory-server.js";
import type { MemoryAdapter } from "../memory/memory-adapter.js";
import { RunRequestError, type RunService } from "../runs/run-service.js";
import { StepRequestError, type StepService } from "../steps/step-service.js";
import { isLocalHost, isLocalOrigin, type LoginCodes, readCookie, SESSION_COOKIE, verifySessionCookie } from "./panel-auth.js";
import { registerPanelRoutes } from "./panel-routes.js";
import { registerWsRoutes } from "./ws-routes.js";
import { runEvidence } from "./evidence.js";
import { listBacklog } from "../projects/project-config.js";
import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import type { EventBus } from "../events/event-bus.js";

interface ServerDeps {
  token: string;
  store: StepStore;
  service: StepService;
  runs: RunStore;
  runService: RunService;
  memory: MemoryAdapter;
  /** Engram project name for a project path (from project.yaml). */
  memoryProject: (projectPath: string) => string;
  projects: ProjectStore;
  codes: LoginCodes;
  /** Port the backend listens on, once known (the Host and Origin checks need it). */
  port: () => number;
  baseUrl: () => string;
  webDist: string;
  archiveDir: (runId: string) => string;
  threads: PrThreadStore;
  scheduler: SchedulerService;
  plans: PlanStore;
  orchestrator: OrchestratorService;
  definition: DefinitionService;
  settings: SettingsService;
  config: ForgeConfig;
  bus: EventBus;
  tmuxSocket: string;
  logger?: boolean;
}

/** Reachable without credentials: the panel's static shell and the login link. */
function isPublic(path: string): boolean {
  return path === "/health" || path === "/login" || path === "/" || path.startsWith("/assets/") || path === "/favicon.svg";
}

const stepIdParams = z.object({ stepId: z.uuid() });
const runIdParams = z.object({ runId: z.uuid() });

async function gitStdout(args: string[]): Promise<string> {
  try {
    return (await promisify(execFile)("git", args, { encoding: "utf8" })).stdout.trim();
  } catch {
    return "";
  }
}

function badRequest(reply: FastifyReply, error: z.ZodError) {
  return reply.code(400).send({ error: "invalid_request", issues: error.issues });
}

export async function buildServer(deps: ServerDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: deps.logger ?? false, bodyLimit: 1024 * 1024, forceCloseConnections: true });

  // Upgraded and refused-upgrade sockets are not tracked by the HTTP server, so close them ourselves.
  const upgradeSockets = new Set<Duplex>();
  app.server.on("upgrade", (_request, socket: Duplex) => {
    upgradeSockets.add(socket);
    socket.once("close", () => upgradeSockets.delete(socket));
  });
  app.addHook("preClose", (done) => {
    for (const socket of upgradeSockets) socket.destroy();
    done();
  });

  app.get("/health", () => ({ ok: true }));

  // The backend can launch shells: every request must come to a local Host name, and everything but
  // the public shell needs the local token (CLI, hooks, MCP) or the panel's session cookie. Cookie
  // requests that change state, and WebSockets, must also come from the panel's own Origin.
  app.addHook("onRequest", async (request, reply) => {
    const refuse = async (code: number, error: string) => {
      await reply.code(code).send({ error });
      // A refused WebSocket upgrade must not leave its socket open.
      if (request.headers.upgrade) request.raw.socket.destroySoon();
    };
    if (!isLocalHost(request.headers.host, deps.port())) return refuse(403, "forbidden_host");
    const path = request.url.split("?")[0] ?? "";
    if (isPublic(path)) return;
    if (tokenMatches(deps.token, request.headers[TOKEN_HEADER])) return;
    if (!verifySessionCookie(deps.token, readCookie(request.headers.cookie, SESSION_COOKIE))) return refuse(401, "unauthorized");
    const changesState = request.method !== "GET" && request.method !== "HEAD";
    const websocket = request.headers.upgrade?.toLowerCase() === "websocket";
    if ((changesState || websocket) && !isLocalOrigin(request.headers.origin, deps.port())) return refuse(403, "forbidden_origin");
  });

  const controlled = new Map<string, string>();
  await registerWsRoutes(app, {
    bus: deps.bus,
    store: deps.store,
    tmuxSocket: deps.tmuxSocket,
    orchestratorSession: async (projectId) => {
      const project = deps.projects.get(projectId);
      return project ? await deps.orchestrator.status(project) : null;
    },
    // The panel reconnects the orchestrator terminal on every render; record the takeover once per session.
    onOrchestratorControl: (projectId, session) => {
      const key = `${session.tmuxSession}@${session.startedAt}`;
      if (controlled.get(projectId) === key) return;
      controlled.set(projectId, key);
      deps.plans.recordEvent("plan", projectId, "orchestrator_control", { via: "panel", session: session.tmuxSession });
    },
  });

  registerDefinitionRoutes(app, deps.definition);

  // ---------------------------------------------------------- settings
  const settingsRefused = (reply: FastifyReply, error: unknown) => {
    if (error instanceof SettingsError) return reply.code(409).send({ error: "settings_refused", message: error.message });
    throw error;
  };
  app.get("/settings", () => deps.settings.get());
  app.patch("/settings", (request, reply) => {
    const body = settingsPatch.safeParse(request.body ?? {});
    if (!body.success) return badRequest(reply, body.error);
    try {
      const updated = deps.settings.update(body.data);
      void deps.scheduler.tick();
      return updated;
    } catch (error) {
      return settingsRefused(reply, error);
    }
  });
  app.put("/settings/api-key", (request, reply) => {
    const body = apiKeyInput.safeParse(request.body);
    // Never echo the rejected value back.
    if (!body.success) return reply.code(400).send({ error: "invalid_request", message: "Not an Anthropic API key (sk-ant-...)" });
    return deps.settings.saveApiKey(body.data.key);
  });
  app.delete("/settings/api-key", (_request, reply) => {
    try {
      return deps.settings.removeApiKey();
    } catch (error) {
      return settingsRefused(reply, error);
    }
  });
  /** A project's settings come from its project.yaml, the source of truth; the panel shows them read-only. */
  app.get("/projects/:projectId/settings", (request, reply) => {
    const params = z.object({ projectId: z.uuid() }).safeParse(request.params);
    if (!params.success) return badRequest(reply, params.error);
    const project = deps.projects.get(params.data.projectId);
    if (!project) return reply.code(404).send({ error: "unknown_project" });
    try {
      const config = loadProjectConfig(project.repoPath);
      return {
        file: join(project.repoPath, ".factory", "project.yaml"),
        permissionMode: config.policies.permission_mode,
        maxConcurrency: config.policies.max_concurrency ?? null,
        allowedAuthors: config.review.allowed_authors,
        pollIntervalSeconds: config.review.poll_interval_seconds ?? null,
        commands: config.commands,
      };
    } catch (error) {
      return reply.code(409).send({ error: "invalid_project", message: error instanceof Error ? error.message : String(error) });
    }
  });

  registerOrchestratorRoutes(app, {
    config: deps.config,
    plans: deps.plans,
    runs: deps.runs,
    runService: deps.runService,
    scheduler: deps.scheduler,
    projects: deps.projects,
    orchestrator: deps.orchestrator,
    baseBranch: async (projectPath) => (await gitStdout(["-C", projectPath, "rev-parse", "--abbrev-ref", "HEAD"])) || "main",
  });

  await registerPanelRoutes(app, {
    token: deps.token,
    baseUrl: deps.baseUrl,
    projects: deps.projects,
    runs: deps.runs,
    codes: deps.codes,
    webDist: deps.webDist,
    archiveDir: deps.archiveDir,
  });

  // ------------------------------------------------------------- hooks
  // Hook responses must be 2xx: an empty body means "no decision", a JSON body is a decision.

  app.post("/hooks/stop", async (request, reply) => {
    const parsed = stopHookInput.safeParse(request.body);
    if (!parsed.success) return badRequest(reply, parsed.error);
    const decision = await deps.service.onStop(parsed.data);
    return decision ? reply.send(decision) : reply.code(204).send();
  });

  app.post("/hooks/pre-tool-use", async (request, reply) => {
    const parsed = preToolUseHookInput.safeParse(request.body);
    if (!parsed.success) return badRequest(reply, parsed.error);
    const decision = deps.service.onPreToolUse(parsed.data);
    return decision ? reply.send(decision) : reply.code(204).send();
  });

  app.post("/hooks/activity", async (request, reply) => {
    const parsed = activityHookInput.safeParse(request.body);
    if (!parsed.success) return badRequest(reply, parsed.error);
    deps.service.onActivity(parsed.data);
    return reply.code(204).send();
  });

  app.post("/hooks/notification", async (request, reply) => {
    const parsed = notificationHookInput.safeParse(request.body);
    if (!parsed.success) return badRequest(reply, parsed.error);
    deps.service.onNotification(parsed.data);
    return reply.code(204).send();
  });

  app.post("/hooks/stop-failure", async (request, reply) => {
    const parsed = stopFailureHookInput.safeParse(request.body);
    if (!parsed.success) return badRequest(reply, parsed.error);
    await deps.service.onStopFailure(parsed.data);
    return reply.code(204).send();
  });

  app.post("/hooks/usage", async (request, reply) => {
    const parsed = usageReportInput.safeParse(request.body);
    if (!parsed.success) return badRequest(reply, parsed.error);
    const window = (w: { used_percentage: number; resets_at: number } | undefined) => (w ? { percent: w.used_percentage, resetsAt: w.resets_at * 1000 } : null);
    deps.scheduler.recordUsage({ fiveHour: window(parsed.data.rate_limits.five_hour), sevenDay: window(parsed.data.rate_limits.seven_day) });
    return reply.code(204).send();
  });

  app.post("/hooks/session-end", async (request, reply) => {
    const parsed = sessionEndHookInput.safeParse(request.body);
    if (!parsed.success) return badRequest(reply, parsed.error);
    deps.service.onSessionEnd(parsed.data);
    return reply.code(204).send();
  });

  // --------------------------------------------------------------- MCP
  // Stateless Streamable HTTP: one MCP server and transport per request.

  app.post("/mcp/:stepId", async (request, reply) => {
    const params = stepIdParams.safeParse(request.params);
    if (!params.success) return badRequest(reply, params.error);
    const step = deps.store.get(params.data.stepId);
    if (!step) return reply.code(404).send({ error: "unknown_step" });
    const server = createFactoryMcpServer(params.data.stepId, deps.service, step.kind);
    const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true }); // no sessionIdGenerator = stateless
    reply.hijack();
    reply.raw.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(request.raw, reply.raw, request.body);
  });

  const methodNotAllowed = (_req: unknown, reply: FastifyReply) =>
    reply.code(405).header("allow", "POST").send({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null });
  app.get("/mcp/:stepId", methodNotAllowed);
  app.delete("/mcp/:stepId", methodNotAllowed);

  // ------------------------------------------------------------- steps

  app.post("/runs", async (request, reply) => {
    const parsed = startRunRequest.safeParse(request.body);
    if (!parsed.success) return badRequest(reply, parsed.error);
    try {
      const run = await deps.runService.start(parsed.data);
      deps.projects.upsert(run.projectPath);
      return await reply.code(201).send(toRunView(run));
    } catch (error) {
      if (error instanceof DuplicateRunError) return reply.code(409).send({ error: "duplicate_run", message: error.message, runId: error.runId });
      if (error instanceof RunRequestError || error instanceof StepRequestError) return reply.code(400).send({ error: "invalid_run", message: error.message });
      throw error;
    }
  });

  app.get("/runs", () =>
    deps.runs.list().map((run) => {
      const latest = deps.runs.latestStep(run.id);
      return { ...toRunView(run), latestStep: latest ? toStepView(latest) : null };
    }),
  );

  app.get("/runs/:runId/evidence", async (request, reply) => {
    const params = runIdParams.safeParse(request.params);
    if (!params.success) return badRequest(reply, params.error);
    const run = deps.runs.get(params.data.runId);
    if (!run) return reply.code(404).send({ error: "unknown_run" });
    // After the merge the worktree is gone; the archive holds the same tree, so rebase the step paths onto it.
    const live = join(run.worktreePath, ".factory", "runs", run.taskId);
    const root = existsSync(live) ? live : deps.archiveDir(run.id);
    const steps = deps.runs.steps(run.id).map((step) => (root === live ? step : { ...step, outputPath: join(root, relative(live, step.outputPath)) }));
    return runEvidence(steps, () => root);
  });

  /** The Memory panel: what the project's steps saved in Engram, read-only, each linked to its task's run. */
  app.get("/projects/:projectId/memories", async (request, reply) => {
    const params = z.object({ projectId: z.uuid() }).safeParse(request.params);
    const query = z
      .object({ q: z.string().trim().max(200).optional(), ref: z.string().regex(/^TASK-\d{3,}(\/[a-z][a-z0-9-]*)?$/).optional() })
      .safeParse(request.query);
    if (!params.success) return badRequest(reply, params.error);
    if (!query.success) return badRequest(reply, query.error);
    const project = deps.projects.get(params.data.projectId);
    if (!project) return reply.code(404).send({ error: "unknown_project" });
    const name = deps.memoryProject(project.repoPath);
    try {
      const found = query.data.q ? await deps.memory.search(name, query.data.q, 50) : await deps.memory.list(name, 200);
      const ref = query.data.ref;
      const items = found.filter((m) => !ref || m.ref === ref || m.ref?.startsWith(`${ref}/`));
      const runs = deps.runs.list().filter((r) => r.projectPath === project.repoPath);
      return {
        available: true,
        items: items.map((m) => {
          const taskId = m.ref?.split("/")[0];
          return { ...m, runId: taskId ? (runs.filter((r) => r.taskId === taskId).at(-1)?.id ?? null) : null };
        }),
      };
    } catch (error) {
      return { available: false, error: error instanceof Error ? error.message : String(error), items: [] };
    }
  });

  app.get("/runs/:runId", async (request, reply) => {
    const params = runIdParams.safeParse(request.params);
    if (!params.success) return badRequest(reply, params.error);
    const run = deps.runs.get(params.data.runId);
    if (!run) return reply.code(404).send({ error: "unknown_run" });
    // Memory is complementary: a missing Engram must not break the status view.
    const memories = await deps.memory.listByTask(deps.memoryProject(run.projectPath), run.taskId).then(
      (list) => ({ available: true, items: list.map(({ id, title, ref, createdAt }) => ({ id, title, ref, createdAt })) }),
      (error: unknown) => ({ available: false, error: error instanceof Error ? error.message : String(error), items: [] }),
    );
    const prThreads = deps.threads.list(run.id).map(({ externalId, kind, author, path, line, url, handledByStepId, body }) => ({
      id: externalId,
      kind,
      author,
      path,
      line,
      url,
      handled: handledByStepId !== null,
      body: body.slice(0, 2000),
    }));
    const task = listBacklog(run.projectPath).find((t) => t.id === run.taskId) ?? null;
    return { ...toRunView(run), task, steps: deps.runs.steps(run.id).map(toStepView), events: deps.store.events(run.id), memories, prThreads };
  });

  app.post("/runs/:runId/resume", async (request, reply) => {
    const params = runIdParams.safeParse(request.params);
    if (!params.success) return badRequest(reply, params.error);
    const body = z.object({ mergeBase: z.boolean().optional() }).safeParse(request.body ?? {});
    if (!body.success) return badRequest(reply, body.error);
    const result = await deps.runService.resume(params.data.runId, { mergeBase: body.data.mergeBase ?? false });
    return reply.code(result.ok ? 200 : 409).send(result);
  });

  app.post("/runs/:runId/cancel", async (request, reply) => {
    const params = runIdParams.safeParse(request.params);
    if (!params.success) return badRequest(reply, params.error);
    const result = await deps.runService.cancel(params.data.runId);
    return reply.code(result.ok ? 200 : 409).send(result);
  });

  app.get("/steps", () => deps.store.list().map(toStepView));

  app.get("/steps/:stepId", async (request, reply) => {
    const params = stepIdParams.safeParse(request.params);
    if (!params.success) return badRequest(reply, params.error);
    const row = deps.store.get(params.data.stepId);
    if (!row) return reply.code(404).send({ error: "unknown_step" });
    return { ...toStepView(row), events: deps.store.events(row.id) };
  });

  return app;
}
