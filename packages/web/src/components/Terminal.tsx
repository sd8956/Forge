import { FitAddon } from "@xterm/addon-fit";
import { Terminal as XTerm } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef, useState } from "react";

/**
 * Live view of a step's tmux session. Read-only by default; taking control is
 * an explicit action, recorded by the backend, that forwards keystrokes.
 */
export function Terminal({ stepId, session }: { stepId: string; session: string }) {
  const container = useRef<HTMLDivElement>(null);
  const [control, setControl] = useState(false);
  const [state, setState] = useState<"connecting" | "open" | "closed">("connecting");

  useEffect(() => {
    if (!container.current) return;
    const term = new XTerm({
      convertEol: false,
      cursorBlink: control,
      disableStdin: !control,
      fontFamily: '"JetBrains Mono", ui-monospace, monospace',
      fontSize: 13,
      theme: { background: "#0b0c0d", foreground: "#d9d7d2", cursor: "#fdba74" },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container.current);
    fit.fit();
    const socket = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/terminal/${stepId}?mode=${control ? "control" : "view"}`);
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
    window.addEventListener("resize", resize);
    return () => {
      window.removeEventListener("resize", resize);
      input.dispose();
      socket.close();
      term.dispose();
    };
  }, [stepId, control]);

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
      <div className="terminal" ref={container} data-testid="terminal" />
    </div>
  );
}
