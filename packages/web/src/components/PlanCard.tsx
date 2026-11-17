import type { PlanView } from "../api.js";

/** A plan the orchestrator proposed, waiting for the person's decision. */
export function PlanCard({ plan, onApprove, onReject }: { plan: PlanView; onApprove: () => void; onReject: () => void }) {
  const waves = [...new Set(plan.tasks.map((t) => t.wave))].sort((a, b) => a - b);
  return (
    <section className="card panel plan-card" aria-label="Proposed plan" style={{ marginBottom: 18 }}>
      <div className="page-header" style={{ marginBottom: 8 }}>
        <div>
          <h2>Proposed plan</h2>
          <div className="muted small">Nothing runs until you approve it</div>
        </div>
        <div className="actions">
          <button type="button" className="btn" onClick={onReject}>Reject</button>
          <button type="button" className="btn primary" onClick={onApprove}>Approve plan</button>
        </div>
      </div>
      <p className="small">{plan.rationale}</p>
      {waves.map((wave) => (
        <div key={wave} className="plan-wave">
          <div className="muted small">Wave {wave + 1}</div>
          {plan.tasks.filter((t) => t.wave === wave).map((t) => (
            <div className="plan-row" key={t.id} data-testid={`plan-task-${t.taskId}`}>
              <span className="mono small muted">{t.taskId}</span>
              <span className="plan-title">{t.title}</span>
              <span className="chips" aria-label={`Modules of ${t.taskId}`}>
                {t.modules.map((m) => <span key={m} className="chip mono">{m}</span>)}
              </span>
              <span className="small muted">{t.dependsOn.length ? `after ${t.dependsOn.join(", ")}` : ""}</span>
            </div>
          ))}
        </div>
      ))}
    </section>
  );
}
