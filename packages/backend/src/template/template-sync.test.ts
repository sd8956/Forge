import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applySync, planSync, templateHistory } from "./template-sync.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), "forge-template-"));
  dirs.push(d);
  return d;
};
const write = (root: string, rel: string, text: string) => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
};
const agent = (body: string, project = "demo-project") => `---\nname: forge-planner\nmcpServers:\n  - engram:\n      args: ["mcp", "--project", "${project}"]\n---\n${body}\n`;

/** A Forge repository whose template went through two versions. */
function forgeRepo() {
  const repo = temp();
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args]);
  git("init", "-q", "-b", "main");
  const tpl = join(repo, "fixtures", "demo-project");
  write(tpl, ".claude/agents/forge-planner.md", agent("Plan v1."));
  write(tpl, ".claude/skills/pr-thread-reply/SKILL.md", "reply v1\n");
  write(tpl, ".claude/skills/repo-conventions/SKILL.md", "demo conventions\n");
  write(tpl, ".factory/steps/planner.settings.json", '{"v": 1}\n');
  git("add", ".");
  git("commit", "-qm", "v1");
  write(tpl, ".claude/agents/forge-planner.md", agent("Plan v2."));
  write(tpl, ".claude/skills/pr-thread-reply/SKILL.md", "reply v2 with conflicts\n");
  write(tpl, ".claude/skills/maestro-evidence/SKILL.md", "maestro\n");
  write(tpl, ".factory/steps/planner.settings.json", '{"v": 2}\n');
  git("add", ".");
  git("commit", "-qm", "v2");
  return { repo, tpl };
}

describe("template sync plan", () => {
  it("updates untouched old copies, adds new files, keeps customized ones and never touches repo-conventions", async () => {
    const { tpl } = forgeRepo();
    const project = temp();
    // A project defined with v1: its agent carries its own Engram project name.
    write(project, ".claude/agents/forge-planner.md", agent("Plan v1.", "daily-tasks"));
    write(project, ".claude/skills/pr-thread-reply/SKILL.md", "reply v1\n");
    write(project, ".claude/skills/repo-conventions/SKILL.md", "our own conventions\n");
    // Someone changed this one in the project.
    write(project, ".factory/steps/planner.settings.json", '{"v": 1, "ours": true}\n');

    const plan = await planSync({ templateDir: tpl, projectRoot: project, projectName: "daily-tasks", history: (file) => templateHistory(tpl, file) });
    expect(plan).toEqual({
      update: [".claude/agents/forge-planner.md", ".claude/skills/pr-thread-reply/SKILL.md"],
      add: [".claude/skills/maestro-evidence/SKILL.md"],
      customized: [".factory/steps/planner.settings.json"],
    });

    applySync({ templateDir: tpl, projectRoot: project, projectName: "daily-tasks", plan });
    // The update keeps the project's own Engram project name.
    expect(readFileSync(join(project, ".claude/agents/forge-planner.md"), "utf8")).toBe(agent("Plan v2.", "daily-tasks"));
    expect(readFileSync(join(project, ".claude/skills/pr-thread-reply/SKILL.md"), "utf8")).toBe("reply v2 with conflicts\n");
    expect(readFileSync(join(project, ".claude/skills/maestro-evidence/SKILL.md"), "utf8")).toBe("maestro\n");
    expect(readFileSync(join(project, ".factory/steps/planner.settings.json"), "utf8")).toBe('{"v": 1, "ours": true}\n');
    expect(readFileSync(join(project, ".claude/skills/repo-conventions/SKILL.md"), "utf8")).toBe("our own conventions\n");

    const again = await planSync({ templateDir: tpl, projectRoot: project, projectName: "daily-tasks", history: (file) => templateHistory(tpl, file) });
    expect(again).toEqual({ update: [], add: [], customized: [".factory/steps/planner.settings.json"] });
  });

  it("treats only the current template as known when the template is not in a git repository", async () => {
    const tpl = temp();
    write(tpl, ".claude/skills/a/SKILL.md", "current\n");
    const project = temp();
    write(project, ".claude/skills/a/SKILL.md", "older\n");
    const plan = await planSync({ templateDir: tpl, projectRoot: project, projectName: "p", history: (file) => templateHistory(tpl, file) });
    expect(plan).toEqual({ update: [], add: [], customized: [".claude/skills/a/SKILL.md"] });
  });
});
