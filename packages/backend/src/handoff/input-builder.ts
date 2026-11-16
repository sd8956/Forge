import type { StepKind } from "@forge/shared";
import { stringify } from "yaml";
import type { PipelineStep } from "../pipeline/pipeline.js";
import { STEP_CONTRACTS } from "./contracts.js";

export interface PreviousStep {
  kind: StepKind;
  /** output.md of the latest successful run of that step, relative to the worktree root. */
  output: string;
  summary: string;
  artifacts: string[];
}

export interface InputContext {
  runId: string;
  stepId: string;
  kind: StepKind;
  attempt: number;
  agent: string;
  taskId: string;
  /** Paths relative to the worktree root. */
  taskSpec: string;
  outputDir: string;
  reads: string[];
  branch: string;
  baseBranch: string;
  /** Merge base of the task branch and its base, resolved by the backend so agents never compute it. */
  baseCommit?: string | undefined;
  exit: PipelineStep["exit"];
  previous: PreviousStep[];
  /** Set when this step runs again because a later step failed (on_fail) or it failed itself. */
  failure?: { kind: StepKind; output: string; summary: string; artifacts: string[]; failures: number; limit: number } | undefined;
}

export function outputDirFor(taskId: string, kind: StepKind, attempt: number): string {
  return `.factory/runs/${taskId}/${kind}/${attempt}`;
}

function exitCriteria(exit: PipelineStep["exit"], outputDir: string): string[] {
  const lines = exit.requires.map((f) => `\`${outputDir}/${f}\` exists`);
  if (exit.every_ac_has_tc) lines.push("Every `AC-n` of the task appears in `test-plan.md`, which has `TC-xx` cases");
  if (exit.command) lines.push(`\`${exit.command}\` exits 0 in the worktree (the backend runs it when you report \`done\`)`);
  if (exit.max_severity) lines.push(`No confirmed finding above \`${exit.max_severity}\``);
  if (exit.all_cases_pass) lines.push("Every TC of the test plan is in `evidence/manifest.json`, passed, with evidence files");
  if (exit.pr_created) lines.push("A pull request exists and its URL is in `pr_url`");
  return lines;
}

/** Renders the step's `input.md`: the only document the agent needs to start. */
export function renderInput(ctx: InputContext): string {
  const contract = STEP_CONTRACTS[ctx.kind];
  const frontmatter = stringify({
    step: ctx.kind,
    task: ctx.taskId,
    attempt: ctx.attempt,
    status: "done",
    summary: "Two to five lines on what you produced, or why you could not.",
    artifacts: [`${ctx.outputDir}/output.md`, ...contract.outputs.map((o) => `${ctx.outputDir}/${o.file}`)],
    ...contract.extrasExample,
  }).trimEnd();

  const sections: string[] = [
    `# Step input: ${ctx.kind} — ${ctx.taskId} (attempt ${ctx.attempt})`,
    [
      `- Run: \`${ctx.runId}\``,
      `- Step: \`${ctx.kind}\` (id \`${ctx.stepId}\`)`,
      `- Attempt: ${ctx.attempt}`,
      `- Agent: \`${ctx.agent}\``,
      `- Task branch: \`${ctx.branch}\` (base \`${ctx.baseBranch}\`)`,
      ...(ctx.baseCommit ? [`- Base commit: \`${ctx.baseCommit}\` (use this literal value; do not compute it)`] : []),
      `- Output directory: \`${ctx.outputDir}\``,
      "- All paths are relative to the worktree root (your working directory).",
    ].join("\n"),
    `## Goal\n\n${contract.goal}`,
    `## Task\n\nRead \`${ctx.taskSpec}\` first: its acceptance criteria are the scope.`,
  ];

  if (ctx.failure) {
    sections.push(
      [
        `## Why this step runs again`,
        "",
        `The \`${ctx.failure.kind}\` step failed (failure ${ctx.failure.failures} of ${ctx.failure.limit} allowed). Fix what it reports:`,
        "",
        `> ${ctx.failure.summary.replaceAll("\n", "\n> ")}`,
        "",
        `- Its handoff: \`${ctx.failure.output}\``,
        ...ctx.failure.artifacts.map((a) => `- \`${a}\``),
      ].join("\n"),
    );
  }

  if (ctx.previous.length) {
    sections.push(
      [
        "## Earlier steps",
        "",
        ...ctx.previous.flatMap((p) => [`### ${p.kind}`, "", `> ${p.summary.replaceAll("\n", "\n> ")}`, "", `- \`${p.output}\``, ...p.artifacts.map((a) => `- \`${a}\``), ""]),
      ].join("\n").trimEnd(),
    );
  }

  if (ctx.reads.length) sections.push(["## Project documents", "", ...ctx.reads.map((r) => `- \`${r}\``)].join("\n"));

  sections.push(
    [
      "## Output contract",
      "",
      `Write these files in \`${ctx.outputDir}/\`:`,
      "",
      ...contract.outputs.map((o) => `- \`${o.file}\`: ${o.description}`),
      "- `output.md`: the handoff for the next step. It must start with this frontmatter (the backend validates it):",
      "",
      "```yaml",
      "---",
      frontmatter,
      "---",
      "```",
      "",
      "`status` must match what you report. `artifacts` lists every file you wrote, relative to the worktree root.",
    ].join("\n"),
  );

  const criteria = exitCriteria(ctx.exit, ctx.outputDir);
  if (criteria.length) sections.push(["## Exit criteria for `done`", "", ...criteria.map((c) => `- ${c}`)].join("\n"));

  sections.push(
    [
      "## Finish",
      "",
      "Follow the `forge-step-protocol` skill. The step only counts when you call `report_step` of the `factory`",
      "MCP server with the same `status`, `summary` and `artifacts` as `output.md`. If the backend rejects the report,",
      "fix every listed problem and call it again. Do not stop before a report is accepted.",
    ].join("\n"),
  );

  return `${sections.join("\n\n")}\n`;
}
