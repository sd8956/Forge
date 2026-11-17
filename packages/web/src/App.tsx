import { useCallback, useEffect, useState } from "react";
import { api, UnauthorizedError, type BacklogTask, type OrchestratorSession, type PlanView, type Project, type QueueView, type RunSummary } from "./api.js";
import { Icon } from "./components/Icon.js";
import { UsageWidget } from "./components/UsageWidget.js";
import { Board } from "./pages/Board.js";
import { RunDetail } from "./pages/RunDetail.js";
import { useEvents } from "./useEvents.js";

function useHashRoute(): string {
  const [hash, setHash] = useState(location.hash || "#/");
  useEffect(() => {
    const onChange = () => setHash(location.hash || "#/");
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return hash;
}

const PROJECT_KEY = "forge.project";

/** Registers a repository that has a `.factory/` folder. */
function AddProject({ onAdded }: { onAdded: (project: Project) => void }) {
  const [path, setPath] = useState("");
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="card notice"
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        void api.addProject(path.trim()).then(onAdded, (err: unknown) => setError(err instanceof Error ? err.message : String(err)));
      }}
    >
      <h2>Add a project</h2>
      <p className="muted">The absolute path of a git repository with a <span className="mono">.factory/</span> folder.</p>
      <label className="sr-only" htmlFor="project-path">Repository path</label>
      <input
        id="project-path"
        className="mono"
        value={path}
        onChange={(e) => setPath(e.target.value)}
        placeholder="/home/me/code/my-app"
        style={{ width: "100%", height: "var(--control-height)", padding: "0 12px", borderRadius: "var(--radius-sm)", border: "1px solid var(--border)", background: "var(--surface)", color: "var(--text)", marginBottom: 12 }}
      />
      {error ? <p role="alert" className="small" style={{ color: "var(--st-failed-fg)" }}>{error}</p> : null}
      <button type="submit" className="btn primary" disabled={!path.trim()}>Add project</button>
    </form>
  );
}

export function App() {
  const route = useHashRoute();
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [projectId, setProjectId] = useState<string | null>(() => {
    try {
      return localStorage.getItem(PROJECT_KEY);
    } catch {
      return null;
    }
  });
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [backlog, setBacklog] = useState<BacklogTask[]>([]);
  const [queue, setQueue] = useState<QueueView | null>(null);
  const [plans, setPlans] = useState<PlanView[]>([]);
  const [orchestrator, setOrchestrator] = useState<OrchestratorSession | null>(null);
  const [now, setNow] = useState(Date.now());
  const [unauthorized, setUnauthorized] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const project = projects?.find((p) => p.id === projectId) ?? projects?.[0] ?? null;

  const refresh = useCallback(() => {
    const fail = (e: unknown) => {
      if (e instanceof UnauthorizedError) setUnauthorized(true);
      else setError(e instanceof Error ? e.message : String(e));
    };
    void api.projects().then(setProjects, fail);
    void api.runs().then(setRuns, fail);
    void api.queue().then(setQueue, () => setQueue(null));
    setNow(Date.now());
  }, []);

  useEffect(refresh, [refresh]);
  useEffect(() => {
    if (!project) return;
    void api.backlog(project.id).then(setBacklog, () => setBacklog([]));
    void api.plans(project.id).then(setPlans, () => setPlans([]));
    void api.orchestrator(project.id).then((r) => setOrchestrator(r.session), () => setOrchestrator(null));
  }, [project, now]);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 10_000);
    return () => window.clearInterval(timer);
  }, []);
  useEvents(refresh);

  if (unauthorized) {
    return (
      <div className="card notice">
        <h1>forge</h1>
        <p>Open the login link that <span className="mono">pnpm forge serve</span> printed, or get a new one with <span className="mono">pnpm forge login</span>.</p>
      </div>
    );
  }

  const runId = /^#\/runs\/([0-9a-f-]{36})/.exec(route)?.[1];
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="logo"><img src="/favicon.svg" alt="" /> forge</div>
        <label className="project-select">
          <span className="muted small">Project</span>
          <select
            value={project?.id ?? ""}
            onChange={(e) => {
              setProjectId(e.target.value);
              try {
                localStorage.setItem(PROJECT_KEY, e.target.value);
              } catch {
                // Private mode: the choice just isn't remembered.
              }
            }}
          >
            {projects?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
        <nav className="nav" aria-label="Main">
          <a href="#/" className="active"><Icon name="board" /> Execution</a>
        </nav>
        <UsageWidget queue={queue} now={now} />
      </aside>
      <main className="main">
        {error ? <p role="alert">{error}</p> : null}
        {runId ? (
          <RunDetail id={runId} now={now} />
        ) : project ? (
          <Board project={project} runs={runs} backlog={backlog} now={now} onChanged={refresh} queue={queue} plans={plans} orchestrator={orchestrator} />
        ) : projects ? (
          <AddProject onAdded={(p) => {
            setProjectId(p.id);
            refresh();
          }} />
        ) : (
          <p className="muted">Loading…</p>
        )}
      </main>
    </div>
  );
}
