import { readdirSync, readFileSync } from "node:fs";
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
    expect(pipeline.review).toMatchObject({ max_rounds: 3, fix: { id: "review_fix", agent: "forge-review-fixer" }, then: ["security", "e2e", "code_review", "pr"] });
  });

  it("reviews the code after e2e and before the PR, with read-only lens subagents and one refuter", () => {
    expect(pipeline.steps.map((s) => s.id)).toEqual(["plan", "design", "development", "security", "e2e", "code_review", "pr"]);
    const review = steps.find((s) => s.step.id === "code_review");
    expect(review?.step).toMatchObject({ agent: "forge-code-reviewer", exit: { requires: ["code-review.md"], review_clean: true }, on_fail: { goto: "development" } });
    expect(review?.frontmatter.tools.split(",").map((t) => t.trim())).toEqual(expect.arrayContaining(["Agent", "Write"]));
    expect(review?.frontmatter.tools).not.toContain("Edit");
    expect(review?.frontmatter.skills).toContain("code-review");
    expect(review?.settings.permissions.allow).toContain("Agent");
    expect(review?.settings.permissions.deny).toEqual(expect.arrayContaining(["Bash(git commit:*)", "Bash(git push:*)"]));
    for (const sub of ["risk", "resilience", "readability", "reliability", "refuter"]) {
      const text = readFileSync(join(FIXTURE, ".claude", "agents", `forge-review-${sub}.md`), "utf8");
      const frontmatter = parse(/^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? "") as { tools: string };
      expect(frontmatter.tools.split(",").map((t) => t.trim()), sub).toEqual(["Read", "Grep", "Glob", "Bash"]);
    }
    const skill = readFileSync(join(FIXTURE, ".claude", "skills", "code-review", "SKILL.md"), "utf8");
    expect(parse(/^---\n([\s\S]*?)\n---/.exec(skill)?.[1] ?? "")).toMatchObject({ name: "code-review" });
  });

  it("lets review_fix reply on threads and nothing else on the GitHub API", () => {
    const fixer = steps.find((s) => s.step.id === "review_fix");
    expect(fixer?.settings.permissions.allow).toEqual(
      expect.arrayContaining(["Bash(gh api -X POST repos/*/pulls/*/comments/*/replies -F body=@*)", "Bash(gh api -X POST repos/*/issues/*/comments -F body=@*)"]),
    );
    // A prefix rule ending in ":*" needs a space after it, so it never matched these calls (verified on 2.1.322).
    expect(fixer?.settings.permissions.allow.some((r) => r.startsWith("Bash(gh api -X POST repos/:"))).toBe(false);
  });

  it("lets review_fix merge the base branch to resolve a conflict, never rebase or force push", () => {
    const fixer = steps.find((s) => s.step.id === "review_fix");
    expect(fixer?.settings.permissions.allow).toEqual(expect.arrayContaining(["Bash(git fetch origin *)", "Bash(git merge origin/*)"]));
    expect(fixer?.settings.permissions.deny).toEqual(expect.arrayContaining(["Bash(git push --force:*)", "Bash(git push -f:*)"]));
    expect(readFileSync(join(FIXTURE, ".claude", "skills", "pr-thread-reply", "SKILL.md"), "utf8")).toContain("conflict:<head>@<base>");
  });

  it("lets the pr step look up an existing PR and development run the e2e suite without a prompt", () => {
    expect(steps.find((s) => s.step.id === "pr")?.settings.permissions.allow).toContain("Bash(gh pr list:*)");
    expect(steps.find((s) => s.step.id === "development")?.settings.permissions.allow).toContain("Bash(make e2e:*)");
  });

  it("has agent files whose frontmatter parses and names the file", () => {
    for (const file of readdirSync(join(FIXTURE, ".claude", "agents"))) {
      const text = readFileSync(join(FIXTURE, ".claude", "agents", file), "utf8");
      const frontmatter = parse(/^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? "") as { name: string; description: string };
      expect(frontmatter.name).toBe(file.replace(/\.md$/, ""));
      expect(typeof frontmatter.description).toBe("string");
    }
  });

  it("gives definition stages write tools and the factory server, no Bash, and no Stop hook so they can ask the person", () => {
    for (const stage of ["intake", "requirements", "architecture", "test-strategy", "design", "backlog"]) {
      const text = readFileSync(join(FIXTURE, ".claude", "agents", `forge-def-${stage}.md`), "utf8");
      const frontmatter = parse(/^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? "") as { tools: string; permissionMode: string };
      expect(frontmatter.tools.split(",").map((t) => t.trim())).toEqual(["Read", "Grep", "Glob", "Write", "Edit", "mcp__factory"]);
    }
    const settings = JSON.parse(readFileSync(join(FIXTURE, ".factory", "steps", "definition.settings.json"), "utf8")) as Settings;
    expect(settings.hooks.Stop).toBeUndefined();
    expect(settings.hooks.PreToolUse?.[0]?.matcher).toContain("Write");
    expect(settings.permissions.deny).toEqual(expect.arrayContaining(["Bash(git commit:*)", "Bash(git push:*)", "Bash(gh:*)"]));
  });

  it("lets the e2e step run Maestro flows with evidence for mobile projects", () => {
    const tester = readFileSync(join(FIXTURE, ".claude", "agents", "forge-tester.md"), "utf8");
    const frontmatter = parse(/^---\n([\s\S]*?)\n---/.exec(tester)?.[1] ?? "") as { skills: string[] };
    expect(frontmatter.skills).toEqual(expect.arrayContaining(["playwright-evidence", "maestro-evidence", "evidence-manifest"]));
    const skill = readFileSync(join(FIXTURE, ".claude", "skills", "maestro-evidence", "SKILL.md"), "utf8");
    expect(parse(/^---\n([\s\S]*?)\n---/.exec(skill)?.[1] ?? "")).toMatchObject({ name: "maestro-evidence" });
    expect(skill).toContain("takeScreenshot");
    expect(skill).toContain("evidence/manifest.json");
  });

  it("gives the orchestrator read-only tools and the factory MCP server, never Bash or writes", () => {
    const agent = readFileSync(join(FIXTURE, ".claude", "agents", "forge-orchestrator.md"), "utf8");
    const frontmatter = parse(/^---\n([\s\S]*?)\n---/.exec(agent)?.[1] ?? "") as { tools: string };
    expect(frontmatter.tools.split(",").map((t) => t.trim())).toEqual(["Read", "Grep", "Glob", "mcp__factory"]);
    const settings = JSON.parse(readFileSync(join(FIXTURE, ".factory", "orchestrator.settings.json"), "utf8")) as Settings;
    expect(settings.permissions.allow).toEqual(["mcp__factory"]);
    expect(settings.permissions.deny).toEqual(expect.arrayContaining(["Bash", "Write", "Edit", "MultiEdit", "NotebookEdit", "WebFetch", "Agent", "Read(/{{FORGE_HOME}}/**)"]));
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
