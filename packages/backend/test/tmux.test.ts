import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { Tmux } from "../src/runner/tmux.js";
import { disposeTmux } from "./helpers.js";

const socket = `forge-tmux-race-${process.pid}`;
const tmux = new Tmux(socket);
afterEach(() => disposeTmux(tmux, socket));

describe("Tmux", () => {
  it("turns the mouse on for every session, so the wheel scrolls tmux's own history", async () => {
    await tmux.newSession({ name: "wheel", cwd: process.cwd(), command: "sleep 30" });
    const option = execFileSync("tmux", ["-L", socket, "show-options", "-t", "=wheel:", "mouse"], { encoding: "utf8" }).trim();
    expect(option).toBe("mouse on");
  });

  it("starts a session even while the server is exiting after its last session closed", async () => {
    // tmux answers "server exited unexpectedly" when a client connects to a server that is shutting down,
    // which happens when one step closes the last session just as the next one starts.
    const failures: string[] = [];
    for (let i = 0; i < 60; i++) {
      await tmux.newSession({ name: `old${i}`, cwd: process.cwd(), command: "sleep 30" });
      const closing = tmux.killSession(`old${i}`);
      try {
        await tmux.newSession({ name: `new${i}`, cwd: process.cwd(), command: "sleep 30" });
      } catch (error) {
        failures.push(String(error).slice(0, 120));
      }
      await closing;
      await tmux.killServer();
    }
    expect(failures).toEqual([]);
  }, 120_000);
});
