import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { loadPipeline } from "../src/pipeline/pipeline.js";
import { agentPermissionMode } from "../src/steps/agent-file.js";
import { FIXTURE } from "./helpers.js";

interface Settings {
  permissions: { allow: string[]; deny: string[] };
  attribution?: { commit?: string; pr?: string };
  hooks: Record<string, { matcher?: string; hooks: { type: string; url: string; headers: Record<string, string> }[] }[]>;
}

const pipeline = loadPipeline(FIXTURE);
const steps = [...pipeline.steps, ...(pipeline.review ? [pipeline.review.fix] : [])].map((step) => {
  const settings = JSON.parse(readFileSync(join(FIXTURE, ".factory", step.settings), "utf8")) as Settings;
  const agent = readFileSync(join(FIXTURE, ".claude", "agents", `${step.agent}.md`), "utf8");
  const frontmatter = parse(/^---\n([\s\S]*?)\n---/.exec(agent)?.[1] ?? "") as { tools: string; skills: string[] };
  return { step, settings, frontmatter };
});

describe("demo-project fixture contract", () => {
  it("defines the review loop and who may trigger it", () => {
    expect(pipeline.review).toMatchObject({ max_rounds: 3, fix: { id: "review_fix", agent: "forge-review-fixer" }, then: ["security", "e2e", "pr"] });
  });

  it("lets the pr step update an existing PR without a prompt", () => {
    const pr = steps.find((s) => s.step.id === "pr");
    expect(pr?.settings.permissions.allow).toEqual(expect.arrayContaining(["Bash(gh pr create:*)", "Bash(gh pr edit:*)"]));
  });

  it.each(steps.map((s) => [s.step.id, s] as const))("%s: can never merge a PR", (_id, { settings }) => {
    expect(settings.permissions.deny).toEqual(expect.arrayContaining(["Bash(gh pr merge:*)", "Bash(gh api -X PUT:*)"]));
  });

  it.each(steps.map((s) => [s.step.id, s] as const))("%s: sees and calls the factory and Engram MCP tools without a prompt", (_id, { settings, frontmatter }) => {
    expect(frontmatter.tools.split(",").map((t) => t.trim())).toEqual(expect.arrayContaining(["mcp__factory", "mcp__engram"]));
    expect(settings.permissions.allow).toEqual(expect.arrayContaining(["mcp__factory", "mcp__engram"]));
  });

  it.each(steps.map((s) => [s.step.id, s] as const))("%s: sends every lifecycle hook to the backend over HTTP with the token", (_id, { settings }) => {
    expect(Object.keys(settings.hooks).sort()).toEqual(["Notification", "PostToolUse", "PreToolUse", "SessionEnd", "Stop", "UserPromptSubmit"]);
    for (const groups of Object.values(settings.hooks)) {
      for (const hook of groups.flatMap((g) => g.hooks)) {
        expect(hook.type).toBe("http");
        expect(hook.url.startsWith("{{FORGE_URL}}/hooks/")).toBe(true);
        expect(hook.headers["x-forge-token"]).toBe("{{FORGE_TOKEN}}");
      }
    }
    expect(settings.hooks.Notification?.[0]?.matcher).toBe("permission_prompt|idle_prompt");
    expect(settings.hooks.PreToolUse?.[0]?.matcher).toBe("Bash|Read|Write|Edit|MultiEdit|Glob|Grep");
    expect(settings.hooks.PostToolUse?.[0]?.matcher).toBeUndefined();
  });

  it.each(steps.map((s) => [s.step.id, s] as const))("%s: commits and PRs carry no AI attribution", (_id, { settings }) => {
    expect(settings.attribution).toEqual({ commit: "", pr: "" });
  });

  it.each(steps.map((s) => [s.step.id, s] as const))("%s: runs with acceptEdits and the step protocol skill", (_id, { step, frontmatter }) => {
    expect(agentPermissionMode(FIXTURE, step.agent)).toBe("acceptEdits");
    expect(frontmatter.skills).toContain("forge-step-protocol");
  });
});
