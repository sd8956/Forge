import fastifyWebsocket from "@fastify/websocket";
import type { FastifyInstance } from "fastify";
import { spawn as spawnPty } from "node-pty";
import { isTerminalStepStatus } from "@forge/shared";
import { z } from "zod";
import type { StepStore } from "../db/step-store.js";
import type { EventBus } from "../events/event-bus.js";

export interface WsDeps {
  bus: EventBus;
  store: StepStore;
  tmuxSocket: string;
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
    const args = ["-L", deps.tmuxSocket, "attach", ...(control ? [] : ["-r"]), "-t", `=${step.tmuxSession}`];
    const pty = spawnPty("tmux", args, { name: "xterm-256color", cols: 120, rows: 32, env: { ...process.env, TERM: "xterm-256color" } });
    if (control) deps.store.recordEvent(step.id, "operator_control", { via: "panel" });

    pty.onData((data) => {
      if (socket.readyState === socket.OPEN) socket.send(data);
    });
    pty.onExit(() => {
      if (socket.readyState === socket.OPEN) socket.close(1000, "Session ended");
    });
    socket.on("message", (raw: Buffer) => {
      let message: z.infer<typeof terminalMessage>;
      try {
        message = terminalMessage.parse(JSON.parse(raw.toString()));
      } catch {
        return;
      }
      if (message.type === "resize") pty.resize(message.cols, message.rows);
      else if (control) pty.write(message.data);
    });
    // Closing the panel detaches the tmux client; the session keeps running.
    socket.on("close", () => pty.kill());
  });
}
