import { useEffect, useRef } from "react";

/**
 * Calls `onChange` (debounced) whenever the backend publishes an event, and
 * reconnects after drops. The panel refetches instead of patching state.
 */
export function useEvents(onChange: () => void): void {
  const callback = useRef(onChange);
  callback.current = onChange;

  useEffect(() => {
    let socket: WebSocket | undefined;
    let timer: number | undefined;
    let retry: number | undefined;
    let stopped = false;
    const connect = () => {
      socket = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/events`);
      socket.onmessage = () => {
        window.clearTimeout(timer);
        timer = window.setTimeout(() => callback.current(), 250);
      };
      socket.onclose = () => {
        if (!stopped) retry = window.setTimeout(connect, 2000);
      };
    };
    connect();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      window.clearTimeout(retry);
      socket?.close();
    };
  }, []);
}
