import fastifyWebsocket from "@fastify/websocket";
import type { FastifyInstance } from "fastify";
import { spawn as spawnPty } from "node-pty";
import { isTerminalStepStatus } from "@forge/shared";
import { z } from "zod";
import type { StepStore } from "../db/step-store.js";
import type { EventBus } from "../events/event-bus.js";
import type { WebSocket } from "ws";

export interface WsDeps {
  bus: EventBus;
  store: StepStore;
  tmuxSocket: string;
  /** tmux session of a project's live orchestrator, if any. */
  orchestratorSession: (projectId: string) => Promise<{ tmuxSession: string; startedAt: number } | null>;
  onOrchestratorControl: (projectId: string, session: { tmuxSession: string; startedAt: number }) => void;
  /** tmux session of a project's console, if any. */
  consoleSession: (projectId: string) => Promise<string | null>;
}

const terminalMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("input"), data: z.string().max(4096) }),
  z.object({ type: z.literal("resize"), cols: z.number().int().min(10).max(500), rows: z.number().int().min(5).max(200) }),
]);

/**
 * Live channels for the panel. Authentication (cookie or token, local Origin)
 * already ran in the server's onRequest hook before the upgrade.
 */
export async function registerWsRoutes(app: FastifyInstance, deps: WsDeps): Promise<void> {
  await app.register(fastifyWebsocket, { options: { maxPayload: 64 * 1024 } });

  app.get("/ws/events", { websocket: true }, (socket) => {
    const unsubscribe = deps.bus.subscribe((event) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(event));
    });
    socket.on("close", unsubscribe);
    socket.on("error", unsubscribe);
    // Read-only channel: incoming messages are ignored.
  });

  /**
   * A live view of a step's tmux session for the person in the panel. `view`
   * attaches read-only (`tmux attach -r`) and drops any input; `control` is an
   * explicit choice, recorded as an event, that forwards keystrokes. The
   * backend never reads this stream to decide anything.
   */
  app.get("/ws/terminal/:stepId", { websocket: true }, (socket, request) => {
    const params = z.object({ stepId: z.uuid() }).safeParse(request.params);
    const query = z.object({ mode: z.enum(["view", "control"]).default("view") }).safeParse(request.query);
    const step = params.success ? deps.store.get(params.data.stepId) : undefined;
    if (!step || !query.success || isTerminalStepStatus(step.status)) {
      socket.close(4404, "No live session for this step");
      return;
    }
    const control = query.data.mode === "control";
    if (control) deps.store.recordEvent(step.id, "operator_control", { via: "panel" });
    attachTerminal(socket, deps.tmuxSocket, step.tmuxSession, control);
  });

  /** The orchestrator's terminal: this is where the person talks to it, so control is the usual mode. */
  app.get("/ws/orchestrator/:projectId", { websocket: true }, async (socket, request) => {
    const early = holdMessages(socket);
    const params = z.object({ projectId: z.uuid() }).safeParse(request.params);
    const query = z.object({ mode: z.enum(["view", "control"]).default("control") }).safeParse(request.query);
    const session = params.success ? await deps.orchestratorSession(params.data.projectId) : null;
    if (!params.success || !query.success || !session) {
      socket.close(4404, "No orchestrator session for this project");
      return;
    }
    const control = query.data.mode === "control";
    if (control) deps.onOrchestratorControl(params.data.projectId, session);
    attachTerminal(socket, deps.tmuxSocket, session.tmuxSession, control, early());
  });

  /** The project console: the person's own session, always in control mode. */
  app.get("/ws/console/:projectId", { websocket: true }, async (socket, request) => {
    const early = holdMessages(socket);
    const params = z.object({ projectId: z.uuid() }).safeParse(request.params);
    const session = params.success ? await deps.consoleSession(params.data.projectId) : null;
    if (!session) {
      socket.close(4404, "No console for this project");
      return;
    }
    attachTerminal(socket, deps.tmuxSocket, session, true, early());
  });
}

/**
 * Keeps the messages that arrive while an async route looks up its session:
 * the panel sends its size as soon as the socket opens, and losing it leaves
 * tmux drawing a 120x32 screen into a smaller terminal.
 */
function holdMessages(socket: WebSocket): () => Buffer[] {
  const held: Buffer[] = [];
  const hold = (raw: Buffer) => held.push(raw);
  socket.on("message", hold);
  return () => {
    socket.off("message", hold);
    return held;
  };
}

/**
 * Bridges a panel WebSocket to a tmux session through a pty. `view` attaches
 * read-only and drops input; `control` forwards keystrokes.
 */
function attachTerminal(socket: WebSocket, tmuxSocket: string, session: string, control: boolean, early: Buffer[] = []): void {
  const args = ["-L", tmuxSocket, "attach", ...(control ? [] : ["-r"]), "-t", `=${session}`];
  const pty = spawnPty("tmux", args, { name: "xterm-256color", cols: 120, rows: 32, env: { ...process.env, TERM: "xterm-256color" } });
  pty.onData((data) => {
    if (socket.readyState === socket.OPEN) socket.send(data);
  });
  pty.onExit(() => {
    if (socket.readyState === socket.OPEN) socket.close(1000, "Session ended");
  });
  const handle = (raw: Buffer) => {
    let message: z.infer<typeof terminalMessage>;
    try {
      message = terminalMessage.parse(JSON.parse(raw.toString()));
    } catch {
      return;
    }
    if (message.type === "resize") pty.resize(message.cols, message.rows);
    else if (control) pty.write(message.data);
  };
  socket.on("message", handle);
  early.forEach(handle);
  // Closing the panel detaches the tmux client; the session keeps running.
  socket.on("close", () => pty.kill());
}
