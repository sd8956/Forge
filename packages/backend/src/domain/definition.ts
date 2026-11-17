import type { DefinitionStage, DefinitionStageStatus } from "@forge/shared";
import { DEFINITION_STAGES } from "@forge/shared";

export type DefinitionEvent = "start" | "report" | "session_failed" | "approve" | "request_changes";

const TRANSITIONS: Record<DefinitionStageStatus, Partial<Record<DefinitionEvent, DefinitionStageStatus>>> = {
  pending: { start: "running" },
  // A session that ends without a valid report goes back to pending, so a person can start it again.
  running: { report: "in_review", session_failed: "pending" },
  in_review: { approve: "approved", request_changes: "changes_requested" },
  changes_requested: { start: "running" },
  approved: {},
};

/** The only way a definition stage changes status; null when the event does not apply. */
export function nextStageStatus(from: DefinitionStageStatus, event: DefinitionEvent): DefinitionStageStatus | null {
  return TRANSITIONS[from][event] ?? null;
}

export function nextStage(stage: DefinitionStage): DefinitionStage | null {
  return DEFINITION_STAGES[DEFINITION_STAGES.indexOf(stage) + 1] ?? null;
}

/** Step kind and agent of a stage's session. */
export const stageKind = (stage: DefinitionStage) => `def_${stage}` as const;
export const stageAgent = (stage: DefinitionStage) => `forge-def-${stage.replace("_", "-")}`;
export function stageOfKind(kind: string): DefinitionStage | null {
  const stage = kind.startsWith("def_") ? kind.slice(4) : "";
  return (DEFINITION_STAGES as readonly string[]).includes(stage) ? (stage as DefinitionStage) : null;
}
