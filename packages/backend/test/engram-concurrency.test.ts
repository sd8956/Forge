import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect, it } from "vitest";
import { EngramAdapter } from "../src/memory/memory-adapter.js";

const engram = (() => {
  try {
    return execFileSync("which", ["engram"], { encoding: "utf8" }).trim() || null;
  } catch {
    return null;
  }
})();

const PROJECT = "forge-concurrency-check";
const SESSIONS = 6;
const SAVES_PER_SESSION = 15;
const BACKEND_SAVES = 15;

/**
 * docs/: "To validate: that Engram handles concurrent writes from several sessions without SQLite lock conflicts."
 * Each pipeline step starts its own `engram mcp` (stdio) on the same store, while the backend saves review feedback
 * over Engram's HTTP API. This runs that shape against a throwaway store. Skipped where Engram is not installed (CI).
 */
describe.skipIf(!engram)("Engram under concurrent writers", () => {
  it(`keeps every save from ${SESSIONS} MCP sessions and the HTTP API writing at once`, async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "forge-engram-"));
    const port = 17437 + Math.floor(Math.random() * 1000);
    const env = { ...process.env, ENGRAM_DATA_DIR: dataDir, ENGRAM_PORT: String(port) } as Record<string, string>;
    const server = spawn(engram!, ["serve", String(port)], { env, stdio: "ignore" });
    const clients: Client[] = [];
    try {
      const url = `http://127.0.0.1:${port}`;
      for (let i = 0; i < 100; i++) {
        if (await fetch(`${url}/health`).then((r) => r.ok, () => false)) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      for (let s = 0; s < SESSIONS; s++) {
        const client = new Client({ name: `step-${s}`, version: "0.0.0" });
        // Like a step's agent: `engram mcp --project <name>`, from a folder that is not a known project.
        await client.connect(new StdioClientTransport({ command: engram!, args: ["mcp", "--tools=agent", "--project", PROJECT], env, cwd: dataDir }));
        clients.push(client);
      }

      const errors: string[] = [];
      const started = Date.now();
      const mcpWrites = clients.flatMap((client, s) =>
        Array.from({ length: SAVES_PER_SESSION }, async (_, n) => {
          const result = (await client.callTool({
            name: "mem_save",
            // Agents leave `project` out and get the process default set by --project.
            arguments: { title: `step ${s} note ${n}`, type: "discovery", content: `**What**: concurrent save ${s}-${n}\nRef: TASK-00${s}/development`, capture_prompt: false },
          })) as { isError?: boolean; content?: { text?: string }[] };
          if (result.isError) errors.push(result.content?.[0]?.text ?? "unknown error");
        }),
      );
      const adapter = new EngramAdapter(url);
      const httpWrites = Array.from({ length: BACKEND_SAVES }, (_, n) =>
        adapter.save(PROJECT, { title: `backend note ${n}`, type: "learning", content: `**What**: backend save ${n}` }).catch((e: unknown) => {
          errors.push(String(e));
        }),
      );
      await Promise.all([...mcpWrites, ...httpWrites]);
      const elapsed = Date.now() - started;

      expect(errors).toEqual([]);
      const stored = await adapter.list(PROJECT, 1000);
      expect(stored).toHaveLength(SESSIONS * SAVES_PER_SESSION + BACKEND_SAVES);
      expect(new Set(stored.map((m) => m.title)).size).toBe(stored.length);
      console.log(`engram: ${stored.length} concurrent saves from ${SESSIONS} MCP sessions + HTTP in ${elapsed} ms, no errors`);
    } finally {
      await Promise.allSettled(clients.map((c) => c.close()));
      server.kill();
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, 120_000);
});
