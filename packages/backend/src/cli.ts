import { resolve } from "node:path";
import { parseArgs } from "node:util";
import type { RunView, StepView } from "@forge/shared";
import { startBackend } from "./app.js";
import { readToken, TOKEN_HEADER } from "./auth.js";
import { baseUrl, loadConfig } from "./config.js";

const USAGE = `Usage:
  pnpm forge serve
  pnpm forge run-task --project <path> --task <TASK-001> [--no-wait]
  pnpm forge status [<run-id>]
  pnpm forge resume <run-id> [--no-wait]
  pnpm forge cancel <run-id>

Exit codes of run-task and resume: 0 waiting_review, 1 failed, 3 needs_human, 4 cancelled.

Environment: FORGE_HOME (default ./.forge), FORGE_PORT (default 7420), FORGE_TMUX_SOCKET (default forge),
FORGE_CLAUDE_BIN (default claude), FORGE_ENGRAM_URL (default http://127.0.0.1:7437), FORGE_MAX_STOP_BLOCKS,
FORGE_CHECK_TIMEOUT_MS, FORGE_CLAUDE_CONFIG (default ~/.claude.json), FORGE_CHECK_TRUST=0 to skip the trust check.`;

const EXIT_BY_STATUS: Partial<Record<RunView["status"], number>> = { waiting_review: 0, failed: 1, needs_human: 3, cancelled: 4 };

interface RunDetail extends RunView {
  steps: StepView[];
  memories: { available: boolean; error?: string; items: { id: number; title: string; ref: string | null }[] };
}

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const config = loadConfig();
  let response: Response;
  try {
    response = await fetch(`${baseUrl(config)}${path}`, {
      ...init,
      headers: { "content-type": "application/json", [TOKEN_HEADER]: readToken(config.home), ...init.headers },
    });
  } catch {
    throw new Error(`Backend not reachable at ${baseUrl(config)}. Start it with: pnpm forge serve`);
  }
  const body = (await response.json()) as T & { message?: string; error?: string };
  if (!response.ok) throw new Error(body.message ?? body.error ?? `HTTP ${response.status}`);
  return body;
}

async function serve(): Promise<void> {
  const config = loadConfig();
  const backend = await startBackend(config, { logger: false });
  console.log(`Forge backend listening on ${backend.url} (home ${config.home}, tmux socket "${config.tmuxSocket}")`);
  const { resumed, orphaned } = backend.reconciled;
  if (resumed.length || orphaned.length) console.log(`Reconciled steps: ${resumed.length} resumed, ${orphaned.length} orphaned`);
  const stop = () => {
    console.log("Shutting down; step sessions keep running in tmux.");
    void backend.close().then(() => process.exit(0));
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

function describeStep(step: StepView): string {
  const reason = step.exitReason ? ` (${step.exitReason})` : "";
  return `${step.kind}#${step.attempt} ${step.status}${reason}`;
}

/** Prints run and step changes until the run stops needing the pipeline. */
async function waitForRun(runId: string): Promise<number> {
  const config = loadConfig();
  const seen = new Map<string, string>();
  let lastRun = "";
  for (;;) {
    const run = await api<RunDetail>(`/runs/${runId}`);
    for (const step of run.steps) {
      const line = describeStep(step);
      if (seen.get(step.id) !== line) {
        console.log(`[${new Date().toISOString()}]   step ${line}`);
        if (step.status === "needs_human") console.log(`    A person is needed: tmux -L ${config.tmuxSocket} attach -t ${step.tmuxSession}`);
        seen.set(step.id, line);
      }
    }
    const runLine = `${run.status}${run.exitReason ? ` (${run.exitReason})` : ""}`;
    if (runLine !== lastRun) {
      console.log(`[${new Date().toISOString()}] run ${runLine}`);
      lastRun = runLine;
    }
    const live = run.steps.some((s) => ["queued", "running", "needs_human"].includes(s.status));
    const exit = EXIT_BY_STATUS[run.status];
    if (exit !== undefined && !(run.status === "needs_human" && live)) {
      if (run.prUrl) console.log(`Pull request: ${run.prUrl}`);
      console.log(`Details: pnpm forge status ${run.id}`);
      return exit;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
}

async function runTask(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: { project: { type: "string" }, task: { type: "string" }, "no-wait": { type: "boolean", default: false } },
  });
  if (!values.project || !values.task) throw new Error(`Missing arguments.\n${USAGE}`);
  // pnpm runs scripts from the workspace root; INIT_CWD is where the user typed the command.
  const projectPath = resolve(process.env.INIT_CWD ?? process.cwd(), values.project);
  const run = await api<RunView>("/runs", { method: "POST", body: JSON.stringify({ projectPath, taskId: values.task }) });
  console.log(`Run ${run.id} for ${run.taskId} on branch ${run.branch} (${run.status}, step ${run.currentStep})`);
  return values["no-wait"] ? 0 : waitForRun(run.id);
}

function printStatus(run: RunDetail): void {
  console.log(`Run ${run.id} — ${run.taskId} — ${run.status}${run.exitReason ? ` (${run.exitReason})` : ""}`);
  console.log(`Branch ${run.branch} → ${run.baseBranch}; current step ${run.currentStep}; failures ${JSON.stringify(run.attempts)}`);
  if (run.prUrl) console.log(`Pull request ${run.prUrl}`);
  console.log("\nSteps:");
  for (const step of run.steps) {
    const duration = step.startedAt && step.endedAt ? `${Math.round((step.endedAt - step.startedAt) / 1000)}s` : "-";
    console.log(`  ${describeStep(step).padEnd(48)} ${(step.model ?? "").padEnd(8)} ${duration.padStart(6)}  ${step.summary?.split("\n")[0]?.slice(0, 80) ?? ""}`);
  }
  console.log(`\nMemories tagged ${run.taskId}/<step>:`);
  if (!run.memories.available) console.log(`  (Engram unavailable: ${run.memories.error ?? "unknown"})`);
  else if (run.memories.items.length === 0) console.log("  (none)");
  for (const m of run.memories.items) console.log(`  #${m.id} ${m.ref ?? ""} ${m.title}`);
}

async function main(): Promise<number> {
  const [command, ...rest] = process.argv.slice(2);
  switch (command) {
    case "serve":
      await serve();
      return -1;
    case "run-task":
      return runTask(rest);
    case "status": {
      if (!rest[0]) {
        for (const run of await api<RunView[]>("/runs")) console.log(`${run.id}  ${run.taskId}  ${run.status.padEnd(14)} ${run.currentStep}`);
        return 0;
      }
      printStatus(await api<RunDetail>(`/runs/${rest[0]}`));
      return 0;
    }
    case "resume": {
      const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { "no-wait": { type: "boolean", default: false } } });
      if (!positionals[0]) throw new Error(`Missing run id.\n${USAGE}`);
      const result = await api<{ message: string }>(`/runs/${positionals[0]}/resume`, { method: "POST", body: "{}" });
      console.log(result.message);
      return values["no-wait"] ? 0 : waitForRun(positionals[0]);
    }
    case "cancel": {
      if (!rest[0]) throw new Error(`Missing run id.\n${USAGE}`);
      console.log((await api<{ message: string }>(`/runs/${rest[0]}/cancel`, { method: "POST", body: "{}" })).message);
      return 0;
    }
    default:
      console.log(USAGE);
      return command ? 64 : 0;
  }
}

main().then(
  (code) => {
    if (code >= 0) process.exit(code);
  },
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  },
);
