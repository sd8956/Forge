import { describe, expect, it } from "vitest";
import { validateStage, type FactoryFiles } from "./definition-validators.js";

const requirements = `# Requirements

### FR-001 Shorten a link

- Given a valid URL, when I press "Shorten", then I see a short link.
- Given an invalid URL, when I press "Shorten", then the page shows \`Enter a valid URL\`.

### FR-002 Open a short link

- Given a short link, when I open it, then I am redirected to the original URL.

## Non-functional requirements

- NFR-01 Performance: redirects answer in under 50 ms (p95).
- NFR-02 Accessibility: every control has a visible label.
`;
const projectYaml = "name: shortener\nplatforms: [web]\ncommands:\n  check: make check\n  e2e: make e2e\n  up: make up\n";
const threat = "# Threat model\n\n## Component: API\n\n| Threat | STRIDE | Mitigation |\n| --- | --- | --- |\n| Fake user | Spoofing | none needed |\n| Edit links | Tampering | validation |\n| Deny actions | Repudiation | logs |\n| Leak URLs | Information disclosure | no listing |\n| Flood | Denial of service | rate limit |\n| Admin | Elevation of privilege | no admin |\n";
const task = (id: string, covers: string, deps = "none", acs = "- AC-1 (FR-001) Given x, when y, then z.") => `# ${id} — Something\n\n- Covers: ${covers}\n- Size: S\n- Depends on: ${deps}\n\n## Acceptance criteria\n\n${acs}\n`;

const base: FactoryFiles = {
  ".factory/intake.md": "# Intake\n\nA link shortener for a small team.",
  ".factory/project.yaml": projectYaml,
  ".factory/requirements.md": requirements,
  ".factory/architecture.md": "# Architecture\n\nNode server.",
  ".factory/adr/0001-node.md": "# ADR 0001\n",
  ".factory/threat-model.md": threat,
  ".factory/test-strategy.md": "# Test strategy\n\nPlaywright for the web. Evidence: a screenshot per step.",
  ".factory/design/tokens.json": '{"color": {"brand": "#c2410c"}}',
  ".factory/design/components.md": "# Components\n",
  ".factory/prototype/index.html": "<!doctype html><title>x</title>",
  ".factory/backlog/TASK-001.md": task("TASK-001", "FR-001"),
  ".factory/backlog/TASK-002.md": task("TASK-002", "FR-002", "TASK-001", "- AC-1 (FR-002) Given a, when b, then c."),
};
const without = (files: FactoryFiles, ...paths: string[]) => Object.fromEntries(Object.entries(files).filter(([p]) => !paths.includes(p)));
const issues = (stage: Parameters<typeof validateStage>[0], files: FactoryFiles) => {
  const result = validateStage(stage, files);
  return result.ok ? [] : result.issues;
};

