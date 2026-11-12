import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { notificationHookInput, sessionEndHookInput, startStepRequest, stopHookInput } from "@forge/shared";
import { z } from "zod";
import { TOKEN_HEADER, tokenMatches } from "../auth.js";
import { DuplicateStepError, toStepView, type StepStore } from "../db/step-store.js";
import { createFactoryMcpServer } from "../mcp/factory-server.js";
import { StepRequestError, type StepService } from "../steps/step-service.js";

interface ServerDeps {
  token: string;
  store: StepStore;
  service: StepService;
  logger?: boolean;
}

const stepIdParams = z.object({ stepId: z.uuid() });

function badRequest(reply: FastifyReply, error: z.ZodError) {
  return reply.code(400).send({ error: "invalid_request", issues: error.issues });
}

export function buildServer(deps: ServerDeps): FastifyInstance {
  const app = Fastify({ logger: deps.logger ?? false, bodyLimit: 1024 * 1024 });

  app.get("/health", () => ({ ok: true }));

  // Everything except /health needs the local token: the backend can launch shells.
  app.addHook("onRequest", async (request, reply) => {
    if (request.url === "/health") return;
    if (!tokenMatches(deps.token, request.headers[TOKEN_HEADER])) {
      await reply.code(401).send({ error: "unauthorized" });
    }
  });

  // ------------------------------------------------------------- hooks
  // Hook responses must be 2xx: an empty body means "no decision", a JSON body is a decision.

  app.post("/hooks/stop", async (request, reply) => {
    const parsed = stopHookInput.safeParse(request.body);
    if (!parsed.success) return badRequest(reply, parsed.error);
    const decision = deps.service.onStop(parsed.data);
    return decision ? reply.send(decision) : reply.code(204).send();
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

  app.post("/steps", async (request, reply) => {
    const parsed = startStepRequest.safeParse(request.body);
    if (!parsed.success) return badRequest(reply, parsed.error);
    try {
      const row = await deps.service.start(parsed.data);
      return reply.code(201).send(toStepView(row));
    } catch (error) {
      if (error instanceof DuplicateStepError) return reply.code(409).send({ error: "duplicate_step", message: error.message });
      if (error instanceof StepRequestError) return reply.code(400).send({ error: "invalid_step", message: error.message });
      throw error;
    }
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
