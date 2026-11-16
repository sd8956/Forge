import { spawn } from "node:child_process";

export interface ShellResult {
  ok: boolean;
  /** Tail of combined stdout and stderr. */
  output: string;
}

/** Runs a shell command in `cwd`; never throws. Output is trimmed to the last `maxChars`. */
export function runShell(command: string, cwd: string, timeoutMs: number, maxChars = 4000): Promise<ShellResult> {
  return new Promise((resolve) => {
    const child = spawn("sh", ["-c", command], { cwd, stdio: ["ignore", "pipe", "pipe"], detached: true });
    let output = "";
    const append = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-maxChars * 2);
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    const timer = setTimeout(() => {
      // Kill the whole group: make spawns children.
      if (child.pid) process.kill(-child.pid, "SIGKILL");
      output += `\n[timed out after ${Math.round(timeoutMs / 1000)}s]`;
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ ok: false, output: error.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, output: output.slice(-maxChars).trim() || `(exit code ${String(code)})` });
    });
  });
}
