import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { startBackend, type Backend } from "../src/app.js";
import { Tmux } from "../src/runner/tmux.js";
import { Api, disposeTmux, fakeEnv, makeProject, PLAN_ONLY_PIPELINE, readTrace, scratch, StubMemory, testConfig, waitFor, removeScratch } from "./helpers.js";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup() {
  const root = scratch();
  const project = makeProject(root, { pipeline: PLAN_ONLY_PIPELINE });
  const config = testConfig(root, { extraEnv: fakeEnv(root, { plan: ["hang"] }) });
  const tmux = new Tmux(config.tmuxSocket);
  const backend: Backend = await startBackend(config, { memory: new StubMemory() });
  cleanups.push(() => removeScratch(root));
  cleanups.push(() => disposeTmux(tmux, config.tmuxSocket));
  cleanups.push(() => backend.close());
  const api = new Api(backend.url, backend.token);
  const run = await api.startRun(project);
  const step = await waitFor(async () => (await api.run(run.id)).steps.find((s) => s.status === "running"), "plan to run");
  const cookie = ((await fetch(backend.loginLink(), { redirect: "manual" })).headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  return { root, backend, api, step, cookie };
}

function open(backend: Backend, path: string, cookie: string): Promise<{ socket: WebSocket; screen: () => string }> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`${backend.url.replace("http", "ws")}${path}`, { headers: { cookie, origin: backend.url } });
    let screen = "";
    socket.on("error", () => undefined);
    socket.on("message", (data: Buffer) => (screen += data.toString()));
    socket.once("open", () => resolve({ socket, screen: () => screen }));
    socket.once("unexpected-response", (_req, res) => reject(new Error(`refused ${res.statusCode}`)));
    cleanups.push(() => {
      if (socket.readyState === WebSocket.OPEN) socket.close();
      else socket.terminate();
    });
  });
}

describe("/ws/terminal", () => {
  it("streams the session read-only in view mode and ignores input", async () => {
    const { backend, step, cookie, root, api } = await setup();
    const { socket, screen } = await open(backend, `/ws/terminal/${step.id}`, cookie);
    await waitFor(() => screen().includes("fake claude ready: plan attempt 1"), "the session screen");
    socket.send(JSON.stringify({ type: "input", data: "should not arrive\r" }));
    await new Promise((r) => setTimeout(r, 500));
    expect(readTrace(root).filter((t) => t.type === "stdin")).toEqual([]);
    expect((await api.step(step.id)).events.some((e) => e.type === "operator_control")).toBe(false);
  });

  it("forwards keystrokes in control mode and records that a person took control", async () => {
    const { backend, step, cookie, root, api } = await setup();
    const { socket, screen } = await open(backend, `/ws/terminal/${step.id}?mode=control`, cookie);
    await waitFor(() => screen().includes("fake claude ready"), "the session screen");
    socket.send(JSON.stringify({ type: "resize", cols: 100, rows: 30 }));
    // The session's stdin is a TTY in canonical mode: input arrives with Enter.
    socket.send(JSON.stringify({ type: "input", data: "hello\r" }));
    await waitFor(() => readTrace(root).some((t) => t.type === "stdin" && String(t.data).includes("hello")), "input to reach the session");
    expect((await api.step(step.id)).events.some((e) => e.type === "operator_control")).toBe(true);
  });

  it("forwards a long paste whole, beyond 4096 characters", async () => {
    const { backend, step, cookie, root } = await setup();
    const { socket, screen } = await open(backend, `/ws/terminal/${step.id}?mode=control`, cookie);
    await waitFor(() => screen().includes("fake claude ready"), "the session screen");
    const paste = Array.from({ length: 120 }, (_, i) => `line ${String(i).padStart(3, "0")} ${"x".repeat(40)}\r`).join("");
    expect(paste.length).toBeGreaterThan(4096);
    socket.send(JSON.stringify({ type: "input", data: paste }));
    const typed = () => readTrace(root).filter((t) => t.type === "stdin").map((t) => String(t.data)).join("");
    await waitFor(() => typed().includes("line 119"), "the end of the paste to reach the session", 10_000);
  });

  it("refuses finished or unknown steps and connections without a session", async () => {
    const { backend, cookie } = await setup();
    const closed = await new Promise<number>((resolve) => {
      const socket = new WebSocket(`${backend.url.replace("http", "ws")}/ws/terminal/00000000-0000-4000-8000-000000000000`, { headers: { cookie, origin: backend.url } });
      socket.once("close", (code) => resolve(code));
    });
    expect(closed).toBe(4404);
    await expect(open(backend, "/ws/terminal/00000000-0000-4000-8000-000000000000", "")).rejects.toThrow("refused 401");
  });
});
