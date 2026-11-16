// Minimal lint rules without dependencies: no debugger, no console.log in src/, no tabs, no trailing spaces.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const roots = ["src", "public", "test", "e2e"];
const problems = [];
const walk = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(join(dir, d.name)) : /\.(m?js|html|css)$/.test(d.name) ? [join(dir, d.name)] : []));

for (const file of roots.flatMap((r) => { try { return walk(r); } catch { return []; } })) {
  readFileSync(file, "utf8").split("\n").forEach((line, i) => {
    const at = `${file}:${i + 1}`;
    if (/\bdebugger\b/.test(line)) problems.push(`${at} debugger statement`);
    if (file.startsWith("src") && /console\.log\(/.test(line)) problems.push(`${at} console.log in src/`);
    if (/\t/.test(line)) problems.push(`${at} tab character`);
    if (/[ \t]+$/.test(line)) problems.push(`${at} trailing whitespace`);
  });
}
if (problems.length) {
  console.error(problems.join("\n"));
  process.exit(1);
}
