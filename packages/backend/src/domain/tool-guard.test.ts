import { describe, expect, it } from "vitest";
import { guardTool } from "./tool-guard.js";

const WT = "/home/sd/Documents/Forge/.sandbox/demo-project/.worktrees/TASK-001";
const bash = (command: string) => guardTool("Bash", { command }, WT);

// Commands the agents actually ran in the F1 real runs (docs/runs/f1.md).
describe("guardTool: Bash commands that stopped the F1 runs are denied with a corrective reason", () => {
  const denied: [string, string, string][] = [
    ["heredoc", "cat > test/todos.test.js <<'EOF'\nimport test from 'node:test';\nEOF", "Write"],
    ["heredoc", "cat >> e2e/todos.spec.js <<'EOF'\ntest('x', () => {});\nEOF", "Write"],
    ["inline_script", "python3 - <<'EOF'\np='public/index.html'\nEOF", "Write"],
    ["inline_script", `python3 -c "import json;print(1)"`, "Write"],
    ["inline_script", `node -e 'const r=require("./results.json")'`, "Write"],
    ["inline_script", `python3 -I -c "import json,sys;print(1)" .factory/runs/TASK-001/security/1/semgrep.json`, "Write"],
    ["variable", "D=.factory/runs/TASK-001/development/1\ngit add src", "literal"],
    ["variable", "OUT=.factory/runs/TASK-001/security/1; BASE=$(git merge-base HEAD main)", "literal"],
    ["expansion", "make e2e EVIDENCE_DIR=$(mktemp -d) 2>&1 | tail -30", "literal"],
    ["expansion", "echo `git rev-parse HEAD`", "literal"],
    ["expansion", 'semgrep scan --baseline-commit "$BASE" .', "literal"],
    ["cd", "cd .factory/runs/TASK-001; cat e2e/1/test-report.md", "cd"],
    ["cd", `cd ${WT} && python3 -c "print(1)"`, "cd"],
    ["redirect", "make check > .factory/runs/TASK-001/e2e/1/evidence/make-check.log 2>&1", "Write"],
    ["redirect", "echo hi >> notes.md", "Write"],
    ["in_place_edit", "sed -i 's/a/b/' src/server.js", "Write"],
    ["in_place_edit", "git diff | tee diff.txt", "Write"],
    ["unquoted_glob", "find .claude/skills .factory/backlog/TASK-003.md e2e src test package.json Makefile playwright.config.* -maxdepth 2", "Glob"],
    ["unquoted_glob", "find . -name *.js", "Glob"],
    ["unquoted_glob", "git add src/*.js", "quote"],
    ["unquoted_glob", "sort data/*.csv", "quote"],
    // F3 real run: a variable in front of the command, and a value outside the worktree.
    ["env_prefix", "EVIDENCE_DIR=.factory/runs/TASK-005/e2e/1/evidence npx playwright test e2e/escape.spec.js", "make e2e EVIDENCE_DIR="],
    ["env_prefix", "git status && CI=1 make unit", "argument"],
    ["outside_worktree", "make e2e EVIDENCE_DIR=/tmp/claude-1000/e2e-ev", "worktree"],
    ["outside_worktree", "node --test --test-reporter-destination=/tmp/out.txt", "worktree"],
    ["outside_worktree", "ls ~/.claude/skills .claude/skills 2>/dev/null", "worktree"],
    ["outside_worktree", "cat /etc/passwd", "worktree"],
  ];

  it.each(denied)("%s: %s", (rule, command, hint) => {
    const result = bash(command);
    expect(result.allow).toBe(false);
    if (result.allow) return;
    expect(result.rule).toBe(rule);
    expect(result.reason).toContain(hint);
  });
});

describe("guardTool: commands that ran without a prompt stay allowed", () => {
  const allowed = [
    "make check",
    "make check 2>&1 | tail -15",
    "make e2e EVIDENCE_DIR=.factory/runs/TASK-002/e2e/1/evidence",
    "npm install 2>&1 | tail -2",
    "git diff 5cc7b27ad7a62aa6b1cb365d53f169e855659745..HEAD -- src public",
    "gitleaks git --log-opts=5cc7b27ad7a62aa6b1cb365d53f169e855659745..HEAD --report-format json --report-path .factory/runs/TASK-002/security/1/gitleaks.json --redact .",
    `git grep -n -E "NFR|limit|length|characters" HEAD -- .factory/requirements.md`,
    "git log --stat -3 --format=%h%x20%s",
    `git commit -q -m "feat: show the todo count in the page heading"`,
    `grep -rn "debug/echo" --include=* . --exclude-dir=node_modules --exclude-dir=.git -l`,
    `find .factory/runs/TASK-002/e2e/1/evidence -name "*TC-01*" -o -path "*TC-01/*"`,
    "git push -u origin feat/TASK-002",
    `gh pr create --base main --head feat/TASK-002 --title "feat: count (TASK-002)" --body-file .factory/runs/TASK-002/pr/1/pr.md`,
    "ls .claude/skills .factory/backlog",
    "cat src/server.js public/app.js 2>/dev/null",
    `git commit -m "docs: explain a > b and $HOME in prose"`.replace("$HOME", "home"),
    `ls ${WT}/src`,
    "find . -name '*.js'",
    "make e2e EVIDENCE_DIR=.factory/runs/TASK-005/e2e/1/evidence",
    `make e2e EVIDENCE_DIR=${WT}/.factory/runs/TASK-005/e2e/1/evidence`,
    `find e2e -name "*.spec.js" -type f`,
    "ls src/*.js",
    "wc -l src/*.js",
  ];

  it.each(allowed)("%s", (command) => {
    expect(bash(command)).toEqual({ allow: true });
  });
});

describe("guardTool: file tools", () => {
  it("denies absolute paths outside the worktree", () => {
    expect(guardTool("Read", { file_path: "/home/sd/.claude/skills/x/SKILL.md" }, WT)).toMatchObject({ allow: false, rule: "outside_worktree" });
    expect(guardTool("Write", { file_path: "/tmp/gen.mjs" }, WT)).toMatchObject({ allow: false, rule: "outside_worktree" });
    expect(guardTool("Grep", { pattern: "x", path: "/etc" }, WT)).toMatchObject({ allow: false, rule: "outside_worktree" });
  });

  it("allows paths inside the worktree, relative or absolute", () => {
    expect(guardTool("Read", { file_path: `${WT}/src/server.js` }, WT)).toEqual({ allow: true });
    expect(guardTool("Edit", { file_path: "src/server.js" }, WT)).toEqual({ allow: true });
    expect(guardTool("Glob", { pattern: "**/*.js" }, WT)).toEqual({ allow: true });
  });

  it("does not let a sibling folder with the same prefix pass as inside", () => {
    expect(guardTool("Read", { file_path: `${WT}-evil/x` }, WT)).toMatchObject({ allow: false });
  });

  it("ignores other tools", () => {
    expect(guardTool("mcp__factory__report_step", { status: "done" }, WT)).toEqual({ allow: true });
  });
});
