import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadPipeline, modelFor, parsePipeline, PipelineError } from "./pipeline.js";

const VALID = `
version: 1
defaults: { max_attempts: 3, timeout_minutes: 45 }
steps:
  - { id: plan, agent: forge-planner, model: opus, settings: steps/planner.settings.json,
      exit: { requires: [plan.md, test-plan.md], every_ac_has_tc: true } }
  - { id: development, agent: forge-developer, model: { default: sonnet, L: opus },
      settings: steps/developer.settings.json, exit: { requires: [dev-notes.md], command: make check } }
  - { id: security, agent: forge-security, model: opus, settings: steps/security.settings.json,
      exit: { requires: [security-report.md], max_severity: medium },
      on_fail: { goto: development, max_attempts: 2 } }
`;

describe("parsePipeline", () => {
  it("parses a valid pipeline and applies defaults", () => {
    const pipeline = parsePipeline(VALID);
    expect(pipeline.steps.map((s) => s.id)).toEqual(["plan", "development", "security"]);
    expect(pipeline.steps[0]).toMatchObject({ timeout_minutes: 45, max_attempts: 3 });
    expect(pipeline.steps[1]?.exit).toMatchObject({ command: "make check", every_ac_has_tc: false, all_cases_pass: false });
    expect(pipeline.steps[2]?.on_fail).toEqual({ goto: "development", max_attempts: 2 });
  });

  it("picks the model by task size, falling back to the default", () => {
    const [plan, dev] = parsePipeline(VALID).steps;
    expect(modelFor(plan!, "L")).toBe("opus");
    expect(modelFor(dev!, "L")).toBe("opus");
    expect(modelFor(dev!, "S")).toBe("sonnet");
    expect(modelFor(dev!, undefined)).toBe("sonnet");
  });

  const invalid: [string, string, string][] = [
    ["unknown step kind", VALID.replace("id: plan", "id: deploy"), "deploy"],
    ["duplicate ids", VALID.replace("id: development", "id: plan"), "Duplicate step id"],
    ["on_fail to a later step", VALID.replace("goto: development", "goto: security"), "earlier step"],
    ["on_fail to a missing step", VALID.replace("goto: development", "goto: design"), "earlier step"],
    ["unknown field", VALID.replace("model: opus, settings: steps/planner", "modle: opus, settings: steps/planner"), "modle"],
    ["absolute settings path", VALID.replace("steps/planner.settings.json", "/etc/passwd"), "relative"],
    ["path escaping the project", VALID.replace("steps/planner.settings.json", "../x.json"), "relative"],
    ["agent outside the forge namespace", VALID.replace("agent: forge-planner", "agent: planner"), "forge-"],
    ["wrong version", VALID.replace("version: 1", "version: 2"), "version"],
    ["not YAML", "steps: [", "YAML"],
  ];

  it.each(invalid)("rejects %s", (_name, text, message) => {
    expect(() => parsePipeline(text)).toThrow(PipelineError);
    expect(() => parsePipeline(text)).toThrow(message);
  });
});

describe("loadPipeline", () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("fails clearly when the project has no pipeline", () => {
    dir = mkdtempSync(join(tmpdir(), "forge-pipeline-"));
    expect(() => loadPipeline(dir)).toThrow("Missing .factory/pipeline.yaml");
  });

  it("reads .factory/pipeline.yaml from the project", () => {
    dir = mkdtempSync(join(tmpdir(), "forge-pipeline-"));
    mkdirSync(join(dir, ".factory"));
    writeFileSync(join(dir, ".factory", "pipeline.yaml"), VALID);
    expect(loadPipeline(dir).steps).toHaveLength(3);
  });
});
