import { z } from "zod";

export interface Memory {
  id: number;
  title: string;
  type: string;
  content: string;
  project: string;
  createdAt: string;
  /** `TASK-xxx/<step>` reference found in the content, if any. */
  ref: string | null;
}

/**
 * Read access to long-term memory. Agents write through their own MCP server;
 * the backend only reads, so the memory provider can change without touching steps.
 */
export interface MemoryAdapter {
  search(project: string, query: string, limit?: number): Promise<Memory[]>;
  /** Memories whose content carries a `TASK-xxx/<step>` reference to this task. */
  listByTask(project: string, taskId: string): Promise<Memory[]>;
  /** Saves one observation in the project, under a backend-owned session. */
  save(project: string, observation: { title: string; type: string; content: string }): Promise<number>;
}

export const REF_PATTERN = /\b(TASK-\d{3,})\/([a-z][a-z0-9-]*)\b/;

const engramObservation = z.looseObject({
  id: z.number(),
  title: z.string(),
  type: z.string(),
  content: z.string(),
  project: z.string().nullable().optional(),
  created_at: z.string(),
});

export class MemoryUnavailableError extends Error {}

/** Engram through its local HTTP API (`engram serve`, default 127.0.0.1:7437). */
export class EngramAdapter implements MemoryAdapter {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly token?: string,
  ) {}

  async search(project: string, query: string, limit = 10): Promise<Memory[]> {
    return this.get("/search", { q: query, project, limit: String(limit) });
  }

  async listByTask(project: string, taskId: string): Promise<Memory[]> {
    const recent = await this.get("/observations", { project, limit: "500" });
    return recent.filter((m) => m.ref?.startsWith(`${taskId}/`));
  }

  async save(project: string, observation: { title: string; type: string; content: string }): Promise<number> {
    // Engram only accepts observations for an existing session; creating it is idempotent.
    const session = `forge-backend-${project}`;
    await this.post("/sessions", { id: session, project });
    const saved = z.object({ id: z.number() }).parse(await this.post("/observations", { session_id: session, project, capture_prompt: false, ...observation }));
    return saved.id;
  }

  private async post(path: string, body: unknown): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(this.token ? { authorization: `Bearer ${this.token}` } : {}) },
        body: JSON.stringify(body),
      });
    } catch (error) {
      throw new MemoryUnavailableError(`Engram not reachable at ${this.baseUrl}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!response.ok) throw new MemoryUnavailableError(`Engram ${path} answered HTTP ${response.status}`);
    return response.json();
  }

  private async get(path: string, params: Record<string, string>): Promise<Memory[]> {
    // Always scoped to one project: never all_projects.
    const url = `${this.baseUrl}${path}?${new URLSearchParams(params).toString()}`;
    let response: Response;
    try {
      response = await this.fetchImpl(url, { headers: this.token ? { authorization: `Bearer ${this.token}` } : {} });
    } catch (error) {
      throw new MemoryUnavailableError(`Engram not reachable at ${this.baseUrl}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!response.ok) throw new MemoryUnavailableError(`Engram ${path} answered HTTP ${response.status}`);
    const parsed = z.array(engramObservation).safeParse(await response.json());
    if (!parsed.success) throw new MemoryUnavailableError(`Unexpected Engram ${path} response: ${parsed.error.issues[0]?.message ?? "invalid"}`);
    return parsed.data
      .filter((o) => o.project === params.project)
      .map((o) => {
        const match = REF_PATTERN.exec(o.content);
        return {
          id: o.id,
          title: o.title,
          type: o.type,
          content: o.content,
          project: o.project ?? "",
          createdAt: o.created_at,
          ref: match ? `${match[1]}/${match[2]}` : null,
        };
      });
  }
}
