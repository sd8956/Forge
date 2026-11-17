import { useState } from "react";
import { useTmuxTerminal } from "./Terminal.js";

/**
 * The orchestrator's Claude Code session. Talking to it is the point of this
 * pane, so it attaches in control mode; the message box types a line into it.
 */
export function OrchestratorPane({ projectId, session, onStop }: { projectId: string; session: string; onStop: () => void }) {
  const { container, state, send } = useTmuxTerminal(`/ws/orchestrator/${projectId}`, true);
  const [message, setMessage] = useState("");
  return (
    <section className="card orchestrator" aria-label="Orchestrator">
      <div className="orchestrator-head">
        <strong>Orchestrator</strong>
        <span className={`badge ${state === "open" ? "done" : state === "closed" ? "failed" : "queued"}`}>{state === "open" ? "Connected" : state === "closed" ? "Disconnected" : "Connecting"}</span>
        <span className="muted small mono" style={{ marginLeft: "auto" }}>{session}</span>
        <button type="button" className="btn" onClick={onStop}>Stop</button>
      </div>
      <div className="terminal orchestrator-terminal">
        <div className="terminal-screen" ref={container} data-testid="orchestrator-terminal" />
      </div>
      <form
        className="orchestrator-input"
        onSubmit={(e) => {
          e.preventDefault();
          const text = message.trim();
          // Text first, then Enter as its own keystroke, the way a person types it.
          if (text && send(text)) {
            send("\r");
            setMessage("");
          }
        }}
      >
        <label className="sr-only" htmlFor="orchestrator-message">Message the orchestrator</label>
        <input id="orchestrator-message" value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Message the orchestrator…" />
        <button type="submit" className="btn primary" disabled={!message.trim() || state !== "open"}>Send</button>
      </form>
    </section>
  );
}
