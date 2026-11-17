import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { FIXTURE, scratch } from "./helpers.js";

const hasSemgrep = spawnSync("semgrep", ["--version"]).status === 0;
const root = scratch("forge-semgrep-");
afterAll(() => rmSync(root, { recursive: true, force: true }));

function scan(files: Record<string, string>): string[] {
  const dir = join(root, String(Math.random()).slice(2));
  mkdirSync(dir);
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  const out = execFileSync("semgrep", ["scan", "--config", join(FIXTURE, ".semgrep", "forge.yml"), "--metrics", "off", "--json", "--quiet", dir], { encoding: "utf8" });
  return (JSON.parse(out) as { results: { path: string; start: { line: number } }[] }).results.map((r) => `${r.path.split("/").at(-1)}:${r.start.line}`);
}

// The F1 forced-failure seed, which semgrep's p/default pack missed (docs/runs/f1.md).
describe.skipIf(!hasSemgrep)("demo-project semgrep rule node-http-reflected-html", () => {
  it("flags query and header data reflected into an HTML response", () => {
    expect(
      scan({
        "echo.js": 'export const h = (req, res) => {\n  const url = new URL(req.url, "http://x");\n  res.end(`<p>${url.searchParams.get("msg")}</p>`);\n};\n',
        "headers.js": 'export const h = (req, res) => {\n  res.end(`<p>${req.headers["user-agent"]}</p>`);\n};\n',
      }),
    ).toEqual(["echo.js:3", "headers.js:2"]);
  });

  it("does not flag JSON responses or allowlisted static files", () => {
    expect(
      scan({
        "ok.js": [
          'import { readFile } from "node:fs/promises";',
          "export const h = async (req, res) => {",
          '  const url = new URL(req.url, "http://x");',
          '  res.end(JSON.stringify({ q: url.searchParams.get("q") }));',
          '  res.end(await readFile(FILES[url.pathname]));',
          "};",
        ].join("\n"),
      }),
    ).toEqual([]);
  });
});
