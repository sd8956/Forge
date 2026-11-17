import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { orchestratorStartRequest, queuePauseRequest } from "@forge/shared";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import type { PlanStore } from "../db/plan-store.js";
import type { ProjectStore } from "../db/project-store.js";
import { createOrchestratorMcpServer, type OrchestratorToolDeps } from "../mcp/orchestrator-server.js";
import { OrchestratorError, type OrchestratorService } from "../orchestrator/orchestrator-service.js";
import { planView, queueView } from "../orchestrator/views.js";

export interface OrchestratorRouteDeps extends OrchestratorToolDeps {
  plans: PlanStore;
  projects: ProjectStore;
  orchestrator: OrchestratorService;
}

const projectParams = z.object({ projectId: z.uuid() });
const planParams = z.object({ planId: z.uuid() });
const bad = (reply: FastifyReply, error: z.ZodError) => reply.code(400).send({ error: "invalid_request", issues: error.issues });

/**
 * The queue, plans and the orchestrator session. Approving a plan is a
 * person's action in the panel: the orchestrator has no HTTP access and its
 * MCP tools can only propose and read.
 */
export function registerOrchestratorRoutes(app: FastifyInstance, deps: OrchestratorRouteDeps): void {
  const project = (projectId: string) => deps.projects.get(projectId);

  app.get("/queue", (request, reply) => {
    const query = z.object({ projectId: z.uuid().optional() }).safeParse(request.query);
    if (!query.success) return bad(reply, query.error);
    const path = query.data.projectId ? project(query.data.projectId)?.repoPath : undefined;
    if (query.data.projectId && !path) return reply.code(404).send({ error: "unknown_project" });
    return queueView(deps, path);
  });

  app.post("/queue/pause", (request, reply) => {
    const body = queuePauseRequest.safeParse(request.body ?? {});
    if (!body.success) return bad(reply, body.error);
    deps.scheduler.pause(body.data.reason, "manual");
    return queueView(deps);
  });

  app.post("/queue/resume", () => {
    deps.scheduler.resume();
    return queueView(deps);
  });

  app.get("/projects/:projectId/plans", (request, reply) => {
    const params = projectParams.safeParse(request.params);
    if (!params.success) return bad(reply, params.error);
    const row = project(params.data.projectId);
    if (!row) return reply.code(404).send({ error: "unknown_project" });
    return deps.plans.plans(row.repoPath).slice(0, 20).map((p) => planView(deps, p));
  });

  for (const action of ["approve", "reject"] as const) {
    app.post(`/plans/:planId/${action}`, async (request, reply) => {
      const params = planParams.safeParse(request.params);
      if (!params.success) return bad(reply, params.error);
      const plan = deps.plans.get(params.data.planId);
      if (!plan) return reply.code(404).send({ error: "unknown_plan" });
      const result = action === "approve" ? deps.plans.approve(plan.id) : deps.plans.reject(plan.id) ? { ok: true as const } : { ok: false as const, message: `The plan is ${plan.status}` };
      if (!result.ok) return reply.code(409).send({ error: "plan_not_proposed", message: result.message });
      if (action === "approve") await deps.scheduler.tick();
      return planView(deps, deps.plans.get(plan.id) ?? plan);
    });
  }

  app.get("/projects/:projectId/orchestrator", async (request, reply) => {
    const params = projectParams.safeParse(request.params);
    if (!params.success) return bad(reply, params.error);
    const row = project(params.data.projectId);
    if (!row) return reply.code(404).send({ error: "unknown_project" });
    return { session: await deps.orchestrator.status(row) };
  });

  app.post("/projects/:projectId/orchestrator", async (request, reply) => {
    const params = projectParams.safeParse(request.params);
    const body = orchestratorStartRequest.safeParse(request.body ?? {});
    if (!params.success) return bad(reply, params.error);
    if (!body.success) return bad(reply, body.error);
    const row = project(params.data.projectId);
    if (!row) return reply.code(404).send({ error: "unknown_project" });
    try {
      return { session: await deps.orchestrator.start(row, body.data.prompt) };
    } catch (error) {
      if (error instanceof OrchestratorError) return reply.code(400).send({ error: "orchestrator_not_started", message: error.message });
      throw error;
    }
  });

  app.delete("/projects/:projectId/orchestrator", async (request, reply) => {
    const params = projectParams.safeParse(request.params);
    if (!params.success) return bad(reply, params.error);
    const row = project(params.data.projectId);
    if (!row) return reply.code(404).send({ error: "unknown_project" });
    return { stopped: await deps.orchestrator.stop(row) };
  });

  // The orchestrator's `factory` MCP server: stateless Streamable HTTP, one server per request.
  app.post("/mcp/orchestrator/:projectId", async (request, reply) => {
    const params = projectParams.safeParse(request.params);
    if (!params.success) return bad(reply, params.error);
    const row = project(params.data.projectId);
    if (!row) return reply.code(404).send({ error: "unknown_project" });
    const server = createOrchestratorMcpServer(row.repoPath, deps);
    const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
    reply.hijack();
    reply.raw.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(request.raw, reply.raw, request.body);
  });
}
