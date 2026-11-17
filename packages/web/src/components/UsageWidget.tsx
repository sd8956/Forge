import type { QueueView } from "../api.js";

function inHours(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  const h = Math.floor(minutes / 60);
  return h ? `${h} h ${minutes % 60} min` : `${minutes} min`;
}

/** The 5-hour usage window Claude Code reports through Forge's status line. */
export function UsageWidget({ queue, now }: { queue: QueueView | null; now: number }) {
  const window = queue?.usage?.fiveHour ?? null;
  const percent = window ? Math.round(window.percent) : null;
  const high = percent !== null && queue !== null && percent >= queue.usagePausePercent;
  return (
    <div className="card usage" aria-label="Usage window">
      <div className="kv"><span>Usage window</span><strong data-testid="usage-percent">{percent === null ? "—" : `${percent}%`}</strong></div>
      <div className="usage-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent ?? 0}>
        <div className={high ? "high" : ""} style={{ width: `${percent ?? 0}%` }} />
      </div>
      <div className="muted small">{window ? `Resets in ${inHours(window.resetsAt - now)}` : "Shown after a step's first answer"}</div>
    </div>
  );
}
