import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api, definitionFileUrl, type DefinitionView, type Project } from "../api.js";
import { useTmuxTerminal } from "../components/Terminal.js";
import { currentStage, STAGE_LABELS, stageStatusText } from "../definition.js";

/** Starts a definition in a git repository (an empty clone of a new repo is fine). */
export function StartDefinition({ onStarted }: { onStarted: (view: DefinitionView) => void }) {
  const [path, setPath] = useState("");
  const [idea, setIdea] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="card panel start-definition"
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        setBusy(true);
        void api.beginDefinition(path.trim(), idea.trim()).then(onStarted, (err: unknown) => setError(err instanceof Error ? err.message : String(err))).finally(() => setBusy(false));
      }}
    >
      <h2>Define a new project</h2>
      <p className="muted small">Six stages, each a Claude Code session you can talk to. Nothing moves on until you approve it.</p>
      <label htmlFor="definition-path" className="small">Repository path</label>
      <input id="definition-path" className="mono field" value={path} onChange={(e) => setPath(e.target.value)} placeholder="/home/me/code/new-app" />
      <label htmlFor="definition-idea" className="small">The idea, in your words</label>
      <textarea id="definition-idea" className="field" rows={5} value={idea} onChange={(e) => setIdea(e.target.value)} placeholder="What it does, who uses it, platforms, stack, limits…" />
      {error ? <p role="alert" className="small" style={{ color: "var(--st-failed-fg)" }}>{error}</p> : null}
      <button type="submit" className="btn primary" disabled={busy || !path.trim() || idea.trim().length < 10}>Start the definition</button>
    </form>
  );
}

function StageProgress({ view }: { view: DefinitionView }) {
  const current = currentStage(view)?.stage;
  return (
    <ol className="stages" aria-label="Definition stages">
      {view.stages.map((s, i) => (
        <li key={s.stage} className={`stage ${s.status === "approved" ? "approved" : s.stage === current ? "current" : ""}`} data-testid={`stage-${s.stage}`}>
          <div className="stage-bar" />
          <div className="small muted">{i + 1} · {STAGE_LABELS[s.stage]}</div>
          <div className="stage-status">{stageStatusText(s)}</div>
        </li>
      ))}
    </ol>
  );
}

function Session({ stepId, label, live }: { stepId: string; label: string; live: boolean }) {
  // The person talks to the stage here, so the terminal attaches in control mode.
  const { container, state, send } = useTmuxTerminal(`/ws/terminal/${stepId}`, true);
  const [message, setMessage] = useState("");
  return (
    <section className="card session" aria-label="Session">
      <div className="orchestrator-head">
        <strong>Session · {label}</strong>
        <span className="muted small" style={{ marginLeft: "auto" }}>Claude Code · Opus{live ? "" : " · finished"}</span>
      </div>
      <div className="terminal orchestrator-terminal">
        <div className="terminal-screen" ref={container} data-testid="definition-terminal" />
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
        <label className="sr-only" htmlFor="stage-message">Ask for a change</label>
        <input id="stage-message" value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Ask for a change…" />
        <button type="submit" className="btn primary" disabled={!message.trim() || state !== "open"}>Send</button>
      </form>
    </section>
  );
}

const DOCS = ["intake.md", "requirements.md", "architecture.md", "threat-model.md", "test-strategy.md", "design/components.md"];

function Documents({ view, onChanged }: { view: DefinitionView; onChanged: (v: DefinitionView) => void }) {
  const docs = DOCS.filter((d) => view.files.includes(`.factory/${d}`));
  const backlog = view.files.filter((f) => /^\.factory\/backlog\/TASK-\d+\.md$/.test(f)).map((f) => f.replace(".factory/", ""));
  // In the order the stages write them: the prototype (UI design) comes before the backlog.
  const tabs = [...docs, ...(view.prototypeScreens.length ? ["Prototype"] : []), ...(backlog.length ? ["backlog"] : [])];
  const [tab, setTab] = useState<string | null>(null);
  const active = tab && tabs.includes(tab) ? tab : (tabs.at(-1) ?? null);
  const [text, setText] = useState("");
  const [screen, setScreen] = useState<string | null>(null);
  const design = view.stages.find((s) => s.stage === "design");

  // Refetch when a shown file changes: its version is its modification time, so edits by a live session show up too.
  const version = (path: string) => view.fileVersions[`.factory/${path}`] ?? 0;
  const filesKey = (active === "backlog" ? backlog : active ? [active] : []).map((p) => `${p}@${version(p)}`).join(",");
  const backlogKey = backlog.join(",");
  useEffect(() => {
    if (!active || active === "Prototype") return;
    const paths = active === "backlog" ? backlogKey.split(",") : [active];
    void Promise.all(paths.map((p) => fetch(definitionFileUrl(view.projectId, p)).then((r) => r.text()))).then((parts) => setText(parts.join("\n\n---\n\n")));
  }, [active, view.projectId, filesKey, backlogKey]);

  if (!active) return <p className="muted panel">The stage's files show here once it writes them.</p>;
  const shownScreen = screen && view.prototypeScreens.includes(screen) ? screen : view.prototypeScreens[0];
  const screenUrl = (name: string) => `${definitionFileUrl(view.projectId, `prototype/${name}`)}?v=${version(`prototype/${name}`)}`;
  return (
    <>
      <div className="tabs" role="tablist" style={{ padding: "0 18px" }}>
        {tabs.map((t) => (
          <button key={t} type="button" role="tab" aria-selected={t === active} className={t === active ? "active" : ""} onClick={() => setTab(t)}>
            {t.replace("design/", "")}
          </button>
        ))}
      </div>
      {active === "Prototype" && shownScreen ? (
        <div className="panel prototype">
          <div className="screens" aria-label="Screens">
            {view.prototypeScreens.map((s) => {
              const approved = design?.approvedScreens.includes(s) ?? false;
              return (
                <div key={s} className={`screen-row${s === shownScreen ? " active" : ""}`}>
                  <button type="button" className="link mono small" onClick={() => setScreen(s)}>{s}</button>
                  {approved ? (
                    <span className="badge done">Approved</span>
                  ) : design?.status === "in_review" ? (
                    <button type="button" className="btn" onClick={() => void api.approveScreen(view.projectId, s).then(onChanged)} aria-label={`Approve screen ${s}`}>Approve screen</button>
                  ) : null}
                </div>
              );
            })}
            {/* The served file keeps its sandbox CSP in a tab of its own too. */}
            <a className="small" href={screenUrl(shownScreen)} target="_blank" rel="noopener noreferrer" style={{ marginLeft: "auto" }}>Open full size</a>
          </div>
          {/* Generated HTML: sandboxed without allow-same-origin, and its CSP blocks the network. The version reloads it when rewritten. */}
          <iframe key={screenUrl(shownScreen)} title={`Prototype ${shownScreen}`} sandbox="allow-scripts" src={screenUrl(shownScreen)} className="prototype-frame" />
        </div>
      ) : (
        <div className="panel doc markdown" data-testid="definition-document">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
        </div>
      )}
    </>
  );
}

