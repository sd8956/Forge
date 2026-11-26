import { describe, expect, it } from "vitest";
import { parseUnifiedDiff, reviewDepth, type DiffSummary } from "./review-depth.js";

const ALL = ["risk", "resilience", "readability", "reliability"];

const diff = (files: string[], added: { path: string; line: number; text: string }[] = []): DiffSummary => ({ files, added });

describe("reviewDepth", () => {
  it("assigns no lens when every changed path is documentation, an image or a Forge handoff", () => {
    const depth = reviewDepth(diff(["README.md", "docs/guide/setup.html", "notes.txt", "public/logo.png", ".factory/runs/TASK-001/plan/1/plan.md"]));
    expect(depth).toMatchObject({ tier: "passive", lenses: [] });
    expect(depth.reasons).toEqual([expect.stringContaining("only documentation")]);
  });

  it("assigns no lens when nothing changed", () => {
    expect(reviewDepth(diff([]))).toMatchObject({ tier: "passive", lenses: [] });
  });

  it("assigns the reliability lens to an ordinary code change", () => {
    const depth = reviewDepth(diff(["src/todos.js", "README.md"], [{ path: "src/todos.js", line: 3, text: "const items = [];" }]));
    expect(depth).toMatchObject({ tier: "medium", lenses: ["reliability"] });
    expect(depth.reasons.join("\n")).toContain("src/todos.js");
  });

  it.each([
    "src/auth/middleware.js",
    "src/login.js",
    "src/sessionStore.ts",
    "src/api/tokens.js",
    "src/password-reset.js",
    "config/secrets.js",
    "src/permissions.ts",
    "src/roles/admin.js",
    "src/payments/charge.js",
    "src/webhooks.js",
    "src/crypto.js",
    "db/migrations/0002_add_owner.sql",
    "src/upload.js",
  ])("assigns all four lenses when a code path is sensitive: %s", (path) => {
    const depth = reviewDepth(diff([path]));
    expect(depth).toMatchObject({ tier: "high", lenses: ALL });
    expect(depth.reasons).toEqual([expect.stringContaining(path)]);
  });

  it("does not treat words that only contain a sensitive token as sensitive", () => {
    expect(reviewDepth(diff(["src/authors.js", "src/controller.js"])).tier).toBe("medium");
  });

  it("ignores sensitive names in test files", () => {
    expect(reviewDepth(diff(["test/auth.test.js", "src/__tests__/login.spec.ts", "e2e/session.spec.js"])).tier).toBe("medium");
  });

  it.each([
    ["eval", "const value = eval(input);"],
    ["new Function", "const fn = new Function('a', body);"],
    ["child_process", "import { exec } from 'node:child_process';"],
    ["exec with interpolation", "exec(`git log ${branch}`);"],
    ["execSync with concatenation", "execSync('rm ' + file);"],
    ["innerHTML assignment", "el.innerHTML = title;"],
    ["dangerouslySetInnerHTML", "<div dangerouslySetInnerHTML={{ __html: body }} />"],
    ["document.write", "document.write(name);"],
    ["SQL in a template literal", "db.query(`SELECT * FROM todos WHERE id = ${id}`);"],
    ["SQL by concatenation", "db.query(\"DELETE FROM todos WHERE id = \" + id);"],
  ])("assigns all four lenses when an added line hits a dangerous sink: %s", (_name, text) => {
    const depth = reviewDepth(diff(["src/view.js"], [{ path: "src/view.js", line: 12, text }]));
    expect(depth).toMatchObject({ tier: "high", lenses: ALL });
    expect(depth.reasons).toEqual([expect.stringContaining("src/view.js:12")]);
  });

  it("does not flag safe lookalikes of dangerous sinks", () => {
    const added = ["const evaluation = evaluate(x);", "el.textContent = title;", "items.delete(id);", "db.query('SELECT * FROM todos WHERE id = ?', [id]);", "execFile('git', ['log']);"];
    const depth = reviewDepth(diff(["src/view.js"], added.map((text, i) => ({ path: "src/view.js", line: i + 1, text }))));
    expect(depth.tier).toBe("medium");
  });

  it("ignores dangerous sinks in tests and documentation", () => {
    const depth = reviewDepth(diff(["test/view.test.js", "docs/xss.md"], [
      { path: "test/view.test.js", line: 4, text: "el.innerHTML = '<b>x</b>';" },
      { path: "docs/xss.md", line: 9, text: "Never write `el.innerHTML = input`." },
    ]));
    expect(depth.tier).toBe("medium");
  });

  it("does not look at the size of the change", () => {
    const files = Array.from({ length: 200 }, (_, i) => `src/module-${i}.js`);
    const added = files.flatMap((path) => Array.from({ length: 50 }, (_, line) => ({ path, line, text: "const x = 1;" })));
    expect(reviewDepth(diff(files, added)).tier).toBe("medium");
  });
});

describe("parseUnifiedDiff", () => {
  it("lists changed files, including deleted and renamed ones, and the added lines with their new line numbers", () => {
    const text = [
      "diff --git a/src/view.js b/src/view.js",
      "index 1111111..2222222 100644",
      "--- a/src/view.js",
      "+++ b/src/view.js",
      "@@ -10,0 +11,2 @@ function render() {",
      "+  const safe = escape(title);",
      "+  el.innerHTML = safe;",
      "@@ -20 +22 @@",
      "-  old();",
      "+  next();",
      "diff --git a/src/old.js b/src/old.js",
      "deleted file mode 100644",
      "--- a/src/old.js",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-gone",
      "diff --git a/src/a.js b/src/b.js",
      "similarity index 100%",
      "rename from src/a.js",
      "rename to src/b.js",
      "",
    ].join("\n");
    expect(parseUnifiedDiff(text)).toEqual({
      files: ["src/view.js", "src/old.js", "src/b.js"],
      added: [
        { path: "src/view.js", line: 11, text: "  const safe = escape(title);" },
        { path: "src/view.js", line: 12, text: "  el.innerHTML = safe;" },
        { path: "src/view.js", line: 22, text: "  next();" },
      ],
    });
  });
});
