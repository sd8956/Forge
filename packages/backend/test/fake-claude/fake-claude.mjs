#!/usr/bin/env node
// Fake `claude` binary for integration tests. It reads the same flags the
// runner passes to the real CLI, sends the hooks from the --settings file over
// HTTP and calls report_step through the --mcp-config server.
// FAKE_CLAUDE_SCENARIO picks the behaviour; FAKE_CLAUDE_TRACE logs what it saw.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const VARIADIC = new Set(["--mcp-config"]);
const WITH_VALUE = new Set(["--agent", "--session-id", "--setting-sources", "--settings", "--mcp-config", "--model", "--permission-mode"]);

function parseArgv(argv) {
  const flags = {};
  const positionals = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!WITH_VALUE.has(arg)) {
      positionals.push(arg);
      continue;
    }
    if (VARIADIC.has(arg)) {
      const values = [];
      while (i + 1 < argv.length && !argv[i + 1].startsWith("--")) values.push(argv[++i]);
      flags[arg] = values;
    } else {
      flags[arg] = argv[++i];
    }
  }
  return { flags, positionals };
}

const { flags, positionals } = parseArgv(process.argv.slice(2));
const sessionId = flags["--session-id"];
const settings = JSON.parse(readFileSync(flags["--settings"], "utf8"));
const mcpConfig = JSON.parse(readFileSync(flags["--mcp-config"][0], "utf8"));
const scenario = process.env.FAKE_CLAUDE_SCENARIO ?? "report";
const transcriptPath = join(process.env.FAKE_CLAUDE_TRANSCRIPT_DIR ?? tmpdir(), `${sessionId}.jsonl`);
writeFileSync(transcriptPath, "");

function trace(type, data = {}) {
  const file = process.env.FAKE_CLAUDE_TRACE;
  if (file) appendFileSync(file, `${JSON.stringify({ type, ...data })}\n`);
}

trace("started", { agent: flags["--agent"], prompt: positionals[0], settingSources: flags["--setting-sources"], permissionMode: flags["--permission-mode"], scenario });

async function hook(event, extra = {}) {
  const body = { session_id: sessionId, transcript_path: transcriptPath, cwd: process.cwd(), hook_event_name: event, ...extra };
  let decision = null;
  for (const group of settings.hooks?.[event] ?? []) {
    if (group.matcher && extra.notification_type && !new RegExp(`^(${group.matcher})$`).test(extra.notification_type)) continue;
    for (const h of group.hooks) {
      if (h.type !== "http") continue;
      const response = await fetch(h.url, { method: "POST", headers: { "content-type": "application/json", ...h.headers }, body: JSON.stringify(body) });
      const text = await response.text();
      trace("hook", { event, status: response.status, body: text });
      if (response.ok && text) decision = JSON.parse(text);
    }
  }
  return decision;
}

async function reportStep(args) {
  const server = mcpConfig.mcpServers.factory;
  const client = new Client({ name: "fake-claude", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: server.headers } }));
  const tools = await client.listTools();
  trace("tools", { names: tools.tools.map((t) => t.name) });
  const result = await client.callTool({ name: "report_step", arguments: args });
  trace("report_step", { isError: result.isError ?? false, text: result.content?.[0]?.text });
  await client.close();
  return result;
}

/** Ends a turn; returns true when the Stop hook let the session stop. */
async function stop(stopHookActive = false) {
  const decision = await hook("Stop", { stop_hook_active: stopHookActive, background_tasks: [] });
  return decision?.decision !== "block";
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForRelease() {
  const file = process.env.FAKE_CLAUDE_RELEASE;
  while (!file || !existsSync(file)) await sleep(100);
}

function idleForever() {
  setInterval(() => undefined, 60_000);
}

let ending = false;
async function endSession(reason) {
  if (ending) return;
  ending = true;
  await hook("SessionEnd", { reason }).catch(() => undefined);
  trace("ended", { reason });
  process.exit(0);
}
// tmux kill-session sends SIGHUP; the real CLI then fires SessionEnd with reason "other".
process.on("SIGHUP", () => void endSession("other"));
process.on("SIGTERM", () => void endSession("other"));

const inputPath = positionals[0]?.match(/Read (\S+) and run the step/)?.[1];
const report = { status: "done", summary: "Fake planner finished.", artifacts: [] };

async function main() {
  if (inputPath && existsSync(inputPath)) {
    trace("input", { path: inputPath });
    writeFileSync(inputPath.replace(/input\.md$/, "output.md"), "## Summary\nFake output.\n");
    report.artifacts = [inputPath.replace(/input\.md$/, "output.md")];
  }
  switch (scenario) {
    case "report":
      await reportStep(report);
      await stop();
      break;
    case "stop-then-report": {
      const allowed = await stop();
      trace("first_stop", { allowed });
      await reportStep(report);
      await stop(true);
      break;
    }
    case "never-report": {
      let active = false;
      for (let i = 0; i < 10 && !(await stop(active)); i++) active = true;
      break;
    }
    case "permission":
      await hook("Notification", { notification_type: "permission_prompt", message: "Claude needs your permission to use Bash" });
      await waitForRelease();
      await reportStep(report);
      await stop();
      break;
    case "wait-release":
      await waitForRelease();
      await reportStep(report);
      await stop();
      break;
    case "exit-without-report":
      await endSession("prompt_input_exit");
      return;
    case "crash":
      process.exit(3);
      return;
    case "hang":
      break;
    default:
      throw new Error(`Unknown scenario ${scenario}`);
  }
  idleForever();
}

main().catch((error) => {
  trace("error", { message: String(error) });
  idleForever();
});