describe("validateStage", () => {
  it("accepts a complete definition with a summary per stage", () => {
    expect(validateStage("intake", base)).toEqual({ ok: true, summary: "shortener · web" });
    expect(validateStage("requirements", base)).toEqual({ ok: true, summary: "2 FR · 2 NFR" });
    expect(validateStage("architecture", base)).toEqual({ ok: true, summary: "1 ADR · STRIDE" });
    expect(validateStage("test_strategy", base)).toEqual({ ok: true, summary: "Test strategy ready" });
    expect(validateStage("design", base)).toEqual({ ok: true, summary: "1 screen" });
    expect(validateStage("backlog", base)).toEqual({ ok: true, summary: "2 tasks" });
  });

  it("checks the intake and project.yaml", () => {
    expect(issues("intake", without(base, ".factory/intake.md"))).toEqual([".factory/intake.md is missing"]);
    expect(issues("intake", { ...base, ".factory/project.yaml": "platforms: [web]\n" })).toEqual([".factory/project.yaml: name: Invalid input: expected string, received undefined"]);
  });

  it("needs requirement IDs with Given/When/Then criteria and measurable NFRs", () => {
    const bad = requirements.replace("- Given a short link, when I open it, then I am redirected to the original URL.", "- It redirects.").replace("in under 50 ms (p95)", "fast").replace("### FR-002", "### FR-001");
    expect(issues("requirements", { ...base, ".factory/requirements.md": bad })).toEqual([
      "FR-001 appears more than once",
      "FR-001 has a criterion that is not Given/When/Then: It redirects.",
      'NFR-01 is not measurable (add a number, such as a latency or a percentage, or a rule like "every ...")',
    ]);
    expect(issues("requirements", { ...base, ".factory/requirements.md": "# Requirements\n" })).toEqual(["requirements.md has no functional requirements (### FR-001 ...)", "requirements.md has no non-functional requirements (- NFR-01 ...)"]);
  });

  it("needs an ADR, every STRIDE category and the commands the pipeline runs", () => {
    expect(issues("architecture", { ...without(base, ".factory/adr/0001-node.md"), ".factory/threat-model.md": threat.replace("Repudiation", "Other"), ".factory/project.yaml": "name: x\n" })).toEqual([
      ".factory/adr/ has no ADR",
      "threat-model.md does not cover Repudiation",
      "project.yaml has no commands.check (the development step runs it)",
      "project.yaml has no commands.e2e (the e2e step runs it)",
    ]);
  });

  it("needs Maestro in the test strategy of a mobile project, and Playwright is not required there", () => {
    const mobile = { ...base, ".factory/project.yaml": "name: app\nplatforms: [android, ios]\n" };
    expect(issues("test_strategy", { ...mobile, ".factory/test-strategy.md": "# Test strategy\n\nPlaywright. Evidence: screenshots." })).toEqual([
      "test-strategy.md must use Maestro for the mobile platforms (android, ios), as the e2e step runs Maestro flows there",
    ]);
    expect(issues("test_strategy", { ...mobile, ".factory/test-strategy.md": "# Test strategy\n\nMaestro flows on an Android emulator. Evidence: a screenshot per step." })).toEqual([]);
    expect(issues("test_strategy", { ...base, ".factory/project.yaml": "name: app\nplatforms: [mobile]\n", ".factory/test-strategy.md": "Evidence only." })).toHaveLength(1);
  });

  it("needs a test strategy that names the evidence", () => {
    expect(issues("test_strategy", { ...base, ".factory/test-strategy.md": "# Test strategy\n\nPlaywright." })).toEqual(["test-strategy.md must say which evidence each case type needs"]);
  });

  it("needs valid tokens, a component inventory and at least one prototype screen", () => {
    expect(issues("design", { ...without(base, ".factory/prototype/index.html", ".factory/design/components.md"), ".factory/design/tokens.json": "{nope" })).toEqual([
      ".factory/design/tokens.json is not valid JSON",
      ".factory/design/components.md is missing",
      ".factory/prototype/ has no HTML screen",
    ]);
  });

  it("checks that backlog tasks cover existing requirements, have criteria and form a DAG", () => {
    const files = {
      ...base,
      ".factory/backlog/TASK-001.md": task("TASK-001", "FR-009", "TASK-002", "No criteria"),
      ".factory/backlog/TASK-002.md": task("TASK-002", "FR-001", "TASK-001").replace("- Size: S", "- Size: XL"),
      ".factory/backlog/TASK-003.md": task("TASK-003", "FR-001", "TASK-404"),
    };
    expect(issues("backlog", files)).toEqual([
      "TASK-001 covers FR-009, which is not in requirements.md",
      "TASK-001 has no acceptance criteria (- AC-1 (FR-001) ...)",
      "TASK-002 has no size (S, M or L)",
      "TASK-003 depends on TASK-404, which is not in the backlog",
      "Dependency cycle: TASK-001 → TASK-002 → TASK-001",
      "FR-002 is not covered by any task",
    ]);
    // A task may cover a non-functional requirement on its own.
    expect(issues("backlog", { ...base, ".factory/backlog/TASK-003.md": task("TASK-003", "NFR-01").replace("(FR-001)", "(NFR-01)") })).toEqual([]);
    expect(issues("backlog", { ...base, ".factory/backlog/TASK-003.md": task("TASK-003", "NFR-07") })).toEqual(["TASK-003 covers NFR-07, which is not in requirements.md"]);
    expect(issues("backlog", without(base, ".factory/backlog/TASK-001.md", ".factory/backlog/TASK-002.md"))).toEqual([".factory/backlog/ has no tasks (TASK-001.md ...)"]);
  });
});
