import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { api, type OrchestratorSession, type Project } from "../api.js";
import { useTmuxTerminal } from "./Terminal.js";

const HEIGHT_KEY = "forge.console.height";
const MIN_HEIGHT = 160;
const STEP = 40;

const maxHeight = () => Math.max(MIN_HEIGHT, window.innerHeight - 160);
const clamp = (height: number) => Math.round(Math.min(maxHeight(), Math.max(MIN_HEIGHT, height)));

function savedHeight(): number {
  try {
    const saved = Number(localStorage.getItem(HEIGHT_KEY));
    if (saved > 0) return clamp(saved);
  } catch {
    // Storage blocked: use the default.
  }
  return clamp(window.innerHeight * 0.42);
}

function saveHeight(height: number): void {
  try {
    localStorage.setItem(HEIGHT_KEY, String(height));
  } catch {
    // Storage blocked: the height lasts until the page reloads.
  }
}

/** The console's top edge: drag it, or use the arrow keys, to make the terminal taller or shorter. */
function ResizeHandle({ height, onChange }: { height: number; onChange: (height: number) => void }) {
  const drag = useRef<{ y: number; height: number } | null>(null);
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { y: e.clientY, height };
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (drag.current) onChange(clamp(drag.current.height + drag.current.y - e.clientY));
  };
  const onPointerUp = () => {
    drag.current = null;
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const next = e.key === "ArrowUp" ? height + STEP : e.key === "ArrowDown" ? height - STEP : null;
    if (next === null) return;
    e.preventDefault();
    onChange(clamp(next));
  };
  return (
    <div
      className="console-resize"
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize the console"
      aria-valuemin={MIN_HEIGHT}
      aria-valuemax={maxHeight()}
      aria-valuenow={height}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onKeyDown={onKeyDown}
    />
  );
}

function ConsoleTerminal({ projectId, height }: { projectId: string; height: number }) {
  // The person's own session: always in control mode, typed into directly.
  const { container, state } = useTmuxTerminal(`/ws/console/${projectId}`, true);
  return (
    <>
      <span className="muted small console-state">{state === "open" ? "Connected" : state === "closed" ? "Disconnected" : "Connecting"}</span>
      <div className="terminal console-terminal" style={{ height }}>
        <div className="terminal-screen" ref={container} data-testid="console-terminal" />
      </div>
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
  const [height, setHeight] = useState(savedHeight);
  const resize = (next: number) => {
    setHeight(next);
    saveHeight(next);
  };
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
      {session ? <ResizeHandle height={height} onChange={resize} /> : null}
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
        <ConsoleTerminal key={session.tmuxSession} projectId={project.id} height={height} />
      ) : session === null ? (
        <p className="muted panel">
          Claude Code on {project.name}, with Forge's tools: ask about the project or the state of any task, and delegate fixing what is blocked. It asks before
          every command or edit.
        </p>
      ) : null}
    </section>
  );
}
