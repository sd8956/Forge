import type { StepView } from "@forge/shared";
import { lazy, Suspense, useEffect, useState } from "react";
import { api, runFileUrl, type Evidence, type RunDetail as Detail } from "../api.js";
import { Badge } from "../components/Badge.js";
import { Icon } from "../components/Icon.js";
// xterm.js is large: load it only when a terminal is shown.
const Terminal = lazy(() => import("../components/Terminal.js").then((m) => ({ default: m.Terminal })));
import { duration, runStatus, STEP_LABELS, stepStatus } from "../status.js";

const TABS = ["Terminal", "Test plan and evidence", "Artifacts", "Review", "Memory"] as const;
type Tab = (typeof TABS)[number];

const LIVE = new Set(["queued", "running", "needs_human"]);
const handoffPath = (run: Detail, absolute: string) => absolute.split(`/.factory/runs/${run.taskId}/`)[1] ?? absolute;

function Timeline({ run, now }: { run: Detail; now: number }) {
  return (
    <ol className="timeline">
      {run.steps.map((step) => {
        const status = stepStatus(step.status);
        const icon = step.status === "done" ? "done" : step.status === "failed" ? "failed" : LIVE.has(step.status) ? "running" : "";
        const extra = [step.model, duration(step.startedAt, step.endedAt, now), step.permissionPrompts ? `${step.permissionPrompts} prompts` : ""].filter(Boolean).join(" · ");
        return (
          <li key={step.id} className={step.status === "failed" ? "failed" : step.status === "needs_human" ? "attention" : ""}>
            <span className={`icon ${icon}`}>
              {step.status === "done" ? <Icon name="check" size={13} label="Done" /> : step.status === "failed" ? <Icon name="alert" size={13} label="Failed" /> : null}
            </span>
            <div>
              <div style={{ fontWeight: 500 }}>
                {STEP_LABELS[step.kind] ?? step.kind} <span className="muted small">#{step.attempt}</span>
              </div>
              <div className="small muted">{extra}</div>
              {step.status !== "done" ? <Badge tone={status.tone} label={step.exitReason ?? status.label} /> : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function EvidenceTab({ run, evidence }: { run: Detail; evidence: Evidence | null }) {
  if (!evidence) return <p className="muted">Loading…</p>;
  if (!evidence.testPlan.length && !evidence.cases.length) return <p className="muted">No test plan yet.</p>;
  const cases = new Map(evidence.cases.map((c) => [c.id, c]));
  const ids = [...new Set([...evidence.testPlan.map((t) => t.id), ...evidence.cases.map((c) => c.id)])];
  const file = (f: string) => (evidence.evidenceDir ? runFileUrl(run.id, `${evidence.evidenceDir}/${f}`) : "#");
  const shots = evidence.cases.flatMap((c) => c.files.filter((f) => f.endsWith(".png")).slice(0, 1).map((f) => ({ c, f })));
  return (
    <>
      <div className="card">
        <div className="panel" style={{ display: "flex", justifyContent: "space-between" }}>
          <strong>test-plan.md · {ids.length} cases</strong>
          {evidence.tests ? <span className="muted small">{evidence.tests.passed} passed · {evidence.tests.failed} failed</span> : null}
        </div>
        <table>
          <thead><tr><th>Case</th><th>Description</th><th>Covers</th><th>Result</th><th>Evidence</th></tr></thead>
          <tbody>
            {ids.map((id) => {
              const planned = evidence.testPlan.find((t) => t.id === id);
              const result = cases.get(id);
              const tone = result?.result === "passed" ? "done" : result?.result === "failed" ? "failed" : "queued";
              return (
                <tr key={id} className={result?.result === "failed" ? "failed" : ""}>
                  <td className="mono">{id}</td>
                  <td>{planned?.title ?? ""}</td>
                  <td className="small">{(result?.frs.length ? result.frs : planned?.covers ?? []).join(", ")}</td>
                  <td><Badge tone={tone} label={result ? result.result[0]?.toUpperCase() + result.result.slice(1) : "Not run"} /></td>
                  <td className="small">
                    {result?.files.map((f) => (
                      <div key={f}><a href={file(f)} target="_blank" rel="noreferrer">{f.split("/").at(-1)}</a></div>
                    )) ?? "—"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {shots.length ? (
        <div className="shots">
          {shots.map(({ c, f }) => (
            <div key={c.id} className="card shot">
              <img src={file(f)} alt={`${c.id} evidence`} loading="lazy" />
              <div className="caption"><span className="mono small">{c.id}</span> <Badge tone={c.result === "passed" ? "done" : "failed"} label={c.result} /></div>
            </div>
          ))}
        </div>
      ) : null}
    </>
  );
}

function ArtifactsTab({ run }: { run: Detail }) {
  const files = run.steps.flatMap((s) => [handoffPath(run, s.outputPath), ...s.artifacts.map((a) => a.replace(`.factory/runs/${run.taskId}/`, ""))]);
  const unique = [...new Set(files)].filter((f) => !f.startsWith("/"));
  const [open, setOpen] = useState<string | null>(null);
  const [text, setText] = useState("");
  useEffect(() => {
    if (!open) return;
    void fetch(runFileUrl(run.id, open)).then((r) => r.text()).then(setText);
  }, [open, run.id]);
  return (
    <div style={{ display: "grid", gridTemplateColumns: "260px 1fr", gap: 14 }}>
      <div className="links">
        {unique.map((f) => (
          <button key={f} type="button" className="btn small" style={{ justifyContent: "flex-start", height: "auto", padding: "6px 10px" }} onClick={() => setOpen(f)} aria-pressed={open === f}>
            <span className="mono small">{f}</span>
          </button>
        ))}
      </div>
      {/* Agent output is shown as text, never rendered as HTML. */}
      <pre className="doc">{open ? text : "Pick a file."}</pre>
    </div>
  );
}

export function RunDetail({ id, now }: { id: string; now: number }) {
  const [run, setRun] = useState<Detail | null>(null);
  const [evidence, setEvidence] = useState<Evidence | null>(null);
  const [tab, setTab] = useState<Tab>("Terminal");
  const [message, setMessage] = useState<string | null>(null);

  const load = () => {
    void api.run(id).then(setRun).catch((e: unknown) => setMessage(String(e)));
    void api.evidence(id).then(setEvidence).catch(() => undefined);
  };
  useEffect(load, [id, now]);

  if (!run) return <p className="muted">{message ?? "Loading…"}</p>;
  const status = runStatus(run.status);
  const live: StepView | undefined = [...run.steps].reverse().find((s) => LIVE.has(s.status));
  const act = (action: "resume" | "cancel", opts: { mergeBase?: boolean } = {}) => {
    const call = action === "resume" ? api.resume(run.id, opts) : api.cancel(run.id);
    void call.then((r) => setMessage(r.message), (e: unknown) => setMessage(e instanceof Error ? e.message : String(e)));
  };
  const missingAgent = run.status === "needs_human" && run.exitReason?.startsWith("agent_missing:") ? run.events.filter((e) => e.type === "agent_missing").at(-1) : undefined;
  const findings = evidence?.security?.findings ?? {};

  return (
    <>
      <nav className="breadcrumb" aria-label="Breadcrumb"><a href="#/">Execution</a><span>/</span><span>{run.taskId}</span></nav>
      <div className="page-header">
        <div>
          <div className="mono small muted" style={{ display: "flex", gap: 10, alignItems: "center" }}>
            {run.taskId} · {run.branch} <Badge tone={status.tone} label={run.exitReason ? `${status.label} · ${run.exitReason}` : status.label} />
          </div>
          <h1 style={{ marginTop: 6 }}>{run.task?.title ?? run.taskId}</h1>
          <div className="muted">
            {[
              run.task?.covers.length ? `Covers ${run.task.covers.join(", ")}` : null,
              run.task?.size ? `size ${run.task.size}` : null,
              run.mode === "review" ? `review round ${run.reviewRound}` : null,
              Object.values(run.attempts).some((n) => n) ? `failures ${Object.entries(run.attempts).filter(([, n]) => n).map(([k, n]) => `${STEP_LABELS[k] ?? k} ${n}`).join(", ")}` : null,
            ]
              .filter(Boolean)
              .join(" · ")}
            {" · "}
            {run.prUrl ? <a href={run.prUrl} target="_blank" rel="noreferrer">PR #{run.prNumber}</a> : "no PR yet"}
          </div>
        </div>
        <div className="actions">
          {live ? <button type="button" className="btn" onClick={() => setTab("Terminal")}><Icon name="terminal" /> Open terminal</button> : null}
          {run.status === "needs_human" || run.status === "running" ? <button type="button" className="btn" onClick={() => act("resume")}><Icon name="play" /> Resume</button> : null}
          {["queued", "running", "needs_human", "waiting_review"].includes(run.status) ? <button type="button" className="btn" onClick={() => act("cancel")}><Icon name="stop" /> Cancel</button> : null}
        </div>
      </div>
      {message ? <p role="status" className="muted">{message}</p> : null}
      {missingAgent ? (
        <div className="card panel" role="alert" style={{ marginBottom: 16, borderColor: "var(--st-needs_attention-fg)" }}>
          <strong>The task branch has no {typeof missingAgent.payload.agent === "string" ? missingAgent.payload.agent : "step"} agent.</strong>
          <p className="muted small">It was created before the agent existed. {typeof missingAgent.payload.fix === "string" ? missingAgent.payload.fix : ""}</p>
          <button type="button" className="btn primary" onClick={() => act("resume", { mergeBase: true })}>Merge {run.baseBranch} and resume</button>
        </div>
      ) : null}

      <div className="detail">
        <div className="card panel"><h2>Pipeline</h2><Timeline run={run} now={now} /></div>

        <div>
          <div className="tabs" role="tablist">
            {TABS.map((t) => (
              <button key={t} type="button" role="tab" aria-selected={tab === t} onClick={() => setTab(t)}>{t}</button>
            ))}
          </div>
          {tab === "Terminal" ? (
            live ? (
              <Suspense fallback={<p className="muted">Loading terminal…</p>}>
                <Terminal key={live.id} stepId={live.id} session={live.tmuxSession} />
              </Suspense>
            ) : (
              <p className="muted">No session is running. Last transcript: <span className="mono small">{run.steps.at(-1)?.transcriptPath ?? "—"}</span></p>
            )
          ) : null}
          {tab === "Test plan and evidence" ? <EvidenceTab run={run} evidence={evidence} /> : null}
          {tab === "Artifacts" ? <ArtifactsTab run={run} /> : null}
          {tab === "Review" ? (
            run.prThreads.length ? (
              <table>
                <thead><tr><th>Thread</th><th>Author</th><th>Where</th><th>Status</th></tr></thead>
                <tbody>
                  {run.prThreads.map((t) => (
                    <tr key={t.id}>
                      <td><div className="mono small">{t.id}</div><div className="small">{t.body.slice(0, 200)}</div></td>
                      <td>{t.author ? `@${t.author}` : "CI"}</td>
                      <td className="mono small">{t.path ? `${t.path}${t.line ? `:${t.line}` : ""}` : "—"}</td>
                      <td><Badge tone={t.handled ? "done" : "running"} label={t.handled ? "Answered" : "Open"} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="muted">No review feedback yet.</p>
            )
          ) : null}
          {tab === "Memory" ? <MemoryList run={run} /> : null}
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div className="card panel">
            <h2 style={{ display: "flex", justifyContent: "space-between" }}>
              Security {evidence?.security ? <Badge tone={(findings.critical ?? 0) + (findings.high ?? 0) ? "failed" : "done"} label={(findings.critical ?? 0) + (findings.high ?? 0) ? "Blockers" : "No blockers"} /> : null}
            </h2>
            {evidence?.security ? (
              <>
                {["critical", "high", "medium", "low"].map((sev) => (
                  <div key={sev} className="kv"><span style={{ textTransform: "capitalize" }}>{sev}</span><span style={{ color: findings[sev] ? `var(--sev-${sev === "critical" ? "high" : sev})` : undefined }}>{findings[sev] ?? 0}</span></div>
                ))}
                {evidence.security.report ? <a href={runFileUrl(run.id, evidence.security.report)} target="_blank" rel="noreferrer">View security-report.md</a> : null}
              </>
            ) : <p className="muted small">Not run yet.</p>}
          </div>
          <div className="card panel"><h2>Saved to Engram</h2><MemoryList run={run} /></div>
        </div>
      </div>
    </>
  );
}

function MemoryList({ run }: { run: Detail }) {
  if (!run.memories.available) return <p className="muted small">Engram unavailable.</p>;
  if (!run.memories.items.length) return <p className="muted small">Nothing saved yet.</p>;
  return (
    <>
      {run.memories.items.map((m) => (
        <div key={m.id} className="memory-item"><div>{m.title}</div><div className="mono small muted">{m.ref}</div></div>
      ))}
    </>
  );
}
