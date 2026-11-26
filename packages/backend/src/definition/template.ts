import { cpSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * What Forge copies into a new project: agents, skills, the pipeline and the
 * settings of every step. These are Forge's own files; the definition stages
 * never write them. `repo-conventions` is the template's one project-specific
 * skill, so it is replaced by a generic one that points to the architecture.
 */
export const TEMPLATE_PATHS = [".claude/agents", ".claude/skills", ".factory/pipeline.yaml", ".factory/steps", ".factory/orchestrator.settings.json", ".semgrep"];

const GENERIC_CONVENTIONS = `---
name: repo-conventions
description: Coding conventions of this project. Read .factory/architecture.md and its ADRs before changing code. Use in the development step and whenever code is changed.
---

# Repository conventions

The conventions of this project live in \`.factory/architecture.md\` and \`.factory/adr/\`: layout, stack, API
conventions, how to run the build, lint and tests (\`.factory/project.yaml\` \`commands\`), and how commits are
written. Follow them; when they say nothing, keep changes small and consistent with the surrounding code.
`;

const GITIGNORE = [".worktrees/", ".factory/runs/", "node_modules/", "test-results/", "playwright-report/"];

export function copyTemplate(templateDir: string, target: string, projectName: string): string[] {
  const copied: string[] = [];
  for (const path of TEMPLATE_PATHS) {
    const from = join(templateDir, path);
    if (!existsSync(from)) continue;
    cpSync(from, join(target, path), { recursive: true });
    copied.push(path);
  }
  writeFileSync(join(target, ".claude", "skills", "repo-conventions", "SKILL.md"), GENERIC_CONVENTIONS);
  renameMemoryProject(target, projectName);

  const gitignore = join(target, ".gitignore");
  const lines = existsSync(gitignore) ? readFileSync(gitignore, "utf8").split("\n").filter(Boolean) : [];
  writeFileSync(gitignore, `${[...new Set([...lines, ...GITIGNORE])].join("\n")}\n`);
  return [...copied, ".gitignore"];
}

/** Points the agents' Engram MCP server at this project's memory. */
export function renameMemoryProject(target: string, projectName: string): void {
  const dir = join(target, ".claude", "agents");
  if (!existsSync(dir)) return;
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".md"))) {
    const path = join(dir, file);
    const text = readFileSync(path, "utf8");
    const renamed = text.replace(/("--project",\s*)"[^"]*"/g, `$1${JSON.stringify(projectName)}`);
    if (renamed !== text) writeFileSync(path, renamed);
  }
}
