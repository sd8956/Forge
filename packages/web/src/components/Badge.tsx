import type { Tone } from "../status.js";

/** A state always carries its label, never color alone. */
export function Badge({ tone, label }: { tone: Tone; label: string }) {
  return <span className={`badge ${tone}`}>{label}</span>;
}
