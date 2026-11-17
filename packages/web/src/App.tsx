import { useCallback, useEffect, useState } from "react";
import { api, UnauthorizedError, type BacklogTask, type Project, type RunSummary } from "./api.js";
import { Icon } from "./components/Icon.js";
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
    setNow(Date.now());
  }, []);

  useEffect(refresh, [refresh]);
  useEffect(() => {
    if (project) void api.backlog(project.id).then(setBacklog, () => setBacklog([]));
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
      </aside>
      <main className="main">
        {error ? <p role="alert">{error}</p> : null}
        {runId ? (
          <RunDetail id={runId} now={now} />
        ) : project ? (
          <Board project={project} runs={runs} backlog={backlog} now={now} onChanged={refresh} />
        ) : projects ? (
          <div className="card notice">
            <h2>No project yet</h2>
            <p className="muted">Start a run from the CLI (<span className="mono">pnpm forge run-task --project &lt;path&gt; --task TASK-001</span>) or register one with <span className="mono">POST /projects</span>.</p>
          </div>
        ) : (
          <p className="muted">Loading…</p>
        )}
      </main>
    </div>
  );
}
