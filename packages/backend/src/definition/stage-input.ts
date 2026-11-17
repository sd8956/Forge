import type { DefinitionStage } from "@forge/shared";
import { stringify } from "yaml";

export interface StageContract {
  title: string;
  goal: string;
  /** Earlier documents to read, relative to the worktree root. */
  reads: string[];
  /** What the stage must leave in .factory/. */
  writes: { path: string; description: string }[];
}

export const STAGE_CONTRACTS: Readonly<Record<DefinitionStage, StageContract>> = {
  intake: {
    title: "Intake",
    goal: "Understand the idea and its constraints. Ask the person short questions in this session when something essential is missing (platforms, stack, limits); otherwise write it down.",
    reads: [],
    writes: [
      { path: ".factory/intake.md", description: "The idea in plain language, who uses it, platforms (web, mobile, CLI), preferred stack, constraints (budget, infrastructure) and what is out of scope." },
      { path: ".factory/project.yaml", description: "`name` (kebab-case) and `platforms` (list). Leave `commands` for the architecture stage." },
    ],
  },
  requirements: {
    title: "Requirements",
    goal: "Turn the intake into numbered requirements a test can check.",
    reads: [".factory/intake.md"],
    writes: [
      {
        path: ".factory/requirements.md",
        description:
          "`### FR-001 <title>` headings, each with bullet criteria written as Given/When/Then and the exact texts the user sees; then a `## Non-functional requirements` list of `- NFR-01 <area>: <measurable rule>` (a number such as a p95 latency, or a rule such as \"every control has a visible label\").",
      },
    ],
  },
  architecture: {
    title: "Architecture and security",
    goal: "Choose the structure and stack, record the decisions and model the threats.",
    reads: [".factory/intake.md", ".factory/requirements.md"],
    writes: [
      { path: ".factory/architecture.md", description: "Bounded contexts or modules with their folders, stack, API conventions, error format and how to run the app locally." },
      { path: ".factory/adr/0001-<decision>.md", description: "One ADR per decision (context, decision, consequences); at least one." },
      { path: ".factory/threat-model.md", description: "STRIDE per component: Spoofing, Tampering, Repudiation, Information disclosure, Denial of service and Elevation of privilege, each with its mitigation." },
      { path: ".factory/project.yaml", description: "Add `commands`: build, lint, unit, check (build + lint + unit), up and e2e, as the pipeline runs them (for example `make check`)." },
    ],
  },
  test_strategy: {
    title: "Test strategy",
    goal: "Decide how every acceptance criterion will be proven.",
    reads: [".factory/requirements.md", ".factory/architecture.md"],
    writes: [
      {
        path: ".factory/test-strategy.md",
        description: "Tool per platform (Playwright for web, HTTP tests for APIs), environments, seed data, how to start the app (`make up`), and which evidence each case type must leave (screenshots, request/response, reports).",
      },
    ],
  },
  design: {
    title: "UI design",
    goal: "Design the interface as tokens, a component inventory and a clickable prototype with fake data.",
    reads: [".factory/requirements.md", ".factory/architecture.md"],
    writes: [
      { path: ".factory/design/tokens.json", description: "Design tokens as a JSON object (color, typography, spacing, radius)." },
      { path: ".factory/design/components.md", description: "Component inventory: name, states, which screens use it." },
      { path: ".factory/prototype/<screen>.html", description: "One self-contained HTML file per screen (inline CSS and JS, fake data, no external requests) that lays out well from 360 px to 1440 px wide. The person approves them one by one." },
    ],
  },
  backlog: {
    title: "Backlog",
    goal: "Split the requirements into small tasks the pipeline can run, each one a pull request.",
    reads: [".factory/requirements.md", ".factory/architecture.md", ".factory/test-strategy.md", ".factory/design/components.md"],
    writes: [
      {
        path: ".factory/backlog/TASK-001.md",
        description:
          "One file per task: `# TASK-001 — <title>`, then `- Covers: FR-001, FR-002`, `- Size: S|M|L`, `- Depends on: none|TASK-00x`, `- Prototype screens: <files or none>`, a `## Scope` paragraph and `## Acceptance criteria` with `- AC-1 (FR-001) Given ..., when ..., then ...`. Every requirement must be covered; the first task sets up the project so `make check` and `make e2e` work.",
      },
    ],
  },
};

export interface StageInputContext {
  stage: DefinitionStage;
  stepKind: string;
  taskId: string;
  attempt: number;
  outputDir: string;
  idea: string;
  /** Approved stages, in order, with their summaries. */
  approved: { stage: DefinitionStage; summary: string | null }[];
  /** Set when the person asked for changes. */
  changes?: { feedback: string; previousOutput: string | null } | undefined;
}

/** The stage's `input.md`: everything the session needs to start. */
export function renderStageInput(ctx: StageInputContext): string {
  const contract = STAGE_CONTRACTS[ctx.stage];
  const frontmatter = stringify({ step: ctx.stepKind, task: ctx.taskId, attempt: ctx.attempt, status: "done", summary: "One or two sentences on what you wrote.", artifacts: contract.writes.map((w) => w.path) }).trim();
  return [
    `# Step input: ${ctx.stepKind} — ${ctx.taskId}`,
    "",
    `- Step: \`${ctx.stepKind}\``,
    `- Stage: ${contract.title}`,
    `- Attempt: ${ctx.attempt}`,
    `- Output directory: \`${ctx.outputDir}\``,
    "",
    "## Goal",
    "",
    contract.goal,
    "",
    "## The idea, in the person's words",
    "",
    "> " + ctx.idea.trim().split("\n").join("\n> "),
    "",
    "## Approved so far",
    "",
    ...(ctx.approved.length ? ctx.approved.map((a) => `- ${STAGE_CONTRACTS[a.stage].title}${a.summary ? ` (${a.summary})` : ""}`) : ["Nothing yet: this is the first stage."]),
    "",
    "## Read",
    "",
    ...(contract.reads.length ? contract.reads.map((r) => `- \`${r}\``) : ["- Nothing besides this file."]),
    "",
    "## Write (only inside `.factory/`)",
    "",
    ...contract.writes.map((w) => `- \`${w.path}\`: ${w.description}`),
    "",
    ...(ctx.changes
      ? [
          "## Changes the person asked for",
          "",
          "You already wrote this stage once and the person reviewed it. Change what they ask and keep the rest.",
          "",
          "> " + ctx.changes.feedback.trim().split("\n").join("\n> "),
          "",
          ...(ctx.changes.previousOutput ? [`Your previous report: \`${ctx.changes.previousOutput}\``, ""] : []),
        ]
      : []),
    "## When you are done",
    "",
    `1. Write \`${ctx.outputDir}/output.md\` with this frontmatter and a short summary below it:`,
    "",
    "```yaml",
    "---",
    frontmatter,
    "---",
    "```",
    "",
    "2. Call the `report_stage` tool of the `factory` MCP server once with the same status, summary and artifacts. Forge checks the files and shows them to the person, who approves or asks for changes. Do not commit: Forge commits approved stages.",
    "",
  ].join("\n");
}
