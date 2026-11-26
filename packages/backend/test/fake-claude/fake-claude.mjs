#!/usr/bin/env node
// Fake `claude` for integration tests. It reads the same flags the runner passes to the real CLI,
// reads the step's input.md, writes a valid (or deliberately broken) output.md and artifacts for
// that step kind, sends the hooks from --settings over HTTP and calls report_step through the
// --mcp-config server.
//
// FAKE_CLAUDE_SCRIPT: JSON {"<step kind>" or "<TASK>:<step kind>": ["<behaviour for attempt 1>", ...], "default": "done"}
// Behaviours: done, failed, blocked, stop-then-report, never-report, permission, wait-release,
// bad-output-then-fix, exit-without-report, crash, hang, rate-limit (StopFailure rate_limit, then idle).
// FAKE_USAGE_PERCENT: when set, the fake runs the settings' statusLine once with that 5-hour usage.
// FAKE_CLAUDE_TRACE: JSONL file where the fake logs what it saw.
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { parse, stringify } from "yaml";

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
const transcriptPath = join(process.env.FAKE_CLAUDE_TRANSCRIPT_DIR ?? tmpdir(), `${sessionId}.jsonl`);
writeFileSync(transcriptPath, "");

function trace(type, data = {}) {
  const file = process.env.FAKE_CLAUDE_TRACE;
  if (file) appendFileSync(file, `${JSON.stringify({ type, session: sessionId, ...data })}\n`);
}

// ------------------------------------------------------------------ input.md

const inputPath = positionals[0]?.match(/Read (\S+) and run the step/)?.[1];
const input = inputPath && existsSync(inputPath) ? readFileSync(inputPath, "utf8") : "";
const field = (name) => new RegExp(`^- ${name}: \`?([^\`\\n]+)\`?`, "m").exec(input)?.[1];
const kind = /^- Step: `([a-z0-9_-]+)`/m.exec(input)?.[1] ?? "unknown";
const attempt = Number(field("Attempt") ?? 1);
const outputDir = field("Output directory");
const taskId = /^# Step input: \S+ — (TASK-\d+|DEF-[0-9a-f]+)/m.exec(input)?.[1];
const template = parse(/```yaml\n---\n([\s\S]*?)\n---\n```/.exec(input)?.[1] ?? "{}") ?? {};

const script = JSON.parse(process.env.FAKE_CLAUDE_SCRIPT ?? "{}");
// "TASK-003:plan" beats "plan", so one backend can run different scripts per task.
const behaviour = script[`${taskId}:${kind}`]?.[attempt - 1] ?? script[kind]?.[attempt - 1] ?? script.default ?? "done";

// Something on the screen for the terminal bridge, and a record of what a person types.
process.stdout.write(`fake claude ready: ${kind} attempt ${attempt}\r\n`);
process.stdin.on("data", (chunk) => trace("stdin", { data: chunk.toString() }));
// When tmux kills the session the pty goes away: reading or writing it fails with EIO. Without these
// handlers that error would crash the fake before it sends SessionEnd, as the real CLI does.
process.stdin.on("error", () => undefined);
process.stdout.on("error", () => undefined);

trace("started", {
  agent: flags["--agent"],
  prompt: positionals[0],
  settingSources: flags["--setting-sources"],
  permissionMode: flags["--permission-mode"],
  model: flags["--model"],
  kind,
  attempt,
  behaviour,
});

// ----------------------------------------------------------------- artifacts

function writeFile(rel, content) {
  mkdirSync(dirname(rel), { recursive: true });
  writeFileSync(rel, content);
  return rel;
}

/** Path of the latest plan test-plan.md, from the "Earlier steps" section of input.md. */
function testPlanPath() {
  const planOutput = /### plan\n\n[\s\S]*?- `([^`]+\/output\.md)`/.exec(input)?.[1];
  return planOutput ? join(dirname(planOutput), "test-plan.md") : undefined;
}

