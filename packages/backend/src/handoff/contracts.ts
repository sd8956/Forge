import type { StepKind } from "@forge/shared";
import { z } from "zod";

/**
 * What each step kind reads, writes and must declare in its `output.md`
 * frontmatter beyond the common fields. The pipeline decides order and exit
 * criteria; the contract decides the shape of the handoff.
 */
export interface StepContract {
  goal: string;
  /** Project files to read, relative to the worktree root. Missing ones are skipped. */
  reads: string[];
  /** Files written in the step's output directory, besides `output.md`. */
  outputs: { file: string; description: string }[];
  /** Step-specific frontmatter fields, required when status is `done`. */
  extras: z.ZodObject;
  /** Example values for the extras, shown in input.md. */
  extrasExample: Record<string, unknown>;
}

const count = z.number().int().min(0);
const sha = z.string().regex(/^[0-9a-f]{7,40}$/);

export const STEP_CONTRACTS: Readonly<Record<StepKind, StepContract>> = {
  plan: {
    goal: "Write the implementation plan and the test plan for the task. Do not write application code.",
    reads: [".factory/requirements.md", ".factory/architecture.md", ".factory/test-strategy.md"],
    outputs: [
      { file: "plan.md", description: "Approach, files to create or change, order of work and risks." },
      { file: "test-plan.md", description: "Test cases `TC-xx`; each names its FR ids, the `AC-n` it covers, type, steps and expected result." },
    ],
    extras: z.object({ test_cases: z.number().int().min(1), covered_acs: z.array(z.string().regex(/^AC-\d+$/)).min(1) }),
    extrasExample: { test_cases: 4, covered_acs: ["AC-1", "AC-2"] },
  },
  design: {
    goal: "Write the technical design: API contracts, data schema and UI components, following the plan and the prototype. Do not write application code.",
    reads: [".factory/architecture.md", ".factory/adr", ".factory/design/tokens.json", ".factory/design/components.md", ".factory/prototype"],
    outputs: [{ file: "design.md", description: "API contracts, data schema and UI components the developer must follow." }],
    extras: z.object({}),
    extrasExample: {},
  },
  development: {
    goal: "Implement the task test-first, following the plan, the test plan and the design. Commit your work on the task branch. `make check` must be green.",
    reads: [".factory/architecture.md", "CLAUDE.md"],
    outputs: [{ file: "dev-notes.md", description: "What changed, decisions taken, how it was tested, and anything the next steps must know." }],
    // `tdd`: one entry per test written first: the cases it covers, the failing run, the commit that added the
    // failing test (before the fix) and the passing run.
    extras: z.object({
      commits: z.array(sha).min(1),
      tdd: z
        .array(z.object({ cases: z.array(z.string().regex(/^TC-\d+$/)).min(1), test: z.string().min(1), red: z.string().min(1), red_commit: sha, green: z.string().min(1) }))
        .min(1),
    }),
    extrasExample: {
      commits: ["1a2b3c4", "5d6e7f8"],
      tdd: [{ cases: ["TC-01"], test: "test/todo.test.js: rejects an empty title", red: "node --test: 1 failing, expected 400 got 201", red_commit: "1a2b3c4", green: "node --test: 12 passing" }],
    },
  },
  security: {
    goal: "Review the task's changes against the threat model: run Semgrep, gitleaks and osv-scanner, then confirm or discard each finding with a command you ran. Critical or high findings this task introduced mean `failed`; findings already on the base are listed and never block.",
    reads: [".factory/threat-model.md", ".factory/requirements.md"],
    outputs: [{ file: "security-report.md", description: "Every finding with tool, file, severity, origin (introduced or pre-existing), verdict, the command that proves it and reason." }],
    // `findings` counts confirmed findings this task introduced (they decide the outcome); `preexisting` counts
    // confirmed findings that were already on the base (listed for follow-up, never blocking).
    extras: z.object({
      findings: z.object({ critical: count, high: count, medium: count, low: count }),
      preexisting: z.object({ critical: count, high: count, medium: count, low: count }).optional(),
    }),
    extrasExample: { findings: { critical: 0, high: 0, medium: 0, low: 0 }, preexisting: { critical: 0, high: 0, medium: 0, low: 0 } },
  },
  e2e: {
    goal: "Run every `TC-xx` of the test plan end to end with Playwright and save evidence that names the state it proves. Then give a met or unmet verdict for every acceptance criterion and every FR the task covers, citing the cases that decide it. Specs live in `e2e/` and are committed.",
    reads: [".factory/test-strategy.md"],
    outputs: [
      { file: "test-report.md", description: "One row per TC: result, duration and evidence files." },
      { file: "evidence/manifest.json", description: "Links each TC to its FR ids, its result and its evidence files." },
    ],
    extras: z.object({ tests: z.object({ total: z.number().int().min(1), passed: count, failed: count }) }),
    extrasExample: { tests: { total: 4, passed: 4, failed: 0 } },
  },
  pr: {
    goal: "Push the task branch and open the pull request with the pr-report template. Do not merge.",
    reads: [],
    outputs: [{ file: "pr.md", description: "The exact PR body you submitted." }],
    extras: z.object({ pr_url: z.url().regex(/\/pull\/\d+$/), pr_number: z.number().int().min(1) }),
    extrasExample: { pr_url: "https://github.com/owner/repo/pull/1", pr_number: 1 },
  },
  review_fix: {
    goal: "Answer every pull request thread, failed check and conflict with the base branch listed below. Treat each claim as a hypothesis and check it against the code first: fix what holds (test-first, committed; a conflict is fixed by merging the base branch and committing the merge), dismiss with proof what does not, and escalate to a person what touches security, permissions or stored data. Reply on each thread. Do not push; the pr step pushes after security and e2e pass again.",
    reads: ["CLAUDE.md", ".factory/threat-model.md"],
    outputs: [{ file: "replies.md", description: "One section per thread: what was asked, what you did, the reply you posted." }],
    extras: z.object({
      threads: z
        .array(z.object({ id: z.string().min(1), action: z.enum(["fixed", "not_applicable", "answered", "escalated"]), reply: z.string().trim().min(1) }))
        .min(1),
      commits: z.array(sha).default([]),
    }),
    extrasExample: { threads: [{ id: "review_comment:123", action: "fixed", reply: "Renamed the handler and added a test." }], commits: ["1a2b3c4"] },
  },
};

