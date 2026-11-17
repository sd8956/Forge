import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import fastifyStatic from "@fastify/static";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ProjectStore } from "../db/project-store.js";
import type { RunStore } from "../db/run-store.js";
import { listBacklog, ProjectConfigError } from "../projects/project-config.js";
import type { LoginCodes} from "./panel-auth.js";
import { SESSION_COOKIE, sessionCookieValue } from "./panel-auth.js";

export interface PanelDeps {
  token: string;
  baseUrl: () => string;
  projects: ProjectStore;
  runs: RunStore;
  codes: LoginCodes;
  /** Built panel (`packages/web/dist`); the panel routes still work without it. */
  webDist: string;
}

const CONTENT_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webm": "video/webm",
  ".zip": "application/zip",
  ".json": "application/json",
  ".md": "text/markdown; charset=utf-8",
  ".log": "text/plain; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

/**
 * Resolves a file of a run's handoff directory (`.factory/runs/<TASK>/`),
 * refusing anything outside it, including through symlinks.
 */
export function resolveRunFile(worktreePath: string, taskId: string, requested: string): string | null {
  if (!requested || isAbsolute(requested)) return null;
  const root = join(worktreePath, ".factory", "runs", taskId);
  const target = resolve(root, requested);
  const rel = relative(root, target);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return null;
  if (!existsSync(target) || !statSync(target).isFile()) return null;
  const real = relative(realpathSync(root), realpathSync(target));
  return real.startsWith("..") || isAbsolute(real) ? null : target;
}

export function loginUrl(deps: Pick<PanelDeps, "baseUrl" | "codes">): string {
  return `${deps.baseUrl()}/login?code=${deps.codes.create()}`;
}

export async function registerPanelRoutes(app: FastifyInstance, deps: PanelDeps): Promise<void> {
  // ------------------------------------------------------------ login
  app.get("/login", async (request, reply) => {
    const code = z.object({ code: z.string().min(1) }).safeParse(request.query);
    if (!code.success || !deps.codes.consume(code.data.code)) {
      return reply.code(401).type("text/html").send("<p>This login link is invalid or expired. Run <code>pnpm forge login</code> for a new one.</p>");
    }
    return reply
      .header("set-cookie", `${SESSION_COOKIE}=${sessionCookieValue(deps.token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000`)
      .redirect("/");
  });

  app.post("/auth/login-link", () => ({ url: loginUrl(deps) }));

  // --------------------------------------------------------- projects
  app.get("/projects", () => deps.projects.list());

  app.post("/projects", async (request, reply) => {
    const body = z.object({ path: z.string().min(1) }).safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_request", issues: body.error.issues });
    const path = resolve(body.data.path);
    if (!existsSync(join(path, ".git"))) return reply.code(400).send({ error: "invalid_project", message: `Not a git repository: ${path}` });
    try {
      return await reply.code(201).send(deps.projects.upsert(path));
    } catch (error) {
      if (error instanceof ProjectConfigError) return reply.code(400).send({ error: "invalid_project", message: error.message });
      throw error;
    }
  });

  app.get("/projects/:projectId/backlog", async (request, reply) => {
    const params = z.object({ projectId: z.uuid() }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "invalid_request" });
    const project = deps.projects.get(params.data.projectId);
    if (!project) return reply.code(404).send({ error: "unknown_project" });
    const runs = deps.runs.list().filter((r) => r.projectPath === project.repoPath);
    return listBacklog(project.repoPath).map((task) => {
      const latest = runs.filter((r) => r.taskId === task.id).at(-1);
      return { ...task, latestRun: latest ? { id: latest.id, status: latest.status } : null };
    });
  });

  // ------------------------------------------------------ run files
  app.get("/runs/:runId/files", async (request, reply) => {
    const params = z.object({ runId: z.uuid() }).safeParse(request.params);
    const query = z.object({ path: z.string().min(1).max(500) }).safeParse(request.query);
    if (!params.success || !query.success) return reply.code(400).send({ error: "invalid_request" });
    const run = deps.runs.get(params.data.runId);
    if (!run) return reply.code(404).send({ error: "unknown_run" });
    const file = resolveRunFile(run.worktreePath, run.taskId, query.data.path);
    if (!file) return reply.code(404).send({ error: "unknown_file" });
    return reply
      .type(CONTENT_TYPES[extname(file)] ?? "application/octet-stream")
      .header("x-content-type-options", "nosniff")
      .header("content-security-policy", "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'")
      .send(readFileSync(file));
  });

  // ---------------------------------------------------------- panel
  if (existsSync(join(deps.webDist, "index.html"))) {
    await app.register(fastifyStatic, { root: deps.webDist, prefix: "/", wildcard: false, index: ["index.html"] });
  } else {
    app.get("/", (_request, reply) =>
      reply.type("text/html").send("<p>The panel is not built yet. Run <code>pnpm --filter @forge/web build</code>.</p>"),
    );
  }
}
