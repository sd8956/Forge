import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { REPORT_STATUSES, type ReportStepInput, type StepKind } from "@forge/shared";
import { z } from "zod";
import type { PipelineStep } from "../pipeline/pipeline.js";
import { evidenceManifest, SEVERITIES, STEP_CONTRACTS } from "./contracts.js";
import { parseFrontmatter } from "./frontmatter.js";

export const commonFrontmatter = z.object({
  step: z.string(),
  task: z.string(),
  attempt: z.number().int().min(1),
  status: z.enum(REPORT_STATUSES),
  summary: z.string().trim().min(1),
  artifacts: z.array(z.string().min(1)),
});

export interface CommandResult {
  ok: boolean;
  output: string;
}

export interface ReportContext {
  kind: StepKind;
  taskId: string;
  attempt: number;
  worktreePath: string;
  /** Absolute path of the step's output directory. */
  outputDir: string;
  exit: PipelineStep["exit"];
  reported: ReportStepInput;
  /** Absolute path of the backlog task file. */
  taskSpecPath: string;
  /** Absolute path of the test plan written by the latest successful plan step. */
  testPlanPath?: string | undefined;
  runCommand: (command: string, cwd: string) => Promise<CommandResult>;
}

export type ReportValidation = { ok: true; frontmatter: Record<string, unknown> } | { ok: false; issues: string[] };

const ids = (text: string, pattern: RegExp) => [...new Set(text.match(pattern) ?? [])];

function insideWorktree(worktree: string, path: string): string | null {
  const absolute = resolve(worktree, path);
  const rel = relative(worktree, absolute);
  return !isAbsolute(path) && !rel.startsWith("..") ? absolute : null;
}

function zodIssues(prefix: string, error: z.ZodError): string[] {
  return error.issues.map((i) => `${prefix}${i.path.join(".") || "(root)"}: ${i.message}`);
}

/**
 * Checks a step's report before accepting it: the `output.md` schema, that it
 * agrees with the report, that the artifacts exist and, for `done`, the step's
 * exit criteria. Returns every problem so the agent can fix them in one go.
 */
export async function validateReport(ctx: ReportContext): Promise<ReportValidation> {
  const issues: string[] = [];
  const outputFile = join(ctx.outputDir, "output.md");
  if (!existsSync(outputFile)) return { ok: false, issues: [`Missing ${relative(ctx.worktreePath, outputFile)}`] };

  const parsed = parseFrontmatter(readFileSync(outputFile, "utf8"));
  if (!parsed.ok) return { ok: false, issues: [parsed.error] };

  const common = commonFrontmatter.safeParse(parsed.data);
  if (!common.success) return { ok: false, issues: zodIssues("output.md frontmatter ", common.error) };
  const fm = common.data;
  const done = ctx.reported.status === "done";

  const expected = { step: ctx.kind, task: ctx.taskId, attempt: ctx.attempt, status: ctx.reported.status };
  for (const [key, value] of Object.entries(expected)) {
    if (fm[key as keyof typeof fm] !== value) issues.push(`output.md frontmatter ${key} is ${JSON.stringify(fm[key as keyof typeof fm])}, expected ${JSON.stringify(value)}`);
  }

  const contract = STEP_CONTRACTS[ctx.kind];
  const extrasSchema = done || ctx.kind === "security" ? contract.extras : contract.extras.partial();
  const extras = extrasSchema.safeParse(parsed.data);
  if (!extras.success) issues.push(...zodIssues("output.md frontmatter ", extras.error));

  for (const artifact of new Set([...fm.artifacts, ...ctx.reported.artifacts])) {
    const absolute = insideWorktree(ctx.worktreePath, artifact);
    if (!absolute) issues.push(`Artifact ${artifact} must be a path relative to the worktree root`);
    else if (!existsSync(absolute)) issues.push(`Artifact ${artifact} does not exist`);
  }

  if (done) issues.push(...checkExitCriteria(ctx, extras.success ? (extras.data) : {}));
  if (issues.length > 0) return { ok: false, issues };

  if (done && ctx.exit.command) {
    const result = await ctx.runCommand(ctx.exit.command, ctx.worktreePath);
    if (!result.ok) return { ok: false, issues: [`\`${ctx.exit.command}\` failed; fix it before reporting done:\n${result.output}`] };
  }
  return { ok: true, frontmatter: parsed.data as Record<string, unknown> };
}

