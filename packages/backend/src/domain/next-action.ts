import type { StepKind } from "@forge/shared";
import { stepById, type Pipeline, type PipelineStep } from "../pipeline/pipeline.js";

/** build: the task's first pass; review: a round started by the PR watcher. */
export type RunMode = "build" | "review";

/**
 * Ordered steps of a mode. In review mode, on_fail targets outside the review
 * loop (development) map to review_fix, which plays the developer's role.
 */
export function stepsFor(pipeline: Pipeline, mode: RunMode): PipelineStep[] {
  if (mode === "build") return pipeline.steps;
  const review = pipeline.review;
  if (!review) throw new Error("The pipeline has no review loop");
  const ids = new Set<StepKind>(["review_fix", ...review.then]);
  return [
    review.fix,
    ...review.then.map((id) => {
      const step = stepById(pipeline, id);
      return step.on_fail && !ids.has(step.on_fail.goto) ? { ...step, on_fail: { ...step.on_fail, goto: "review_fix" as const } } : step;
    }),
  ];
}

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

export function firstStep(pipeline: Pipeline, mode: RunMode = "build"): StepKind {
  const first = stepsFor(pipeline, mode)[0];
  if (!first) throw new Error("Pipeline has no steps");
  return first.id;
}

/**
 * Decides what the run does after a step ends. Pure: the run service applies
 * the result atomically and launches the next step.
 */
export function decideNext(pipeline: Pipeline, attempts: Attempts, outcome: StepOutcome, mode: RunMode = "build"): NextAction {
  const steps = stepsFor(pipeline, mode);
  const step = steps.find((s) => s.id === outcome.step);
  if (!step) throw new Error(`Step "${outcome.step}" is not part of the ${mode} steps`);

  if (outcome.result === "done") {
    const index = steps.findIndex((s) => s.id === step.id);
    const next = steps[index + 1];
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
