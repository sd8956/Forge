import { useState } from "react";
import type { BacklogTask, Project, RunSummary } from "../api.js";
import { api } from "../api.js";
import { Badge } from "../components/Badge.js";
import { duration, runStatus, STEP_LABELS, stepStatus } from "../status.js";

const STEP_COLUMNS = ["plan", "design", "development", "security", "e2e", "pr", "review_fix"] as const;
const OPEN = new Set(["queued", "running", "needs_human"]);

/** Where a run's card goes: its current step while open, else its outcome column. */
export function columnOf(run: RunSummary): string {
  if (run.status === "waiting_review") return "awaiting_review";
  if (run.status === "done") return "done";
  if (!OPEN.has(run.status)) return "closed";
  return run.latestStep && run.latestStep.kind === run.currentStep ? run.latestStep.kind : run.currentStep;
}

function RunCard({ run, task, now }: { run: RunSummary; task: BacklogTask | undefined; now: number }) {
  const step = run.latestStep;
  const status = run.status === "needs_human" ? runStatus(run.status) : step && OPEN.has(run.status) ? stepStatus(step.status) : runStatus(run.status);
  const detail =
    run.status === "needs_human"
      ? (run.exitReason ?? (step?.permissionPrompts ? "Waiting for a permission answer" : "Waiting for a person"))
      : run.status === "waiting_review"
        ? run.prUrl
          ? `PR #${run.prNumber ?? ""}${run.reviewRound ? ` · review round ${run.reviewRound}` : ""}`
          : "Awaiting review"
        : run.exitReason;
  return (
    <a className={`card run-card${run.status === "needs_human" ? " attention" : ""}`} href={`#/runs/${run.id}`} data-testid={`run-card-${run.taskId}`}>
      <div className="mono small muted">{run.taskId}</div>
      <div className="title">{task?.title ?? run.taskId}</div>
      <Badge tone={status.tone} label={status.label} />
      <div className="meta small muted">
        {step?.model ? `${step.model} · ` : ""}
        {duration(step?.startedAt ?? null, step?.endedAt ?? null, now)}
        {step && (step.permissionPrompts || step.toolDenials) ? ` · ${step.permissionPrompts} prompts · ${step.toolDenials} denied` : ""}
      </div>
      {detail ? <div className="small muted">{detail}</div> : null}
    </a>
  );
}

export function Board({ project, runs, backlog, now, onChanged }: { project: Project; runs: RunSummary[]; backlog: BacklogTask[]; now: number; onChanged: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const mine = runs.filter((r) => r.projectPath === project.repoPath);
  const latestPerTask = new Map<string, RunSummary>();
  for (const run of mine) latestPerTask.set(run.taskId, run);
  const shown = [...latestPerTask.values()];
  const tasks = new Map(backlog.map((t) => [t.id, t]));
  const merged = new Set(shown.filter((r) => r.status === "done").map((r) => r.taskId));
  const notStarted = backlog.filter((t) => !latestPerTask.has(t.id) || ["failed", "cancelled"].includes(latestPerTask.get(t.id)?.status ?? ""));

  const columns = STEP_COLUMNS.map((id) => ({ id, label: STEP_LABELS[id] ?? id }));
  const prRuns = shown.filter((r) => ["awaiting_review", "done"].includes(columnOf(r)));

  const launch = async (taskId: string) => {
    setError(null);
    try {
      await api.startRun(project.repoPath, taskId);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const active = shown.filter((r) => r.status === "running").length;
  const attention = shown.filter((r) => r.status === "needs_human").length;
  const openPrs = shown.filter((r) => r.status === "waiting_review").length;

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Execution</h1>
          <div className="muted">{project.name} · {project.defaultBranch}</div>
        </div>
      </div>

      <div className="stats">
        <div className="card stat"><div className="muted small">Active sessions</div><div className="value">{active}</div></div>
        <div className="card stat"><div className="muted small">Not started</div><div className="value">{notStarted.length}</div></div>
        <div className={`card stat${attention ? " attention" : ""}`}><div className="small">Need attention</div><div className="value">{attention}</div></div>
        <div className="card stat"><div className="muted small">Open PRs</div><div className="value">{openPrs}</div></div>
      </div>

      <div className="board" aria-label="Pipeline board">
        {columns.map((column) => {
          const cards = shown.filter((r) => columnOf(r) === column.id);
          return (
            <section key={column.id} aria-label={column.label}>
              <div className="column-title"><span>{column.label}</span><span className="muted">{cards.length}</span></div>
              <div className="column-cards">
                {cards.map((run) => <RunCard key={run.id} run={run} task={tasks.get(run.taskId)} now={now} />)}
              </div>
            </section>
          );
        })}
      </div>

      <section className="card panel" aria-label="Pull requests" style={{ marginBottom: 18 }}>
        <div className="page-header" style={{ marginBottom: 8 }}>
          <h2>Pull requests</h2>
          <span className="muted small">New review comments from allowed authors start a review round</span>
        </div>
        {prRuns.length === 0 ? <p className="muted">No pull request yet.</p> : null}
        {prRuns.map((run) => {
          const status = runStatus(run.status);
          return (
            <a key={run.id} className="list-row" href={`#/runs/${run.id}`} data-testid={`run-card-${run.taskId}`} style={{ color: "inherit", textDecoration: "none" }}>
              <span className="mono small muted">{run.taskId}</span>
              <span>{tasks.get(run.taskId)?.title ?? run.taskId}</span>
              <span className="small muted">{run.prUrl ? `PR #${run.prNumber ?? ""}` : ""}{run.reviewRound ? ` · review round ${run.reviewRound}` : ""}</span>
              <Badge tone={status.tone} label={status.label} />
            </a>
          );
        })}
      </section>

      <div className="card panel">
        <div className="page-header" style={{ marginBottom: 8 }}>
          <h2>Backlog</h2>
          <span className="muted small">A task starts once its dependencies are merged</span>
        </div>
        {error ? <p role="alert" className="small" style={{ color: "var(--st-failed-fg)" }}>{error}</p> : null}
        {notStarted.length === 0 ? <p className="muted">Every task has a run.</p> : null}
        {notStarted.map((task) => {
          const waitingFor = task.dependsOn.filter((d) => !merged.has(d));
          return (
            <div className="list-row" key={task.id}>
              <span className="mono small muted">{task.id}</span>
              <span>{task.title}</span>
              {waitingFor.length ? <Badge tone="queued" label={`Waits for ${waitingFor.join(", ")} merge`} /> : <Badge tone="queued" label="Ready" />}
              <button type="button" className="btn" onClick={() => void launch(task.id)} aria-label={`Launch ${task.id}`}>Launch</button>
            </div>
          );
        })}
      </div>
    </>
  );
}
