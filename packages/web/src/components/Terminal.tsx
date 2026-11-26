import { FitAddon } from "@xterm/addon-fit";
import { Terminal as XTerm } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useCallback, useEffect, useRef, useState } from "react";

export type TerminalState = "connecting" | "open" | "closed";

/**
 * A tmux session in an xterm, over the backend's terminal WebSocket. In view
 * mode the backend attaches read-only and drops input; in control mode
 * keystrokes (and `send`) reach the session.
 */
export function useTmuxTerminal(path: string, control: boolean) {
  const container = useRef<HTMLDivElement>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const [state, setState] = useState<TerminalState>("connecting");

  useEffect(() => {
    if (!container.current) return;
    setState("connecting");
    const term = new XTerm({
      convertEol: false,
      cursorBlink: control,
      disableStdin: !control,
      // tmux keeps the history: a second copy here drifts from the TUI and garbles the screen on scroll.
      scrollback: control ? 0 : 1000,
      fontFamily: '"JetBrains Mono", ui-monospace, monospace',
      fontSize: 13,
      theme: { background: "#0b0c0d", foreground: "#d9d7d2", cursor: "#fdba74" },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container.current);
    fit.fit();
    const socket = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${path}?mode=${control ? "control" : "view"}`);
    socketRef.current = socket;
    const resize = () => {
      fit.fit();
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
    };
    socket.onopen = () => {
      setState("open");
      resize();
    };
    socket.onmessage = (event: MessageEvent<string | Blob>) => {
      if (typeof event.data === "string") term.write(event.data);
      else void event.data.text().then((text) => term.write(text));
    };
    socket.onclose = () => setState("closed");
    const input = term.onData((data) => {
      if (control && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "input", data }));
    });
    // The drawer and panes change size without a window resize; tmux must always know the real size.
    const observer = new ResizeObserver(resize);
    observer.observe(container.current);
    return () => {
      observer.disconnect();
      input.dispose();
      socket.close();
      socketRef.current = null;
      term.dispose();
    };
  }, [path, control]);

  /** Types text into the session, as if the person typed it. */
  const send = useCallback((data: string) => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify({ type: "input", data }));
    return true;
  }, []);

  return { container, state, send };
}

/**
 * Live view of a step's tmux session. Read-only by default; taking control is
 * an explicit action, recorded by the backend, that forwards keystrokes.
 */
export function Terminal({ stepId, session }: { stepId: string; session: string }) {
  const [control, setControl] = useState(false);
  const { container, state } = useTmuxTerminal(`/ws/terminal/${stepId}`, control);

  return (
    <div>
      <div className="terminal-bar">
        <span className="muted small">
          <span className="mono">{session}</span> · {state === "open" ? (control ? "you have control" : "read-only") : state}
        </span>
        <button
          type="button"
          className={control ? "btn" : "btn primary"}
          onClick={() => {
            if (control || window.confirm("Take control of this session? Your keystrokes go to the agent, and Forge records that a person took over.")) setControl(!control);
          }}
        >
          {control ? "Back to read-only" : "Take control"}
        </button>
      </div>
      <div className="terminal">
        <div className="terminal-screen" ref={container} data-testid="terminal" />
      </div>
    </div>
  );
}
