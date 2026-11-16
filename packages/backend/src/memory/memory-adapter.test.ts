import { describe, expect, it } from "vitest";
import { EngramAdapter, MemoryUnavailableError } from "./memory-adapter.js";

const observation = (id: number, content: string, project = "demo-project") => ({
  id,
  title: `memory ${id}`,
  type: "decision",
  content,
  project,
  created_at: "2026-11-16 10:00:00",
  scope: "project",
});

function stub(body: unknown, status = 200) {
  const calls: string[] = [];
  const fetchImpl = (input: string) => {
    calls.push(input);
    return Promise.resolve(new Response(JSON.stringify(body), { status }));
  };
  return { calls, fetchImpl: fetchImpl as unknown as typeof fetch };
}

describe("EngramAdapter", () => {
  it("searches one project and extracts the TASK/step reference", async () => {
    const { calls, fetchImpl } = stub([observation(1, "**What**: store seam\nRef: TASK-001/plan")]);
    const memories = await new EngramAdapter("http://127.0.0.1:7437", fetchImpl).search("demo-project", "store", 5);
    expect(calls).toEqual(["http://127.0.0.1:7437/search?q=store&project=demo-project&limit=5"]);
    expect(memories).toEqual([expect.objectContaining({ id: 1, ref: "TASK-001/plan", project: "demo-project" })]);
  });

  it("lists only the memories that reference the task", async () => {
    const { calls, fetchImpl } = stub([
      observation(1, "Ref: TASK-001/plan"),
      observation(2, "Ref: TASK-0011/security"),
      observation(3, "no reference"),
      observation(4, "Ref: TASK-002/development"),
      observation(5, "Ref: TASK-001/e2e", "other-project"),
    ]);
    const memories = await new EngramAdapter("http://e", fetchImpl).listByTask("demo-project", "TASK-001");
    expect(calls[0]).toBe("http://e/observations?project=demo-project&limit=500");
    expect(calls[0]).not.toContain("all_projects");
    expect(memories.map((m) => m.ref)).toEqual(["TASK-001/plan"]);
  });

  it("reports an unreachable or failing Engram as unavailable", async () => {
    const down = (() => Promise.reject(new Error("ECONNREFUSED"))) as typeof fetch;
    await expect(new EngramAdapter("http://e", down).search("p", "q")).rejects.toThrow(MemoryUnavailableError);
    await expect(new EngramAdapter("http://e", stub({}, 500).fetchImpl).search("p", "q")).rejects.toThrow("HTTP 500");
    await expect(new EngramAdapter("http://e", stub({ not: "an array" }).fetchImpl).search("p", "q")).rejects.toThrow("Unexpected");
  });

  it("sends the bearer token when Engram has one configured", async () => {
    let auth: string | null = null;
    const fetchImpl = ((_: unknown, init?: RequestInit) => {
      auth = new Headers(init?.headers).get("authorization");
      return Promise.resolve(new Response("[]"));
    }) as typeof fetch;
    await new EngramAdapter("http://e", fetchImpl, "secret").search("p", "q");
    expect(auth).toBe("Bearer secret");
  });
});