function Gate({ view, onChanged }: { view: DefinitionView; onChanged: (v: DefinitionView) => void }) {
  const stage = currentStage(view);
  const [feedback, setFeedback] = useState("");
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!stage) return null;
  const run = (call: Promise<DefinitionView>) =>
    void call.then(
      (v) => {
        setError(null);
        setAsking(false);
        setFeedback("");
        onChanged(v);
      },
      (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
    );
  const label = STAGE_LABELS[stage.stage];
  const next = view.stages[view.stages.indexOf(stage) + 1];
  if (stage.status === "pending" && stage.lastError) {
    return (
      <div className="gate" role="region" aria-label="Gate">
        <div><strong>{label} stopped</strong><div className="small muted">{stage.lastError}</div></div>
        <button type="button" className="btn primary" onClick={() => run(api.retryStage(view.projectId, stage.stage))}>Retry</button>
      </div>
    );
  }
  if (stage.status !== "in_review") return null;
  return (
    <div className="gate" role="region" aria-label="Gate">
      <div>
        <strong>Gate · {label}</strong>
        <div className="small muted">{next ? `Approving starts the ${STAGE_LABELS[next.stage].toLowerCase()}` : "Approving opens the definition pull request"}</div>
        {error ? <div role="alert" className="small" style={{ color: "var(--st-failed-fg)" }}>{error}</div> : null}
      </div>
      {asking ? (
        <form className="changes" onSubmit={(e) => { e.preventDefault(); run(api.requestChanges(view.projectId, stage.stage, feedback.trim())); }}>
          <label className="sr-only" htmlFor="changes">What should change</label>
          <textarea id="changes" className="field" rows={3} value={feedback} onChange={(e) => setFeedback(e.target.value)} placeholder="What should change" />
          <div className="actions">
            <button type="button" className="btn" onClick={() => setAsking(false)}>Back</button>
            <button type="submit" className="btn primary" disabled={feedback.trim().length < 3}>Send the changes</button>
          </div>
        </form>
      ) : (
        <div className="actions">
          <button type="button" className="btn" onClick={() => setAsking(true)}>Request changes</button>
          <button type="button" className="btn primary" onClick={() => run(api.approveStage(view.projectId, stage.stage))}>Approve and continue</button>
        </div>
      )}
    </div>
  );
}

export function DefinitionPage({ project, view, onChanged }: { project: Project; view: DefinitionView; onChanged: (v: DefinitionView) => void }) {
  const stage = currentStage(view);
  const shownStage = stage ?? view.stages.at(-1)!;
  return (
    <>
      <div className="page-header">
        <div>
          <h1>Definition</h1>
          <div className="muted">{project.name} · {view.idea.split("\n")[0]?.slice(0, 120)}</div>
        </div>
        {view.prUrl ? <a className="btn primary" href={view.prUrl} target="_blank" rel="noreferrer">Definition PR</a> : null}
      </div>
      <StageProgress view={view} />
      {/* With no live session, the documents and the prototype take most of the width. */}
      <div className={`definition${shownStage.status === "running" ? "" : " idle"}`}>
        {shownStage.stepId && shownStage.status === "running" ? (
          <Session key={shownStage.stepId} stepId={shownStage.stepId} label={STAGE_LABELS[shownStage.stage]} live />
        ) : (
          <div className="card panel muted session-idle">
            {shownStage.status === "in_review" ? `The ${STAGE_LABELS[shownStage.stage]} session finished. Review its files, then approve or ask for changes.` : stage ? "Waiting for the next session." : "Every stage is approved."}
          </div>
        )}
        <section className="card documents" aria-label="Documents">
          <Documents view={view} onChanged={onChanged} />
          <Gate view={view} onChanged={onChanged} />
          {!stage ? (
            <div className="gate">
              <strong>{view.mergedAt ? "Definition merged." : "Definition approved."}</strong>
              {view.mergedAt ? (
                <a className="btn primary" href="#/">Plan the backlog in Execution</a>
              ) : (
                <span className="small muted">{view.prUrl ? "Merge the definition PR; Forge notices and updates your clone." : "Opening the definition PR…"}</span>
              )}
            </div>
          ) : null}
        </section>
      </div>
    </>
  );
}
