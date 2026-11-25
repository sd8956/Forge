import { execFileSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { STATE_FILE, type E2eState } from "./global-setup.js";

export default function globalTeardown(): void {
  const state = JSON.parse(readFileSync(STATE_FILE, "utf8")) as E2eState;
  for (const pid of [state.pid, state.engramPid]) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
  try {
    execFileSync("tmux", ["-L", state.socket, "kill-server"], { stdio: "ignore" });
  } catch {
    // no server
  }
  rmSync(join(process.env.TMUX_TMPDIR ?? "/tmp", `tmux-${process.getuid?.() ?? 0}`, state.socket), { force: true });
  rmSync(state.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
