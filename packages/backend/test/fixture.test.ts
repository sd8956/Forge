import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { agentPermissionMode } from "../src/steps/agent-file.js";
import { FIXTURE } from "./helpers.js";

interface Settings {
  permissions: { allow: string[] };
  hooks: Record<string, { matcher?: string; hooks: { type: string; url: string; headers: Record<string, string> }[] }[]>;
}

const settings = JSON.parse(readFileSync(join(FIXTURE, ".factory", "steps", "planner.settings.json"), "utf8")) as Settings;
const agent = readFileSync(join(FIXTURE, ".claude", "agents", "forge-planner.md"), "utf8");
const frontmatter = parse(/^---\n([\s\S]*?)\n---/.exec(agent)?.[1] ?? "") as { tools: string; skills: string[] };

describe("demo-project fixture contract", () => {
  it("lets the planner see and call the factory and Engram MCP tools without a prompt", () => {
    expect(frontmatter.tools.split(",").map((t) => t.trim())).toEqual(expect.arrayContaining(["mcp__factory", "mcp__engram"]));
    expect(settings.permissions.allow).toEqual(expect.arrayContaining(["mcp__factory", "mcp__engram"]));
  });

  it("sends Stop, Notification and SessionEnd to the backend over HTTP with the token", () => {
    expect(Object.keys(settings.hooks).sort()).toEqual(["Notification", "SessionEnd", "Stop"]);
    for (const groups of Object.values(settings.hooks)) {
      for (const hook of groups.flatMap((g) => g.hooks)) {
        expect(hook.type).toBe("http");
        expect(hook.url.startsWith("{{FORGE_URL}}/hooks/")).toBe(true);
        expect(hook.headers["x-forge-token"]).toBe("{{FORGE_TOKEN}}");
      }
    }
    expect(settings.hooks.Notification?.[0]?.matcher).toBe("permission_prompt|idle_prompt");
  });

  it("runs the planner with acceptEdits and the step protocol skill", () => {
    expect(agentPermissionMode(FIXTURE, "forge-planner")).toBe("acceptEdits");
    expect(frontmatter.skills).toContain("forge-step-protocol");
  });
});
