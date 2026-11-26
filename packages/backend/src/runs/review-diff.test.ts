import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { taskReviewDepth } from "./review-diff.js";

let repo: string;
const git = (...args: string[]) => execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], { encoding: "utf8" });
function commit(rel: string, content: string) {
  mkdirSync(join(repo, rel, ".."), { recursive: true });
  writeFileSync(join(repo, rel), content);
  git("add", rel);
  git("commit", "-qm", `add ${rel}`);
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "forge-review-diff-"));
  git("init", "-q", "-b", "main");
  commit("README.md", "# demo\n");
  git("checkout", "-q", "-b", "feat/TASK-001");
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

describe("taskReviewDepth", () => {
  it("reads the task branch diff against the merge base, ignoring later base commits", async () => {
    commit("docs/notes.md", "notes\n");
    git("checkout", "-q", "main");
    commit("src/login.js", "export const login = () => true;\n");
    git("checkout", "-q", "feat/TASK-001");
    expect(await taskReviewDepth(repo, "main")).toMatchObject({ tier: "passive", lenses: [] });
  });

  it("finds a dangerous sink on an added line, with its line number", async () => {
    commit("src/view.js", "const a = 1;\nel.innerHTML = title;\n");
    expect(await taskReviewDepth(repo, "main")).toMatchObject({ tier: "high", reasons: [expect.stringContaining("src/view.js:2: innerHTML assignment")] });
  });

  it("fails closed with every lens when the diff cannot be read", async () => {
    expect(await taskReviewDepth(repo, "no-such-branch")).toMatchObject({ tier: "high", lenses: ["risk", "resilience", "readability", "reliability"], reasons: [expect.stringContaining("could not read the diff")] });
  });
});
