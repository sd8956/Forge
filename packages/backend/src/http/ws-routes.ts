import fastifyWebsocket from "@fastify/websocket";
import type { FastifyInstance } from "fastify";
import type { EventBus } from "../events/event-bus.js";

export interface WsDeps {
  bus: EventBus;
}

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
}
