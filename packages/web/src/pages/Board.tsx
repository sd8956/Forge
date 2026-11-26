import { useState } from "react";
import type { BacklogTask, OrchestratorSession, PlanView, Project, QueueView, RunSummary } from "../api.js";
import { api } from "../api.js";
import { Badge } from "../components/Badge.js";
import { OrchestratorPane } from "../components/OrchestratorPane.js";
import { Paged } from "../components/Pager.js";
import { PlanCard } from "../components/PlanCard.js";
import { duration, runStatus, STEP_LABELS, stepStatus } from "../status.js";

const STEP_COLUMNS = ["plan", "design", "development", "security", "e2e", "code_review", "pr", "review"] as const;
const OPEN = new Set(["queued", "running", "needs_human"]);

const LISTS = [
  { id: "queued", label: "Queued" },
  { id: "prs", label: "Pull requests" },
  { id: "backlog", label: "Backlog" },
] as const;
type ListId = (typeof LISTS)[number]["id"];
const LIST_KEY = "forge.board.list";

function savedList(): ListId {
  try {
    const saved = localStorage.getItem(LIST_KEY);
    return LISTS.find((l) => l.id === saved)?.id ?? "queued";
  } catch {
    return "queued";
  }
}

/** Open pull requests first, then merged ones from the most recent. */
function byPrOrder(a: RunSummary, b: RunSummary): number {
  const open = (r: RunSummary) => (r.status === "waiting_review" ? 0 : 1);
  return open(a) - open(b) || (b.endedAt ?? b.createdAt) - (a.endedAt ?? a.createdAt);
}

/** Where a run's card goes: its current step while open, else its outcome column. */
export function columnOf(run: RunSummary): string {
  // A PR waiting for review and its review rounds stay on the board, in the Review column.
  if (run.status === "waiting_review") return "review";
  if (OPEN.has(run.status) && run.currentStep === "review_fix") return "review";
  if (run.status === "done") return "done";
  if (!OPEN.has(run.status)) return "closed";
  return run.latestStep && run.latestStep.kind === run.currentStep ? run.latestStep.kind : run.currentStep;
}

function RunCard({ run, task, now }: { run: RunSummary; task: BacklogTask | undefined; now: number }) {
  const step = run.latestStep;
  const status = run.status === "needs_human" || run.status === "waiting_review" ? runStatus(run.status) : step && OPEN.has(run.status) ? stepStatus(step.status) : runStatus(run.status);
  const detail =
    run.status === "needs_human"
      ? (run.exitReason ?? (step?.permissionPrompts ? "Waiting for a permission answer" : "Waiting for a person"))
      : run.status === "waiting_review"
        ? run.prUrl
          ? null
          : "Awaiting review"
        : run.exitReason;
  return (
    <div className={`card run-card${run.status === "needs_human" ? " attention" : ""}`} data-testid={`run-card-${run.taskId}`}>
      <a className="card-link" href={`#/runs/${run.id}`}>
        <div className="mono small muted">{run.taskId}</div>
        <div className="title">{task?.title ?? run.taskId}</div>
      </a>
      <Badge tone={status.tone} label={status.label} />
      <div className="meta small muted">
        {step?.model ? `${step.model} · ` : ""}
        {duration(step?.startedAt ?? null, step?.endedAt ?? null, now)}
        {step && (step.permissionPrompts || step.toolDenials) ? ` · ${step.permissionPrompts} prompts · ${step.toolDenials} denied` : ""}
      </div>
      {run.status === "waiting_review" && run.prUrl ? (
        <div className="small muted">
          <a className="pr-link" href={run.prUrl} target="_blank" rel="noreferrer">PR #{run.prNumber ?? ""}</a>
          {run.reviewRound ? ` · review round ${run.reviewRound}` : ""}
        </div>
      ) : null}
      {detail ? <div className="small muted">{detail}</div> : null}
    </div>
  );
}

export interface BoardProps {
  project: Project;
  runs: RunSummary[];
  backlog: BacklogTask[];
  now: number;
  onChanged: () => void;
  queue?: QueueView | null;
  plans?: PlanView[];
  orchestrator?: OrchestratorSession | null;
}

