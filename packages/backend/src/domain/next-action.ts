import type { StepKind } from "@forge/shared";
import { stepById, type Pipeline } from "../pipeline/pipeline.js";

/** Failures counted per step: the loop counters of a run. */
export type Attempts = Partial<Record<StepKind, number>>;

export interface StepOutcome {
  step: StepKind;
  result: "done" | "blocked" | "failed";
  /**
   * reported: the agent called report_step. infrastructure: timeout, crash or
   * lost session. launch: the session could not even start (deterministic).
   */
  cause: "reported" | "infrastructure" | "launch";
}

export type NextAction =
  | { kind: "launch"; step: StepKind; attempts: Attempts; reason: "next_step" | "on_fail" | "retry" }
  | { kind: "complete"; attempts: Attempts }
  | { kind: "needs_human"; step: StepKind; reason: "blocked" | "attempts_exhausted"; attempts: Attempts }
  | { kind: "fail"; step: StepKind; reason: "launch_failed" };

export function firstStep(pipeline: Pipeline): StepKind {
  const first = pipeline.steps[0];
  if (!first) throw new Error("Pipeline has no steps");
  return first.id;
}

/**
 * Decides what the run does after a step ends. Pure: the run service applies
 * the result atomically and launches the next step.
 */
export function decideNext(pipeline: Pipeline, attempts: Attempts, outcome: StepOutcome): NextAction {
  const step = stepById(pipeline, outcome.step);

  if (outcome.result === "done") {
    const index = pipeline.steps.findIndex((s) => s.id === step.id);
    const next = pipeline.steps[index + 1];
    return next ? { kind: "launch", step: next.id, attempts: { ...attempts }, reason: "next_step" } : { kind: "complete", attempts: { ...attempts } };
  }

  if (outcome.result === "blocked") {
    return { kind: "needs_human", step: step.id, reason: "blocked", attempts: { ...attempts } };
  }

  if (outcome.cause === "launch") return { kind: "fail", step: step.id, reason: "launch_failed" };

  const failures = (attempts[step.id] ?? 0) + 1;
  const counted: Attempts = { ...attempts, [step.id]: failures };
  // Only a failure the agent reported (a real finding) follows on_fail; a crash retries the same step.
  const loop = outcome.cause === "reported" ? step.on_fail : undefined;
  const limit = loop?.max_attempts ?? step.max_attempts;
  if (failures >= limit) return { kind: "needs_human", step: step.id, reason: "attempts_exhausted", attempts: counted };
  return loop
    ? { kind: "launch", step: loop.goto, attempts: counted, reason: "on_fail" }
    : { kind: "launch", step: step.id, attempts: counted, reason: "retry" };
}
