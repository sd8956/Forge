import { execFileSync, spawn } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO = resolve(import.meta.dirname, "..", "..", "..");
export const STATE_FILE = join(REPO, ".forge-e2e", "state.json");

export interface E2eState {
  url: string;
  token: string;
  project: string;
  newApp: string;
  root: string;
  ghState: string;
  pid: number;
  socket: string;
  engramPid: number;
}

/** Starts `forge serve` against a throwaway copy of the fixture, with fake claude and fake gh. */
export default async function globalSetup(): Promise<void> {
  if (!existsSync(join(REPO, "packages", "web", "dist", "index.html"))) throw new Error("Build the panel first: pnpm build:web");
  const root = mkdtempSync(join(tmpdir(), "forge-e2e-"));
  const project = join(root, "demo-project");
  cpSync(join(REPO, "fixtures", "demo-project"), project, { recursive: true, filter: (src) => !src.includes("node_modules") });
  writeFileSync(
    join(project, ".factory", "backlog", "TASK-003.md"),
    "# TASK-003 — Health endpoint\n\n- Covers: NFR-01\n- Size: S\n- Depends on: none\n\n## Acceptance criteria\n\n- AC-1 (NFR-01) `GET /health` answers 200.\n",
  );
  const yaml = join(project, ".factory", "project.yaml");
  writeFileSync(yaml, readFileSync(yaml, "utf8").replace(/^\s*poll_interval_seconds: \d+\n/m, ""));
  const git = (...args: string[]) => execFileSync("git", ["-C", project, "-c", "user.name=e2e", "-c", "user.email=e2e@example.invalid", ...args], { stdio: "pipe" });
  git("init", "-q", "-b", "main");
  git("add", ".");
  git("commit", "-qm", "init");
  git("remote", "add", "origin", "git@github.com:example/demo-project.git");

  // An empty clone of a new repository, for the Definition panel.
  const newApp = join(root, "newapp");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", join(root, "newapp-origin.git")]);
  execFileSync("mkdir", ["-p", newApp]);
  execFileSync("git", ["-C", newApp, "init", "-q", "-b", "main"]);
  execFileSync("git", ["-C", newApp, "remote", "add", "origin", join(root, "newapp-origin.git")]);

  const ghState = join(root, "gh.json");
  writeFileSync(ghState, JSON.stringify({ login: "sd8956", prs: { "7": { state: "OPEN", headRefOid: "abc1234", statusCheckRollup: [], comments: [], issueComments: [], reviews: [], body: "" } }, logs: {} }));

  const port = 7600 + Math.floor(Math.random() * 300);
  const engramPort = port + 1000;
  const engram = spawn(process.execPath, [join(import.meta.dirname, "fake-engram.mjs"), String(engramPort)], { stdio: "ignore", detached: true });
  engram.unref();
  const socket = `forge-e2e-${port}`;
  const backendTest = join(REPO, "packages", "backend", "test");
  const env = {
    ...process.env,
    FORGE_HOME: join(root, "home"),
    FORGE_PORT: String(port),
    FORGE_TMUX_SOCKET: socket,
    FORGE_CLAUDE_BIN: join(backendTest, "fake-claude", "fake-claude.mjs"),
    FORGE_GH_BIN: join(backendTest, "fake-gh", "fake-gh.mjs"),
    FORGE_CHECK_TRUST: "0",
    FORGE_ENGRAM_URL: `http://127.0.0.1:${engramPort}`,
    FORGE_PR_POLL_MS: "500",
    FORGE_CLOSE_GRACE_MS: "100",
    FORGE_SWEEP_INTERVAL_MS: "300",
    FAKE_GH_STATE: ghState,
    FAKE_GH_BIN: join(backendTest, "fake-gh", "fake-gh.mjs"),
    FAKE_CLAUDE_SCRIPT: JSON.stringify({ "TASK-003:plan": ["hang", "hang"] }),
    FAKE_CLAUDE_TRACE: join(root, "trace.jsonl"),
    FAKE_CLAUDE_TRANSCRIPT_DIR: root,
  };
  const child = spawn(process.execPath, ["--import", "tsx", join(REPO, "packages", "backend", "src", "cli.ts"), "serve"], { cwd: REPO, env, stdio: "ignore", detached: true });
  child.unref();
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${url}/health`)).ok) break;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  const token = readFileSync(join(root, "home", "token"), "utf8").trim();
  const state: E2eState = { url, token, project, newApp, root, ghState, pid: child.pid ?? 0, socket, engramPid: engram.pid ?? 0 };
  execFileSync("mkdir", ["-p", join(REPO, ".forge-e2e")]);
  writeFileSync(STATE_FILE, JSON.stringify(state));
}
