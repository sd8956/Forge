import { resolve } from "node:path";
import { parseArgs } from "node:util";
import type { StepView } from "@forge/shared";
import { startBackend } from "./app.js";
import { readToken, TOKEN_HEADER } from "./auth.js";
import { baseUrl, loadConfig } from "./config.js";

const USAGE = `Usage:
  pnpm forge serve
  pnpm forge run-step --project <path> --task <TASK-001> --step <plan> [--timeout <minutes>] [--no-wait]
  pnpm forge status [<step-id>]

Environment: FORGE_HOME (default ./.forge), FORGE_PORT (default 7420), FORGE_TMUX_SOCKET (default forge),
FORGE_CLAUDE_BIN (default claude), FORGE_STEP_TIMEOUT_MS, FORGE_MAX_STOP_BLOCKS.`;

const EXIT_BY_STATUS: Record<string, number> = { done: 0, failed: 1, blocked: 2 };

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
  if (resumed.length || orphaned.length) console.log(`Reconciled: ${resumed.length} resumed, ${orphaned.length} orphaned`);
  const stop = () => {
    console.log("Shutting down; step sessions keep running in tmux.");
    void backend.close().then(() => process.exit(0));
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

async function runStep(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      project: { type: "string" },
      task: { type: "string" },
      step: { type: "string" },
      timeout: { type: "string" },
      "no-wait": { type: "boolean", default: false },
    },
  });
  if (!values.project || !values.task || !values.step) throw new Error(`Missing arguments.\n${USAGE}`);
  const timeoutMinutes = values.timeout ? Number(values.timeout) : undefined;
  const step = await api<StepView>("/steps", {
    method: "POST",
    // pnpm runs scripts from the workspace root; INIT_CWD is where the user typed the command.
    body: JSON.stringify({ projectPath: resolve(process.env.INIT_CWD ?? process.cwd(), values.project), taskId: values.task, step: values.step, timeoutMinutes }),
  });
  const config = loadConfig();
  console.log(`Step ${step.id} running in tmux session "${step.tmuxSession}"`);
  console.log(`Watch it: tmux -L ${config.tmuxSocket} attach -t ${step.tmuxSession}`);
  if (values["no-wait"]) return 0;
  return waitForStep(step.id);
}

async function waitForStep(stepId: string): Promise<number> {
  let last = "";
  for (;;) {
    const step = await api<StepView>(`/steps/${stepId}`);
    if (step.status !== last) {
      console.log(`[${new Date().toISOString()}] ${step.status}${step.exitReason ? ` (${step.exitReason})` : ""}`);
      if (step.status === "needs_human") console.log("A person is needed: attach to the session to answer.");
      last = step.status;
    }
    const exit = EXIT_BY_STATUS[step.status];
    if (exit !== undefined && step.endedAt !== null) {
      if (step.summary) console.log(`Summary: ${step.summary}`);
      if (step.artifacts.length) console.log(`Artifacts: ${step.artifacts.join(", ")}`);
      console.log(`Transcript: ${step.transcriptPath ?? "(not reported)"}`);
      return exit;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

async function status(argv: string[]): Promise<void> {
  const id = argv[0];
  const result = id ? await api<unknown>(`/steps/${id}`) : await api<StepView[]>("/steps");
  console.log(JSON.stringify(result, null, 2));
}

async function main(): Promise<number> {
  const [command, ...rest] = process.argv.slice(2);
  switch (command) {
    case "serve":
      await serve();
      return -1;
    case "run-step":
      return runStep(rest);
    case "status":
      await status(rest);
      return 0;
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