function checkExitCriteria(ctx: ReportContext, extras: Record<string, unknown>): string[] {
  const issues: string[] = [];
  const rel = (p: string) => relative(ctx.worktreePath, p);

  for (const file of ctx.exit.requires) {
    if (!existsSync(join(ctx.outputDir, file))) issues.push(`Missing required file ${rel(join(ctx.outputDir, file))}`);
  }

  if (ctx.exit.every_ac_has_tc) {
    const testPlan = join(ctx.outputDir, "test-plan.md");
    if (existsSync(testPlan) && existsSync(ctx.taskSpecPath)) {
      const plan = readFileSync(testPlan, "utf8");
      if (ids(plan, /\bTC-\d+\b/g).length === 0) issues.push("test-plan.md has no TC-xx cases");
      const missing = ids(readFileSync(ctx.taskSpecPath, "utf8"), /\bAC-\d+\b/g).filter((ac) => !new RegExp(`\\b${ac}\\b`).test(plan));
      if (missing.length) issues.push(`test-plan.md does not cover ${missing.join(", ")}`);
    }
  }

  if (ctx.exit.max_severity) {
    const findings = (extras.findings ?? {}) as Partial<Record<(typeof SEVERITIES)[number], number>>;
    const allowed = ctx.exit.max_severity === "none" ? -1 : SEVERITIES.indexOf(ctx.exit.max_severity);
    const blocking = SEVERITIES.filter((s, i) => i > allowed && (findings[s] ?? 0) > 0);
    if (blocking.length) issues.push(`Cannot report done with ${blocking.join(" and ")} findings; report failed instead`);
  }

  if (ctx.exit.all_cases_pass) issues.push(...checkEvidence(ctx, extras));
  return issues;
}

function checkEvidence(ctx: ReportContext, extras: Record<string, unknown>): string[] {
  const file = join(ctx.outputDir, "evidence", "manifest.json");
  if (!existsSync(file)) return [];
  let manifest;
  try {
    const parsed = evidenceManifest.safeParse(JSON.parse(readFileSync(file, "utf8")));
    if (!parsed.success) return zodIssues("evidence/manifest.json ", parsed.error);
    manifest = parsed.data;
  } catch {
    return ["evidence/manifest.json is not valid JSON"];
  }
  const issues: string[] = [];
  const planned = ctx.testPlanPath && existsSync(ctx.testPlanPath) ? ids(readFileSync(ctx.testPlanPath, "utf8"), /\bTC-\d+\b/g) : [];
  const byId = new Map(manifest.cases.map((c) => [c.id, c]));
  const missing = planned.filter((tc) => !byId.has(tc));
  if (missing.length) issues.push(`evidence/manifest.json has no result for ${missing.join(", ")}`);
  for (const c of manifest.cases) {
    if (c.result !== "passed") issues.push(`${c.id} is ${c.result}; report failed when a case does not pass`);
    if (c.files.length === 0) issues.push(`${c.id} has no evidence files`);
    for (const f of c.files) {
      if (!existsSync(resolve(dirname(file), f))) issues.push(`${c.id} evidence file ${f} does not exist`);
    }
  }
  const tests = extras.tests as { total?: number; failed?: number } | undefined;
  if (tests && tests.total !== manifest.cases.length) issues.push(`frontmatter tests.total is ${tests.total}, manifest has ${manifest.cases.length} cases`);
  return issues;
}