export function Board({ project, runs, backlog, now, onChanged, queue = null, plans = [], orchestrator = null }: BoardProps) {
  const [error, setError] = useState<string | null>(null);
  const [list, setList] = useState<ListId>(savedList);
  const choose = (id: ListId) => {
    setList(id);
    try {
      localStorage.setItem(LIST_KEY, id);
    } catch {
      // Storage blocked: the choice lasts until the page reloads.
    }
  };
  const mine = runs.filter((r) => r.projectPath === project.repoPath);
  const latestPerTask = new Map<string, RunSummary>();
  for (const run of mine) latestPerTask.set(run.taskId, run);
  const shown = [...latestPerTask.values()];
  const tasks = new Map(backlog.map((t) => [t.id, t]));
  const merged = new Set(shown.filter((r) => r.status === "done").map((r) => r.taskId));
  const notStarted = backlog.filter((t) => !latestPerTask.has(t.id) || ["failed", "cancelled"].includes(latestPerTask.get(t.id)?.status ?? ""));

  const columns = STEP_COLUMNS.map((id) => ({ id, label: id === "review" ? "Review" : (STEP_LABELS[id] ?? id) }));
  const prRuns = shown.filter((r) => r.status === "waiting_review" || r.status === "done").sort(byPrOrder);

  const act = async (action: () => Promise<unknown>) => {
    setError(null);
    try {
      await action();
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const launch = (taskId: string) => act(() => api.startRun(project.repoPath, taskId));

  const proposed = plans.find((p) => p.status === "proposed");
  const queuedTasks = (queue?.queued ?? []).filter((t) => t.projectPath === project.repoPath);
  const queuedIds = new Set(queuedTasks.map((t) => t.taskId));
  const backlogTasks = notStarted.filter((task) => !queuedIds.has(task.id));
  const counts: Record<ListId, number> = { queued: queuedTasks.length, prs: prRuns.length, backlog: backlogTasks.length };
  const sessions = queue ? queue.active.length : shown.filter((r) => OPEN.has(r.status)).length;
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
        <div className="actions">
          {queue?.paused ? (
            <button type="button" className="btn" onClick={() => void act(() => api.resumeQueue())}>Resume queue</button>
          ) : (
            <button type="button" className="btn" onClick={() => void act(() => api.pauseQueue())}>Pause queue</button>
          )}
          <button type="button" className="btn primary" onClick={() => void act(() => api.startOrchestrator(project.id))}>Launch tasks</button>
        </div>
      </div>

      {queue?.paused ? (
        <div className="card paused-banner" role="status">
          <span><strong>Queue paused.</strong> {queue.paused.reason}{queue.paused.until ? ` · resumes at ${new Date(queue.paused.until).toLocaleTimeString()}` : ""}. Running sessions finish their step; nothing new starts.</span>
        </div>
      ) : null}

      <div className="stats">
        <div className="card stat"><div className="muted small">Active sessions</div><div className="value" data-testid="active-sessions">{queue ? sessions : active}</div></div>
        <div className="card stat"><div className="muted small">Queued</div><div className="value">{queuedTasks.length}</div></div>
        <div className={`card stat${attention ? " attention" : ""}`}><div className="small">Need attention</div><div className="value">{attention}</div></div>
        <div className="card stat"><div className="muted small">Open PRs</div><div className="value">{openPrs}</div></div>
      </div>

      {error ? <p role="alert" className="small" style={{ color: "var(--st-failed-fg)" }}>{error}</p> : null}
      <div className={orchestrator ? "execution" : ""}>
      <div style={{ minWidth: 0 }}>
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

      {proposed ? (
        <PlanCard plan={proposed} onApprove={() => void act(() => api.approvePlan(proposed.id))} onReject={() => void act(() => api.rejectPlan(proposed.id))} />
      ) : null}

      <section className="card panel task-lists" aria-label="Task lists">
        <div className="tabs" role="tablist" aria-label="Task lists">
          {LISTS.map((l) => (
            <button
              key={l.id}
              type="button"
              role="tab"
              id={`list-tab-${l.id}`}
              aria-selected={list === l.id}
              aria-controls={`list-${l.id}`}
              className={`tab${list === l.id ? " active" : ""}`}
              onClick={() => choose(l.id)}
            >
              <span>{l.label}</span> <span className="tab-count">{counts[l.id]}</span>
            </button>
          ))}
        </div>
        <div role="tabpanel" id={`list-${list}`} aria-label={LISTS.find((l) => l.id === list)?.label}>
          {list === "queued" ? (
            <>
              <p className="muted small list-hint">Start when a slot frees up and their dependencies are on {project.defaultBranch}</p>
              {queuedTasks.length === 0 ? <p className="muted">Nothing queued. Approve a plan to queue its tasks.</p> : null}
              <Paged
                key="queued"
                items={queuedTasks}
                render={(t) => (
                  <div className="list-row" key={t.id} data-testid={`queued-${t.taskId}`}>
                    <span className="mono small muted">{t.taskId}</span>
                    <span>{t.title}</span>
                    <span />
                    <Badge tone="queued" label={t.waitReason ?? "Starting"} />
                  </div>
                )}
              />
            </>
          ) : list === "prs" ? (
            <>
              <p className="muted small list-hint">New review comments from allowed authors start a review round</p>
              {prRuns.length === 0 ? <p className="muted">No pull request yet.</p> : null}
              <Paged
                key="prs"
                items={prRuns}
                render={(run) => {
                  const status = runStatus(run.status);
                  return (
                    <a key={run.id} className="list-row" href={`#/runs/${run.id}`} data-testid={`pr-row-${run.taskId}`} style={{ color: "inherit", textDecoration: "none" }}>
                      <span className="mono small muted">{run.taskId}</span>
                      <span>{tasks.get(run.taskId)?.title ?? run.taskId}</span>
                      <span className="small muted">{run.prUrl ? `PR #${run.prNumber ?? ""}` : ""}{run.reviewRound ? ` · review round ${run.reviewRound}` : ""}</span>
                      <Badge tone={status.tone} label={status.label} />
                    </a>
                  );
                }}
              />
            </>
          ) : (
            <>
              <p className="muted small list-hint">A task starts once its dependencies are merged</p>
              {backlogTasks.length === 0 ? <p className="muted">Every task has a run.</p> : null}
              <Paged
                key="backlog"
                items={backlogTasks}
                render={(task) => {
                  const waitingFor = task.dependsOn.filter((d) => !merged.has(d));
                  return (
                    <div className="list-row" key={task.id}>
                      <span className="mono small muted">{task.id}</span>
                      <span>{task.title}</span>
                      {waitingFor.length ? <Badge tone="queued" label={`Waits for ${waitingFor.join(", ")} merge`} /> : <Badge tone="queued" label="Ready" />}
                      <button type="button" className="btn" onClick={() => void launch(task.id)} aria-label={`Launch ${task.id}`}>Launch</button>
                    </div>
                  );
                }}
              />
            </>
          )}
        </div>
      </section>
      </div>
      {orchestrator ? <OrchestratorPane projectId={project.id} session={orchestrator.tmuxSession} onStop={() => void act(() => api.stopOrchestrator(project.id))} /> : null}
      </div>
    </>
  );
}
