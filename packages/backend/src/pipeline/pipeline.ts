import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, normalize } from "node:path";
import { STEP_KINDS, type StepKind } from "@forge/shared";
import { parse } from "yaml";
import { z } from "zod";

export class PipelineError extends Error {}

/** A path inside the project, relative to `.factory/` or the step's output directory. */
const relativePath = z
  .string()
  .min(1)
  .refine((p) => !isAbsolute(p) && !normalize(p).startsWith(".."), "must be a relative path inside the project");

const TASK_SIZES = ["S", "M", "L"] as const;
export type TaskSize = (typeof TASK_SIZES)[number];

const modelSpec = z.union([
  z.string().min(1),
  z.strictObject({ default: z.string().min(1), S: z.string().min(1).optional(), M: z.string().min(1).optional(), L: z.string().min(1).optional() }),
]);

const exitSpec = z.strictObject({
  /** Files the step must write in its output directory. */
  requires: z.array(relativePath).default([]),
  /** Every `AC-n` of the task appears in `test-plan.md`. */
  every_ac_has_tc: z.boolean().default(false),
  /** Shell command run in the worktree; must exit 0 for `done`. Also run by the Stop hook. */
  command: z.string().min(1).optional(),
  /** Highest finding severity allowed for `done`. */
  max_severity: z.enum(["none", "low", "medium", "high"]).optional(),
  /** Every test case in the evidence manifest passed and has evidence files. */
  all_cases_pass: z.boolean().default(false),
  /** The step reports a pull request URL. */
  pr_created: z.boolean().default(false),
  /** Every PR thread in the step's input is answered in `output.md` (review_fix). */
  threads_answered: z.boolean().default(false),
  /** Every unit or integration case of the test plan has red/green evidence, its failing test committed first (development). */
  tdd_evidence: z.boolean().default(false),
});

const stepKind = z.enum(STEP_KINDS, {
  error: (issue) => `unknown step ${JSON.stringify(issue.input)}; known steps: ${STEP_KINDS.join(", ")}`,
});

const stepSpec = z.strictObject({
  id: stepKind,
  agent: z.string().regex(/^forge-[a-z][a-z0-9-]*$/, "agent must be named forge-<name>"),
  model: modelSpec,
  /** Settings template, relative to `.factory/`. */
  settings: relativePath,
  timeout_minutes: z.number().positive().max(24 * 60).optional(),
  /** Runs of this step allowed before the run needs a person (retries of the same step). */
  max_attempts: z.number().int().min(1).max(10).optional(),
  exit: exitSpec.default({ requires: [], every_ac_has_tc: false, all_cases_pass: false, pr_created: false, threads_answered: false, tdd_evidence: false }),
  /** Where a reported failure sends the run, and how many failures of this step are allowed. */
  on_fail: z.strictObject({ goto: stepKind, max_attempts: z.number().int().min(1).max(10).optional() }).optional(),
});

const pipelineSpec = z
  .strictObject({
    version: z.literal(1, "pipeline version must be 1"),
    defaults: z
      .strictObject({ max_attempts: z.number().int().min(1).max(10).default(3), timeout_minutes: z.number().positive().default(45) })
      .default({ max_attempts: 3, timeout_minutes: 45 }),
    steps: z.array(stepSpec).min(1),
    /** What runs when the PR watcher reopens a run: a fix step, then re-verification steps. */
    review: z
      .strictObject({
        max_rounds: z.number().int().min(1).max(20).default(3),
        fix: stepSpec,
        then: z.array(stepKind).min(1),
      })
      .optional(),
  })
  .superRefine((pipeline, ctx) => {
    const seen = new Set<string>();
    pipeline.steps.forEach((step, index) => {
      if (seen.has(step.id)) ctx.addIssue({ code: "custom", path: ["steps", index, "id"], message: `Duplicate step id "${step.id}"` });
      if (step.on_fail && !pipeline.steps.slice(0, index).some((s) => s.id === step.on_fail?.goto)) {
        ctx.addIssue({ code: "custom", path: ["steps", index, "on_fail", "goto"], message: `on_fail.goto "${step.on_fail.goto}" must be an earlier step` });
      }
      if (step.id === "review_fix") ctx.addIssue({ code: "custom", path: ["steps", index, "id"], message: "review_fix belongs in review.fix" });
      seen.add(step.id);
    });
    if (pipeline.review) {
      if (pipeline.review.fix.id !== "review_fix") ctx.addIssue({ code: "custom", path: ["review", "fix", "id"], message: "review.fix.id must be review_fix" });
      for (const [i, id] of pipeline.review.then.entries()) {
        if (!seen.has(id)) ctx.addIssue({ code: "custom", path: ["review", "then", i], message: `review step "${id}" is not in the pipeline` });
      }
    }
  })
  .transform((pipeline) => {
    const withDefaults = <T extends { timeout_minutes?: number | undefined; max_attempts?: number | undefined }>(step: T) => ({
      ...step,
      timeout_minutes: step.timeout_minutes ?? pipeline.defaults.timeout_minutes,
      max_attempts: step.max_attempts ?? pipeline.defaults.max_attempts,
    });
    return {
      ...pipeline,
      steps: pipeline.steps.map(withDefaults),
      review: pipeline.review ? { ...pipeline.review, fix: withDefaults(pipeline.review.fix) } : undefined,
    };
  });

export type Pipeline = z.output<typeof pipelineSpec>;
export type PipelineStep = Pipeline["steps"][number];

export function parsePipeline(text: string): Pipeline {
  let raw: unknown;
  try {
    raw = parse(text);
  } catch (error) {
    throw new PipelineError(`pipeline.yaml is not valid YAML: ${error instanceof Error ? error.message : String(error)}`);
  }
  const result = pipelineSpec.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    throw new PipelineError(`Invalid pipeline.yaml: ${issues}`);
  }
  return result.data;
}

/** Reads the pipeline from the project's main checkout, never from a task worktree. */
export function loadPipeline(projectPath: string): Pipeline {
  const file = join(projectPath, ".factory", "pipeline.yaml");
  if (!existsSync(file)) throw new PipelineError(`Missing .factory/pipeline.yaml in ${projectPath}`);
  return parsePipeline(readFileSync(file, "utf8"));
}

export function modelFor(step: PipelineStep, size: TaskSize | undefined): string {
  if (typeof step.model === "string") return step.model;
  return (size && step.model[size]) ?? step.model.default;
}

export function stepById(pipeline: Pipeline, id: StepKind): PipelineStep {
  const step = id === "review_fix" ? pipeline.review?.fix : pipeline.steps.find((s) => s.id === id);
  if (!step) throw new PipelineError(`Step "${id}" is not in the pipeline`);
  return step;
}

export function parseTaskSize(value: string | undefined): TaskSize | undefined {
  return (TASK_SIZES as readonly string[]).includes(value ?? "") ? (value as TaskSize) : undefined;
}
