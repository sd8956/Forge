import { describe, expect, it } from "vitest";
import { parsePipeline } from "../pipeline/pipeline.js";
import { decideNext, firstStep, stepsFor, type StepOutcome } from "./next-action.js";

const pipeline = parsePipeline(`
version: 1
defaults: { max_attempts: 2 }
steps:
  - { id: plan, agent: forge-planner, model: opus, settings: s.json }
  - { id: development, agent: forge-developer, model: sonnet, settings: s.json }
  - { id: security, agent: forge-security, model: opus, settings: s.json, on_fail: { goto: development, max_attempts: 3 } }
  - { id: e2e, agent: forge-tester, model: sonnet, settings: s.json, on_fail: { goto: development } }
  - { id: pr, agent: forge-pr, model: sonnet, settings: s.json }
review:
  max_rounds: 2
  fix: { id: review_fix, agent: forge-review-fixer, model: sonnet, settings: s.json, exit: { threads_answered: true } }
  then: [security, e2e, pr]
`);

const outcome = (step: StepOutcome["step"], result: StepOutcome["result"], cause: StepOutcome["cause"] = "reported"): StepOutcome => ({ step, result, cause });

describe("decideNext", () => {
  it("starts with the first step", () => {
    expect(firstStep(pipeline)).toBe("plan");
  });

  it("moves to the next step when a step is done", () => {
    expect(decideNext(pipeline, {}, outcome("plan", "done"))).toEqual({ kind: "launch", step: "development", attempts: {}, reason: "next_step" });
  });

  it("completes the run after the last step", () => {
    expect(decideNext(pipeline, { e2e: 1 }, outcome("pr", "done"))).toEqual({ kind: "complete", attempts: { e2e: 1 } });
  });

  it("sends a reported security failure back to development and counts it", () => {
    expect(decideNext(pipeline, {}, outcome("security", "failed"))).toEqual({
      kind: "launch",
      step: "development",
      attempts: { security: 1 },
      reason: "on_fail",
    });
  });

  it("uses on_fail.max_attempts for the loop: the third security failure needs a person", () => {
    expect(decideNext(pipeline, { security: 1 }, outcome("security", "failed")).kind).toBe("launch");
    expect(decideNext(pipeline, { security: 2 }, outcome("security", "failed"))).toEqual({
      kind: "needs_human",
      step: "security",
      reason: "attempts_exhausted",
      attempts: { security: 3 },
    });
  });

  it("falls back to the step's max_attempts when on_fail has none (e2e: 2)", () => {
    expect(decideNext(pipeline, {}, outcome("e2e", "failed"))).toMatchObject({ kind: "launch", step: "development", attempts: { e2e: 1 } });
    expect(decideNext(pipeline, { e2e: 1 }, outcome("e2e", "failed"))).toMatchObject({ kind: "needs_human", reason: "attempts_exhausted" });
  });

  it("keeps loop counters independent", () => {
    expect(decideNext(pipeline, { security: 2 }, outcome("e2e", "failed"))).toMatchObject({ kind: "launch", attempts: { security: 2, e2e: 1 } });
  });

  it("relaunches a step stopped by a usage limit without spending an attempt", () => {
    expect(decideNext(pipeline, { security: 2 }, outcome("security", "failed", "rate_limit"))).toEqual({
      kind: "launch",
      step: "security",
      attempts: { security: 2 },
      reason: "rate_limit",
    });
  });

  it("retries the same step after an infrastructure failure, even when it has on_fail", () => {
    expect(decideNext(pipeline, {}, outcome("security", "failed", "infrastructure"))).toEqual({
      kind: "launch",
      step: "security",
      attempts: { security: 1 },
      reason: "retry",
    });
  });

  it("retries a reported failure of a step without on_fail, up to its max_attempts", () => {
    expect(decideNext(pipeline, {}, outcome("development", "failed"))).toMatchObject({ kind: "launch", step: "development", reason: "retry" });
    expect(decideNext(pipeline, { development: 1 }, outcome("development", "failed"))).toMatchObject({ kind: "needs_human", step: "development" });
  });

  it("hands a blocked step to a person without spending an attempt", () => {
    expect(decideNext(pipeline, {}, outcome("development", "blocked"))).toMatchObject({ kind: "needs_human", reason: "blocked", attempts: {} });
  });

  it("fails the run when a step cannot even be launched", () => {
    expect(decideNext(pipeline, {}, outcome("plan", "failed", "launch"))).toEqual({ kind: "fail", step: "plan", reason: "launch_failed" });
  });

  it("does not mutate the attempts it receives", () => {
    const attempts = { security: 1 };
    decideNext(pipeline, attempts, outcome("security", "failed"));
    expect(attempts).toEqual({ security: 1 });
  });
});

describe("decideNext in review mode", () => {
  it("runs review_fix, then security, e2e and pr, then completes", () => {
    expect(stepsFor(pipeline, "review").map((s) => s.id)).toEqual(["review_fix", "security", "e2e", "pr"]);
    expect(firstStep(pipeline, "review")).toBe("review_fix");
    expect(decideNext(pipeline, {}, outcome("review_fix", "done"), "review")).toMatchObject({ kind: "launch", step: "security" });
    expect(decideNext(pipeline, {}, outcome("e2e", "done"), "review")).toMatchObject({ kind: "launch", step: "pr" });
    expect(decideNext(pipeline, {}, outcome("pr", "done"), "review")).toMatchObject({ kind: "complete" });
  });

  it("sends a failed security or e2e back to review_fix instead of development", () => {
    expect(decideNext(pipeline, {}, outcome("security", "failed"), "review")).toMatchObject({ kind: "launch", step: "review_fix", reason: "on_fail" });
    expect(decideNext(pipeline, {}, outcome("e2e", "failed"), "review")).toMatchObject({ kind: "launch", step: "review_fix" });
  });

  it("keeps build mode unchanged", () => {
    expect(stepsFor(pipeline, "build").map((s) => s.id)).toEqual(["plan", "development", "security", "e2e", "pr"]);
    expect(decideNext(pipeline, {}, outcome("security", "failed"))).toMatchObject({ step: "development" });
  });
});
