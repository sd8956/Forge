import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { startBackend, type Backend } from "../src/app.js";
import { Tmux } from "../src/runner/tmux.js";
import { Api, disposeTmux, fakeEnv, makeProject, PLAN_ONLY_PIPELINE, scratch, StubMemory, testConfig, waitFor, removeScratch } from "./helpers.js";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup() {
  const root = scratch();
  const project = makeProject(root, { pipeline: PLAN_ONLY_PIPELINE });
  const config = testConfig(root, { extraEnv: fakeEnv(root, { plan: ["done"] }) });
  const tmux = new Tmux(config.tmuxSocket);
  const backend: Backend = await startBackend(config, { memory: new StubMemory() });
  cleanups.push(() => removeScratch(root));
  cleanups.push(() => disposeTmux(tmux, config.tmuxSocket));
  cleanups.push(() => backend.close());
  return { project, backend, api: new Api(backend.url, backend.token) };
}

async function cookieFor(backend: Backend): Promise<string> {
  const res = await fetch(backend.loginLink(), { redirect: "manual" });
  return (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
}

/** Resolves with the socket once open, or with the HTTP status of a refused upgrade. */
function connect(backend: Backend, headers: Record<string, string>): Promise<WebSocket | number> {
  return new Promise((resolve) => {
    const socket = new WebSocket(`${backend.url.replace("http", "ws")}/ws/events`, { headers });
    socket.once("open", () => resolve(socket));
    socket.once("unexpected-response", (req, res) => {
      resolve(res.statusCode ?? 0);
      req.destroy();
      res.destroy();
    });
    socket.once("error", () => undefined);
  });
}

describe("/ws/events", () => {
  it("streams run and step events live to an authenticated panel", async () => {
    const { backend, api, project } = await setup();
    const socket = await connect(backend, { cookie: await cookieFor(backend), origin: backend.url });
    if (typeof socket === "number") throw new Error(`refused: ${socket}`);
    cleanups.push(() => socket.close());
    const received: { entity: string; type: string; payload: { to?: string } }[] = [];
    socket.on("message", (data: Buffer) => received.push(JSON.parse(data.toString()) as (typeof received)[number]));

    const run = await api.startRun(project);
    await api.waitForRun(run.id, "waiting_review");
    await waitFor(() => received.some((e) => e.entity === "run" && e.payload.to === "waiting_review"), "waiting_review event");
    expect(received.some((e) => e.entity === "run" && e.type === "created")).toBe(true);
    expect(received.some((e) => e.entity === "step" && e.payload.to === "done")).toBe(true);
  });

  it("refuses upgrades without a session, from another origin, or with a forged cookie", async () => {
    const { backend } = await setup();
    const cookie = await cookieFor(backend);
    expect(await connect(backend, { origin: backend.url })).toBe(401);
    expect(await connect(backend, { cookie, origin: "https://evil.example" })).toBe(403);
    expect(await connect(backend, { cookie: "forge_session=a.b", origin: backend.url })).toBe(401);
  });
});
