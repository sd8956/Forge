import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import type { StepRow } from "../db/schema.js";
import { storedEvidenceManifest } from "../handoff/contracts.js";
import { parseFrontmatter } from "../handoff/frontmatter.js";

export interface RunEvidence {
  testPlan: { id: string; title: string; covers: string[] }[];
  /** Evidence directory relative to the task's handoff folder, for /runs/:id/files. */
  evidenceDir: string | null;
  cases: { id: string; frs: string[]; result: string; files: string[] }[];
  tests: { total: number; passed: number; failed: number } | null;
  security: { findings: Record<string, number>; status: string; report: string | null } | null;
}

const latestDone = (steps: StepRow[], kind: string) => steps.filter((s) => s.kind === kind && (s.status === "done" || s.status === "failed")).at(-1);

function frontmatter(file: string): Record<string, unknown> {
  if (!existsSync(file)) return {};
  const parsed = parseFrontmatter(readFileSync(file, "utf8"));
  return parsed.ok && parsed.data && typeof parsed.data === "object" ? (parsed.data as Record<string, unknown>) : {};
}

/** What the panel's "Test plan and evidence" tab and security card show for a run. */
export function runEvidence(steps: StepRow[], handoffRoot: (step: StepRow) => string): RunEvidence {
  const plan = latestDone(steps, "plan");
  const e2e = latestDone(steps, "e2e");
  const security = latestDone(steps, "security");

  const testPlan: RunEvidence["testPlan"] = [];
  const planFile = plan ? join(dirname(plan.outputPath), "test-plan.md") : null;
  if (planFile && existsSync(planFile)) {
    // Each case is a heading "TC-xx — title" followed by its details, up to the next heading.
    const sections = readFileSync(planFile, "utf8").split(/^(?=#{2,4}\s)/m);
    for (const section of sections) {
      const heading = /^#{2,4}\s*(TC-\d+)\s*[—:-]?\s*(.*)$/m.exec(section);
      if (!heading?.[1] || testPlan.some((t) => t.id === heading[1])) continue;
      testPlan.push({ id: heading[1], title: (heading[2] ?? "").trim(), covers: [...new Set(section.match(/\b(N?FR-\d+|AC-\d+)\b/g) ?? [])] });
    }
  }

  let cases: RunEvidence["cases"] = [];
  let evidenceDir: string | null = null;
  if (e2e) {
    const dir = join(dirname(e2e.outputPath), "evidence");
    const file = join(dir, "manifest.json");
    if (existsSync(file)) {
      try {
        cases = storedEvidenceManifest.parse(JSON.parse(readFileSync(file, "utf8"))).cases;
        evidenceDir = relative(handoffRoot(e2e), dir);
      } catch {
        cases = [];
      }
    }
  }
  const tests = (e2e ? frontmatter(e2e.outputPath).tests : undefined) as RunEvidence["tests"] | undefined;
  const sec = security ? frontmatter(security.outputPath) : null;
  const report = security ? join(dirname(security.outputPath), "security-report.md") : null;
  return {
    testPlan,
    evidenceDir,
    cases,
    tests: tests ?? null,
    security:
      security && sec
        ? {
            status: security.status,
            findings: (sec.findings as Record<string, number> | undefined) ?? {},
            report: report && existsSync(report) ? relative(handoffRoot(security), report) : null,
          }
        : null,
  };
}
