import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface NewSessionOptions {
  name: string;
  cwd: string;
  /** Shell command run inside the session; the session ends when it exits. */
  command: string;
  env?: Record<string, string>;
}

/** Thin wrapper over the tmux CLI. It never reads pane contents. */
export class Tmux {
  constructor(private readonly socket: string) {}

  /**
   * Starts a detached session. A client that connects while the server is exiting (its last session just closed)
   * gets "server exited unexpectedly" and no session is created, so that error is retried with a short backoff.
   */
  async newSession(opts: NewSessionOptions): Promise<void> {
    const envArgs = Object.entries(opts.env ?? {}).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
    const args = ["new-session", "-d", "-s", opts.name, "-c", opts.cwd, "-x", "200", "-y", "50", ...envArgs, opts.command];
    for (let attempt = 1; ; attempt++) {
      try {
        await this.tmux(args);
        // The wheel scrolls tmux's own history (copy mode), never the panel's copy of the screen.
        await this.tmux(["set-option", "-t", `=${opts.name}:`, "mouse", "on"]);
        return;
      } catch (error) {
        const stderr = String((error as { stderr?: string }).stderr ?? error);
        if (attempt >= 5 || !/server exited unexpectedly|lost server|no server running|error connecting/i.test(stderr)) throw error;
        await new Promise((r) => setTimeout(r, 50 * attempt));
      }
    }
  }

  async killSession(name: string): Promise<boolean> {
    try {
      await this.tmux(["kill-session", "-t", `=${name}`]);
      return true;
    } catch {
      return false;
    }
  }

  async hasSession(name: string): Promise<boolean> {
    try {
      await this.tmux(["has-session", "-t", `=${name}`]);
      return true;
    } catch {
      return false;
    }
  }

  /** Session names on this socket; empty when the tmux server is not running. */
  async listSessions(): Promise<string[]> {
    try {
      const { stdout } = await this.tmux(["list-sessions", "-F", "#{session_name}"]);
      return stdout.split("\n").filter(Boolean);
    } catch {
      return [];
    }
  }

  async killServer(): Promise<void> {
    try {
      await this.tmux(["kill-server"]);
    } catch {
      // Already gone.
    }
  }

  private tmux(args: string[]) {
    return run("tmux", ["-L", this.socket, ...args], { encoding: "utf8" });
  }
}

/** Quotes one argument for POSIX sh. */
export function shellQuote(arg: string): string {
  if (/^[\w@%+=:,./-]+$/.test(arg)) return arg;
  return `'${arg.replaceAll("'", `'\\''`)}'`;
}