export const SEVERITIES = ["low", "medium", "high", "critical"] as const;

const verdict = (id: RegExp) => z.object({ id: z.string().regex(id), verdict: z.enum(["met", "unmet"]), cases: z.array(z.string().regex(/^TC-\d+$/)).min(1) });

/** Evidence manifest written by the e2e step. */
export const evidenceManifest = z.object({
  task: z.string(),
  cases: z
    .array(
      z.object({
        id: z.string().regex(/^TC-\d+$/),
        frs: z.array(z.string()).default([]),
        result: z.enum(["passed", "failed", "skipped"]),
        /** The state the evidence shows, such as "the list shows Buy milk first". */
        proves: z.string().trim().min(1),
        /** Paths relative to the manifest's directory. */
        files: z.array(z.string().min(1)).default([]),
      }),
    )
    .min(1),
  /** A verdict for every acceptance criterion of the task, with the cases that decide it. */
  criteria: z.array(verdict(/^AC-\d+$/)).default([]),
  /** A verdict for every FR the task covers. */
  requirements: z.array(verdict(/^N?FR-\d+$/)).default([]),
});
export type EvidenceManifest = z.infer<typeof evidenceManifest>;

/** How the panel reads stored manifests: runs written before `proves` and the verdicts existed still show. */
export const storedEvidenceManifest = z.object({
  task: z.string(),
  cases: z.array(evidenceManifest.shape.cases.element.extend({ proves: z.string().optional() })),
});
