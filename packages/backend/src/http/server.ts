import type { Duplex } from "node:stream";
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { activityHookInput, notificationHookInput, preToolUseHookInput, sessionEndHookInput, startRunRequest, stopHookInput } from "@forge/shared";
import { z } from "zod";
import { TOKEN_HEADER, tokenMatches } from "../auth.js";
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
  bus: EventBus;
  logger?: boolean;
}

/** Reachable without credentials: the panel's static shell and the login link. */
function isPublic(path: string): boolean {
  return path === "/health" || path === "/login" || path === "/" || path.startsWith("/assets/") || path === "/favicon.svg";
}

const stepIdParams = z.object({ stepId: z.uuid() });
const runIdParams = z.object({ runId: z.uuid() });

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

  await registerWsRoutes(app, { bus: deps.bus });

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
    if (!deps.store.get(params.data.stepId)) return reply.code(404).send({ error: "unknown_step" });
    const server = createFactoryMcpServer(params.data.stepId, deps.service);
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

  app.get("/runs", () => deps.runs.list().map(toRunView));

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
    return { ...toRunView(run), steps: deps.runs.steps(run.id).map(toStepView), events: deps.store.events(run.id), memories, prThreads };
  });

  app.post("/runs/:runId/resume", async (request, reply) => {
    const params = runIdParams.safeParse(request.params);
    if (!params.success) return badRequest(reply, params.error);
    const result = await deps.runService.resume(params.data.runId);
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
