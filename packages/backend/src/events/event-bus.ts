import type { EventRow } from "../db/schema.js";

export type EventListener = (event: EventRow) => void;

/** In-process fan-out of audit events to live subscribers (the panel's WebSocket). */
export class EventBus {
  private readonly listeners = new Set<EventListener>();

  publish(event: EventRow): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // A broken subscriber must never break the write path.
      }
    }
  }

  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get size(): number {
    return this.listeners.size;
  }
}
