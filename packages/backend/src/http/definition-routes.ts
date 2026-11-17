import { createReadStream } from "node:fs";
import { extname } from "node:path";
import { approveScreenRequest, DEFINITION_STAGES, requestChangesRequest, startDefinitionRequest } from "@forge/shared";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { DefinitionError, type DefinitionService } from "../definition/definition-service.js";

const projectParams = z.object({ projectId: z.uuid() });
const stageParams = projectParams.extend({ stage: z.enum(DEFINITION_STAGES) });
const bad = (reply: FastifyReply, error: z.ZodError) => reply.code(400).send({ error: "invalid_request", issues: error.issues });

const TYPES: Record<string, string> = { ".md": "text/markdown; charset=utf-8", ".json": "application/json; charset=utf-8", ".yaml": "text/yaml; charset=utf-8", ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png" };

/**
 * A prototype is untrusted generated HTML. The panel shows it in an iframe
 * with `sandbox="allow-scripts"` (an opaque origin, so it cannot read the
 * panel or its cookie), and this CSP keeps it from reaching the network.
 */
export const PROTOTYPE_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; sandbox allow-scripts";

export function registerDefinitionRoutes(app: FastifyInstance, definition: DefinitionService): void {
  const fail = (reply: FastifyReply, error: unknown) => {
    if (error instanceof DefinitionError) return reply.code(409).send({ error: "definition_refused", message: error.message });
    throw error;
  };

  app.get("/definitions", () => definition.list());

  app.post("/definitions", async (request, reply) => {
    const body = startDefinitionRequest.safeParse(request.body);
    if (!body.success) return bad(reply, body.error);
    try {
      return await reply.code(201).send(await definition.begin(body.data.path, body.data.idea));
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.get("/projects/:projectId/definition", (request, reply) => {
    const params = projectParams.safeParse(request.params);
    if (!params.success) return bad(reply, params.error);
    if (!definition.get(params.data.projectId)) return reply.code(404).send({ error: "no_definition" });
    return definition.view(params.data.projectId);
  });

  app.post("/projects/:projectId/definition/:stage/approve", async (request, reply) => {
    const params = stageParams.safeParse(request.params);
    if (!params.success) return bad(reply, params.error);
    try {
      return await definition.approve(params.data.projectId, params.data.stage);
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.post("/projects/:projectId/definition/:stage/changes", async (request, reply) => {
    const params = stageParams.safeParse(request.params);
    const body = requestChangesRequest.safeParse(request.body);
    if (!params.success) return bad(reply, params.error);
    if (!body.success) return bad(reply, body.error);
    try {
      return await definition.requestChanges(params.data.projectId, params.data.stage, body.data.feedback);
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.post("/projects/:projectId/definition/:stage/retry", async (request, reply) => {
    const params = stageParams.safeParse(request.params);
    if (!params.success) return bad(reply, params.error);
    try {
      await definition.retry(params.data.projectId, params.data.stage);
      return definition.view(params.data.projectId);
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.post("/projects/:projectId/definition/screens/approve", (request, reply) => {
    const params = projectParams.safeParse(request.params);
    const body = approveScreenRequest.safeParse(request.body);
    if (!params.success) return bad(reply, params.error);
    if (!body.success) return bad(reply, body.error);
    try {
      definition.approveScreen(params.data.projectId, body.data.screen);
      return definition.view(params.data.projectId);
    } catch (error) {
      return fail(reply, error);
    }
  });

  /** A file under .factory/ of the definition worktree (documents and prototype screens). */
  app.get("/projects/:projectId/definition/files/*", (request, reply) => {
    const params = projectParams.extend({ "*": z.string().min(1) }).safeParse(request.params);
    if (!params.success) return bad(reply, params.error);
    if (!definition.get(params.data.projectId)) return reply.code(404).send({ error: "no_definition" });
    const file = definition.filePath(params.data.projectId, `.factory/${params.data["*"]}`);
    if (!file) return reply.code(404).send({ error: "not_found" });
    const type = TYPES[extname(file)] ?? "text/plain; charset=utf-8";
    if (type.startsWith("text/html") || type.startsWith("text/javascript") || type.startsWith("image/svg")) reply.header("content-security-policy", PROTOTYPE_CSP);
    return reply.header("content-type", type).header("x-content-type-options", "nosniff").send(createReadStream(file));
  });
}
