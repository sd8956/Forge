import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import type { ConsoleService } from "../console/console-service.js";
import type { ProjectStore } from "../db/project-store.js";
import { createConsoleMcpServer, type ConsoleToolDeps } from "../mcp/console-server.js";

const projectParams = z.object({ projectId: z.uuid() });
const bad = (reply: FastifyReply, error: z.ZodError) => reply.code(400).send({ error: "invalid_request", issues: error.issues });

/** The project console: its session and its `factory` MCP server. */
export function registerConsoleRoutes(app: FastifyInstance, deps: ConsoleToolDeps & { projects: ProjectStore; console: ConsoleService }): void {
  const withProject = (handler: (project: NonNullable<ReturnType<ProjectStore["get"]>>, reply: FastifyReply) => unknown) => async (request: { params: unknown }, reply: FastifyReply) => {
    const params = projectParams.safeParse(request.params);
    if (!params.success) return bad(reply, params.error);
    const project = deps.projects.get(params.data.projectId);
    if (!project) return reply.code(404).send({ error: "unknown_project" });
    return handler(project, reply);
  };

  app.get("/projects/:projectId/console", withProject(async (project) => ({ session: await deps.console.status(project) })));
  app.post("/projects/:projectId/console", withProject(async (project) => ({ session: await deps.console.start(project) })));
  app.delete("/projects/:projectId/console", withProject(async (project) => ({ stopped: await deps.console.stop(project) })));

  app.post(
    "/mcp/console/:projectId",
    withProject(async (project, reply) => {
      const server = createConsoleMcpServer(project.repoPath, deps);
      const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
      reply.hijack();
      reply.raw.on("close", () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      const request = reply.request;
      await transport.handleRequest(request.raw, reply.raw, request.body);
    }),
  );
}