/** Valid `.factory/` files for each definition stage, like a stage session would write them. */
const DEFINITION_FILES = {
  def_intake: {
    ".factory/intake.md": "# Intake\n\nA link shortener for a small team. Web only.\n\n> Paste a long link and get a short one that opens the original page.\n",
    ".factory/project.yaml": "name: shortener\nplatforms: [web]\n",
  },
  def_requirements: {
    ".factory/requirements.md":
      "# Requirements\n\n### FR-001 Shorten a link\n\nSource: intake \"Paste a long link and get a short one\"\n\n- Given a valid URL, when I press \"Shorten\", then I see a short link.\n\n### FR-002 Open a short link\n\nSource: intake \"a short one that opens the original page\"\n\n- Given a short link, when I open it, then I am redirected.\n\n## Non-functional requirements\n\n- NFR-01 Performance: redirects answer in under 50 ms (p95).\n",
  },
  def_architecture: {
    ".factory/architecture.md": "# Architecture\n\nNode server in src/, page in public/.\n",
    ".factory/adr/0001-node.md": "# ADR 0001 — Node without dependencies\n",
    ".factory/threat-model.md":
      "# Threat model\n\n| Threat | STRIDE |\n| --- | --- |\n| a | Spoofing |\n| b | Tampering |\n| c | Repudiation |\n| d | Information disclosure |\n| e | Denial of service |\n| f | Elevation of privilege |\n",
    ".factory/project.yaml": "name: shortener\nplatforms: [web]\ncommands:\n  check: make check\n  e2e: make e2e\n  up: make up\n",
  },
  def_test_strategy: { ".factory/test-strategy.md": "# Test strategy\n\nPlaywright for the web. Evidence: a screenshot per step.\n" },
  def_design: {
    ".factory/design/tokens.json": '{"color": {"brand": "#c2410c"}, "radius": {"card": "10px"}, "typography": {"body": "Inter, sans-serif"}}\n',
    ".factory/design/components.md": "# Components\n\n## Link form\n\n- Library: Base UI (Field, Input)\n",
    ".factory/prototype/index.html": "<!doctype html><title>Shorten</title><h1>Shorten a link</h1><p>Design attempt ATTEMPT</p><script>document.title = 'prototype ran'</script>\n",
    ".factory/prototype/stats.html": "<!doctype html><title>Stats</title><h1>Link stats</h1>\n",
  },
  def_backlog: {
    ".factory/backlog/TASK-001.md": "# TASK-001 — Shorten and open links\n\n- Covers: FR-001, FR-002, NFR-01\n- Size: S\n- Depends on: none\n\n## Acceptance criteria\n\n- AC-1 (FR-001) Given a URL, when I shorten it, then I see a link.\n",
  },
};

function produceDefinition(status, { valid = true } = {}) {
  const written = DEFINITION_FILES[kind] ?? {};
  const entries = Object.entries(written).slice(0, valid ? undefined : -1);
  // When the person asked for changes, the fake records the request in the first file it writes.
  const feedback = /## Changes the person asked for\n\n[^\n]*\n\n> ([^\n]+)/.exec(input)?.[1];
  const files = entries.map(([rel, raw], i) => {
    const content = raw.replace("ATTEMPT", String(attempt));
    return writeFile(rel, i === 0 && feedback && rel.endsWith(".md") ? `${content}\nChanged after review: ${feedback}\n` : content);
  });
  const outputMd = join(outputDir, "output.md");
  const summary = `Fake ${kind} attempt ${attempt}: ${status}`;
  writeFile(outputMd, `---\n${stringify({ ...template, step: kind, task: taskId, attempt, status, summary, artifacts: files })}---\n\n${summary}\n`);
  return { status, summary, artifacts: [outputMd, ...files] };
}

