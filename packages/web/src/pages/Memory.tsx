import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api, type MemoryList, type Project } from "../api.js";

/** What the project's steps saved in Engram. Read-only: steps write memory, the panel only shows it. */
export function MemoryPage({ project }: { project: Project }) {
  const [q, setQ] = useState("");
  const [ref, setRef] = useState("");
  const [list, setList] = useState<MemoryList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const validRef = !ref.trim() || /^TASK-\d{3,}(\/[a-z][a-z0-9-]*)?$/.test(ref.trim());

  useEffect(() => {
    if (!validRef) return;
    // Wait for typing to pause before asking Engram.
    const timer = window.setTimeout(() => {
      void api.memories(project.id, { q: q.trim(), ref: ref.trim() }).then(
        (l) => {
          setList(l);
          setError(null);
        },
        (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
      );
    }, 250);
    return () => window.clearTimeout(timer);
  }, [project.id, q, ref, validRef]);

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Memory</h1>
          <div className="muted">{project.name} · what the pipeline steps saved for future tasks</div>
        </div>
      </div>
      <div className="card panel memory-filters">
        <label className="small" htmlFor="memory-q">Search</label>
        <input id="memory-q" className="field" value={q} onChange={(e) => setQ(e.target.value)} placeholder="API error handling, e2e conventions…" />
        <label className="small" htmlFor="memory-ref">Task or step</label>
        <input id="memory-ref" className="field mono" value={ref} onChange={(e) => setRef(e.target.value)} placeholder="TASK-001 or TASK-001/review" />
        {!validRef ? <span className="small" role="alert" style={{ color: "var(--st-failed-fg)" }}>Use TASK-001 or TASK-001/review</span> : null}
      </div>
      {error ? <p role="alert">{error}</p> : null}
      {list && !list.available ? <div className="card panel muted" role="status">Engram is not reachable: {list.error}</div> : null}
      {list?.available && list.items.length === 0 ? <p className="muted">No memories match.</p> : null}
      <div className="memory-list" aria-label="Memories">
        {list?.items.map((m) => (
          <article key={m.id} className="card memory-card" data-testid={`memory-${m.id}`}>
            <button type="button" className="memory-head" aria-expanded={open === m.id} onClick={() => setOpen(open === m.id ? null : m.id)}>
              <span className="badge queued">{m.type}</span>
              <strong>{m.title}</strong>
              {m.ref ? <span className="mono small muted">{m.ref}</span> : null}
              <span className="small muted" style={{ marginLeft: "auto" }}>{m.createdAt}</span>
            </button>
            {open === m.id ? (
              <div className="panel markdown">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content}</ReactMarkdown>
                {m.runId ? <a href={`#/runs/${m.runId}`}>Open the run of {m.ref?.split("/")[0]}</a> : null}
              </div>
            ) : null}
          </article>
        ))}
      </div>
    </>
  );
}
