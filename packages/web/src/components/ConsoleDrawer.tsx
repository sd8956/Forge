import { useEffect, useState } from "react";
import { api, type OrchestratorSession, type Project } from "../api.js";
import { useTmuxTerminal } from "./Terminal.js";

function ConsoleTerminal({ projectId }: { projectId: string }) {
  // The person's own session: always in control mode. They type in the terminal or in the box below.
  const { container, state, send } = useTmuxTerminal(`/ws/console/${projectId}`, true);
  const [message, setMessage] = useState("");
  return (
    <>
      <span className="muted small console-state">{state === "open" ? "Connected" : state === "closed" ? "Disconnected" : "Connecting"}</span>
      <div className="terminal console-terminal">
        <div className="terminal-screen" ref={container} data-testid="console-terminal" />
      </div>
      <form
        className="orchestrator-input"
        onSubmit={(e) => {
          e.preventDefault();
          const text = message.trim();
          if (text && send(text)) {
            send("\r");
            setMessage("");
          }
        }}
      >
        <label className="sr-only" htmlFor="console-message">Ask the console</label>
        <input id="console-message" value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Ask the console…" />
        <button type="submit" className="btn primary" disabled={!message.trim() || state !== "open"}>Send</button>
      </form>
    </>
  );
}

/**
 * The project console: Claude Code on the selected project, available from every page. Ask about the project or the
 * pipeline, and delegate fixes; it asks before each command or edit, and changes Forge's state through its tools.
 */
export function ConsoleDrawer({ project, onClose }: { project: Project; onClose: () => void }) {
  const [session, setSession] = useState<OrchestratorSession | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void api.console(project.id).then((r) => setSession(r.session), () => setSession(null));
  }, [project.id]);
  const act = (call: Promise<{ session?: OrchestratorSession | null; stopped?: boolean }>) =>
    void call.then(
      (r) => {
        setError(null);
        setSession("session" in r ? (r.session ?? null) : null);
      },
      (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
    );
  return (
    <section className="card console-drawer" role="region" aria-label="Console">
      <div className="orchestrator-head">
        <strong>Console · {project.name}</strong>
        {session ? <span className="muted small mono">{session.tmuxSession}</span> : null}
        <div className="actions" style={{ marginLeft: "auto" }}>
          {session ? (
            <button type="button" className="btn" onClick={() => act(api.stopConsole(project.id))}>Stop</button>
          ) : session === null ? (
            <button type="button" className="btn primary" onClick={() => act(api.startConsole(project.id))}>Start console</button>
          ) : null}
          <button type="button" className="btn" aria-label="Close the console" onClick={onClose}>✕</button>
        </div>
      </div>
      {error ? <p role="alert" className="small panel" style={{ color: "var(--st-failed-fg)" }}>{error}</p> : null}
      {session ? (
        <ConsoleTerminal key={session.tmuxSession} projectId={project.id} />
      ) : session === null ? (
        <p className="muted panel">
          Claude Code on {project.name}, with Forge's tools: ask about the project or the state of any task, and delegate fixing what is blocked. It asks before
          every command or edit.
        </p>
      ) : null}
    </section>
  );
}