function produce(status) {
  if (kind.startsWith("def_")) return produceDefinition(status);
  const files = [];
  const extras = {};
  const out = (name, content) => files.push(writeFile(join(outputDir, name), content));
  switch (kind) {
    case "plan": {
      const acs = [...new Set(readFileSync(join(".factory", "backlog", `${taskId}.md`), "utf8").match(/\bAC-\d+\b/g) ?? [])];
      out("plan.md", "# Plan\nFake plan.\n");
      out("test-plan.md", `# Test plan\n\n${acs.map((ac, i) => `### TC-${String(i + 1).padStart(2, "0")} — covers ${ac}\n`).join("\n")}`);
      Object.assign(extras, { test_cases: acs.length, covered_acs: acs });
      break;
    }
    case "design":
      out("design.md", "# Design\nFake design.\n");
      break;
    case "development": {
      out("dev-notes.md", "# Dev notes\nFake change.\n");
      // Test first: the failing test is committed before the fix, as the tdd evidence requires.
      const commit = (message) => {
        execFileSync("git", ["-c", "user.name=fake", "-c", "user.email=fake@example.invalid", "commit", "-q", "--allow-empty", "-m", message]);
        return execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
      };
      const red = commit(`test: fake failing test attempt ${attempt}`);
      const green = commit(`feat: fake development attempt ${attempt}`);
      const plan = testPlanPath();
      const tcs = plan && existsSync(plan) ? [...new Set(readFileSync(plan, "utf8").match(/\bTC-\d+\b/g) ?? [])] : [];
      extras.commits = [red, green];
      extras.tdd = [{ cases: tcs.length ? tcs : ["TC-01"], test: "test/fake.test.js", red: "fake test: 1 failing", red_commit: red, green: "fake test: 1 passing" }];
      break;
    }
    case "security":
      out("security-report.md", status === "failed" ? "# Security\n| 1 | gitleaks | src/config.js:1 | high | confirmed | token |\n" : "# Security\nNo findings.\n");
      extras.findings = { critical: 0, high: status === "failed" ? 1 : 0, medium: 0, low: 0 };
      break;
    case "e2e": {
      const plan = testPlanPath();
      const tcs = plan && existsSync(plan) ? [...new Set(readFileSync(plan, "utf8").match(/\bTC-\d+\b/g) ?? [])] : ["TC-01"];
      const cases = tcs.map((id, i) => {
        files.push(writeFile(join(outputDir, "evidence", id, "01-step.png"), "png"));
        return { id, frs: ["FR-001"], result: status === "failed" && i === 0 ? "failed" : "passed", proves: `fake state of ${id}`, files: [`${id}/01-step.png`] };
      });
      const spec = readFileSync(join(".factory", "backlog", `${taskId}.md`), "utf8");
      const covers = /^\s*-\s*Covers:\s*(.+)$/im.exec(spec)?.[1] ?? "";
      const verdicts = (found) => [...new Set(found ?? [])].map((id) => ({ id, verdict: status === "failed" ? "unmet" : "met", cases: [cases[0].id] }));
      const manifest = { task: taskId, cases, criteria: verdicts(spec.match(/\bAC-\d+\b/g)), requirements: verdicts(covers.match(/\bFR-\d+\b/g)) };
      out("evidence/manifest.json", JSON.stringify(manifest, null, 2));
      out("test-report.md", `# Test report\n${cases.map((c) => `| ${c.id} | ${c.result} |`).join("\n")}\n`);
      const failed = cases.filter((c) => c.result === "failed").length;
      extras.tests = { total: cases.length, passed: cases.length - failed, failed };
      break;
    }
    case "pr":
      out("pr.md", ["Why", "What changed", "Scope", "Tradeoffs", "Blast radius", "Verification"].map((t) => `## ${t}\nFake.\n`).join("\n"));
      Object.assign(extras, { pr_url: "https://github.com/example/demo-project/pull/7", pr_number: 7 });
      break;
    case "review_fix": {
      const threads = [...input.matchAll(/^### `([^`]+)`/gm)].map((m) => m[1]);
      const prNumber = /already has PR #(\d+)/.exec(input)?.[1];
      const answered = threads.map((id) => {
        const reply = `Fake fix for ${id}. <!-- forge:reply -->`;
        const commentId = /^review_comment:(\d+)$/.exec(id)?.[1];
        if (commentId && prNumber && process.env.FAKE_GH_BIN) {
          execFileSync(process.env.FAKE_GH_BIN, ["api", "-X", "POST", `repos/o/r/pulls/${prNumber}/comments/${commentId}/replies`, "-f", `body=${reply}`]);
        }
        return { id, action: "fixed", reply };
      });
      out("replies.md", `# Replies\n${answered.map((t) => `- ${t.id}: ${t.reply}`).join("\n")}\n`);
      execFileSync("git", ["-c", "user.name=fake", "-c", "user.email=fake@example.invalid", "commit", "-q", "--allow-empty", "-m", `fix: address review attempt ${attempt}`]);
      Object.assign(extras, { threads: answered, commits: [execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim()] });
      trace("review_fix", { threads, prNumber });
      break;
    }
  }
  const outputMd = join(outputDir, "output.md");
  const artifacts = [outputMd, ...files];
  const summary = `Fake ${kind} attempt ${attempt}: ${status}`;
  const frontmatter = { ...template, step: kind, task: taskId, attempt, status, summary, artifacts, ...extras };
  writeFile(outputMd, `---\n${stringify(frontmatter)}---\n\n## Summary\n${summary}\n`);
  return { status, summary, artifacts };
}

// ---------------------------------------------------------- hooks and report

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
  const result = await client.callTool({ name: kind.startsWith("def_") ? "report_stage" : "report_step", arguments: args });
  trace("report_step", { kind, attempt, status: args.status, isError: result.isError ?? false, text: result.content?.[0]?.text });
  await client.close();
  return result;
}

/** Ends a turn; returns true when the Stop hook let the session stop. */
async function stop(stopHookActive = false) {
  const decision = await hook("Stop", { stop_hook_active: stopHookActive, background_tasks: [] });
  return decision?.decision !== "block";
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForRelease(file = process.env.FAKE_CLAUDE_RELEASE) {
  while (!file || !existsSync(file)) await sleep(100);
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

async function finish(status) {
  await reportStep(produce(status));
  await stop();
}

/** Runs the settings' status line once, as Claude Code does after the first API response. */
function statusLine() {
  const percent = process.env.FAKE_USAGE_PERCENT;
  if (!settings.statusLine?.command || percent === undefined) return;
  const resetsAt = Math.floor(Date.now() / 1000) + Number(process.env.FAKE_USAGE_RESETS_IN_S ?? 3600);
  const status = { session_id: sessionId, model: { id: "fake" }, rate_limits: { five_hour: { used_percentage: Number(percent), resets_at: resetsAt } } };
  try {
    const shown = execFileSync("sh", ["-c", settings.statusLine.command], { input: JSON.stringify(status), encoding: "utf8", timeout: 5000 });
    trace("status_line", { shown: shown.trim() });
  } catch (error) {
    trace("status_line_failed", { message: String(error) });
  }
}

async function main() {
  statusLine();
  switch (behaviour) {
    case "done":
    case "failed":
    case "blocked":
      await finish(behaviour);
      break;
    case "bad-output-then-fix": {
      const report = produce("done");
      writeFile(join(outputDir, "output.md"), "no frontmatter here\n");
      const first = await reportStep(report);
      trace("first_report", { isError: first.isError ?? false });
      await finish("done");
      break;
    }
    case "stop-then-report": {
      trace("first_stop", { allowed: await stop() });
      await reportStep(produce("done"));
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
      // The person answered and the tool ran: Claude Code fires PostToolUse.
      await hook("PostToolUse", { tool_name: "Bash", tool_input: { command: "gh auth status" } });
      trace("resumed");
      await waitForRelease(process.env.FAKE_CLAUDE_RELEASE_2);
      await finish("done");
      break;
    case "guarded-write": {
      const denied = await hook("PreToolUse", { tool_name: "Bash", tool_input: { command: "cat > notes.md <<'EOF'\nhi\nEOF" } });
      const allowed = await hook("PreToolUse", { tool_name: "Bash", tool_input: { command: "make check" } });
      trace("guard", { denied, allowed });
      await finish("done");
      break;
    }
    case "wait-release":
      await waitForRelease();
      await finish("done");
      break;
    case "exit-without-report":
      await endSession("prompt_input_exit");
      return;
    case "crash":
      process.exit(3);
      return;
    case "hang":
      break;
    case "def-invalid-then-fix": {
      // The first report misses a file; Forge rejects it with the issues, and the session fixes it.
      const rejected = await reportStep(produceDefinition("done", { valid: false }));
      trace("def_rejected", { isError: rejected.isError ?? false, text: rejected.content?.[0]?.text });
      await finish("done");
      break;
    }
    case "write-outside": {
      const outside = await hook("PreToolUse", { tool_name: "Write", tool_input: { file_path: join(process.cwd(), "src", "hack.js"), content: "x" } });
      const inside = await hook("PreToolUse", { tool_name: "Write", tool_input: { file_path: join(process.cwd(), ".factory", "intake.md"), content: "x" } });
      trace("guard", { outside, inside });
      await finish("done");
      break;
    }
    case "rate-limit":
      // Claude Code ends the turn on a usage limit and waits; only the StopFailure hook says why.
      await hook("StopFailure", { error: "rate_limit", last_assistant_message: "You've hit your usage limit" });
      break;
    default:
      throw new Error(`Unknown behaviour ${behaviour}`);
  }
  setInterval(() => undefined, 60_000);
}

main().catch((error) => {
  trace("error", { message: String(error), stack: error?.stack });
  setInterval(() => undefined, 60_000);
});
