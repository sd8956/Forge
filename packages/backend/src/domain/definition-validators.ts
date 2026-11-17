import type { DefinitionStage } from "@forge/shared";
import { parse } from "yaml";
import { projectConfigSchema } from "../projects/project-config.js";

/** Files of a definition worktree, keyed by repo-relative path (`.factory/...`). */
export type FactoryFiles = Record<string, string>;

export type StageValidation = { ok: true; summary: string } | { ok: false; issues: string[] };

const STRIDE = ["Spoofing", "Tampering", "Repudiation", "Information disclosure", "Denial of service", "Elevation of privilege"];

const result = (issues: string[], summary: string): StageValidation => (issues.length ? { ok: false, issues } : { ok: true, summary });
const missing = (path: string) => `${path} is missing`;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

function yamlOf(files: FactoryFiles): Record<string, unknown> | null {
  try {
    const data = parse(files[".factory/project.yaml"] ?? "") as unknown;
    return data && typeof data === "object" ? (data as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Bullet items of a markdown section; indented lines continue the previous bullet. */
function bullets(section: string): string[] {
  const items: string[] = [];
  for (const line of section.split("\n")) {
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    if (bullet) items.push(bullet[1]!.trim());
    else if (/^\s{2,}\S/.test(line) && items.length) items[items.length - 1] += ` ${line.trim()}`;
  }
  return items;
}

/** Functional requirement IDs (`### FR-001 ...` headings) of requirements.md. */
export function requirementIds(text: string): string[] {
  return [...text.matchAll(/^#{2,4}\s+(FR-\d{3,})\b/gm)].map((m) => m[1]!);
}

function intake(files: FactoryFiles): StageValidation {
  const issues: string[] = [];
  if (!files[".factory/intake.md"]?.trim()) issues.push(missing(".factory/intake.md"));
  if (files[".factory/project.yaml"] === undefined) return result([...issues, missing(".factory/project.yaml")], "");
  const parsed = projectConfigSchema.safeParse(yamlOf(files) ?? {});
  if (!parsed.success) issues.push(...parsed.error.issues.map((i) => `.factory/project.yaml: ${i.path.join(".")}: ${i.message}`));
  return result(issues, parsed.success ? `${parsed.data.name} · ${parsed.data.platforms.join(", ") || "no platform"}` : "");
}

function requirements(files: FactoryFiles): StageValidation {
  const text = files[".factory/requirements.md"];
  if (text === undefined) return result([missing(".factory/requirements.md")], "");
  const issues: string[] = [];
  const sections = text.split(/^(?=#{1,4}\s)/m);
  const seen = new Set<string>();
  let frs = 0;
  for (const section of sections) {
    const id = /^#{2,4}\s+(FR-\d{3,})\b/.exec(section)?.[1];
    if (!id) continue;
    frs++;
    if (seen.has(id)) issues.push(`${id} appears more than once`);
    seen.add(id);
    const criteria = bullets(section);
    if (criteria.length === 0) issues.push(`${id} has no acceptance criteria`);
    for (const c of criteria) {
      // "When" is optional for a state check ("Given no todos, then ...").
      if (!/\bgiven\b/i.test(c) || !/\bthen\b/i.test(c)) issues.push(`${id} has a criterion that is not Given/When/Then: ${c}`);
    }
  }
  const nfrs = [...text.matchAll(/^\s*[-*]\s*(NFR-\d{2,})\b(.*)$/gm)];
  for (const [, id, rest] of nfrs) {
    // Measurable: a number (latency, percentage) or a rule that holds everywhere ("every control has a label").
    if (!/\d/.test(rest ?? "") && !/\b(every|all|each|no|never|none|always|only)\b/i.test(rest ?? "")) {
      issues.push(`${id} is not measurable (add a number, such as a latency or a percentage, or a rule like "every ...")`);
    }
  }
  if (frs === 0) issues.push("requirements.md has no functional requirements (### FR-001 ...)");
  if (nfrs.length === 0) issues.push("requirements.md has no non-functional requirements (- NFR-01 ...)");
  return result(issues, `${frs} FR · ${nfrs.length} NFR`);
}

function architecture(files: FactoryFiles): StageValidation {
  const issues: string[] = [];
  if (!files[".factory/architecture.md"]?.trim()) issues.push(missing(".factory/architecture.md"));
  const adrs = Object.keys(files).filter((p) => /^\.factory\/adr\/[^/]+\.md$/.test(p)).length;
  if (adrs === 0) issues.push(".factory/adr/ has no ADR");
  const threat = files[".factory/threat-model.md"];
  if (threat === undefined) issues.push(missing(".factory/threat-model.md"));
  else for (const category of STRIDE) if (!threat.toLowerCase().includes(category.toLowerCase())) issues.push(`threat-model.md does not cover ${category}`);
  const commands = (yamlOf(files)?.commands ?? {}) as Record<string, unknown>;
  if (typeof commands.check !== "string") issues.push("project.yaml has no commands.check (the development step runs it)");
  if (typeof commands.e2e !== "string") issues.push("project.yaml has no commands.e2e (the e2e step runs it)");
  return result(issues, `${plural(adrs, "ADR")} · STRIDE`);
}

const MOBILE_PLATFORMS = new Set(["mobile", "android", "ios"]);

function testStrategy(files: FactoryFiles): StageValidation {
  const text = files[".factory/test-strategy.md"];
  if (!text?.trim()) return result([missing(".factory/test-strategy.md")], "");
  const issues = /evidence/i.test(text) ? [] : ["test-strategy.md must say which evidence each case type needs"];
  // The e2e step runs Maestro flows for mobile platforms (maestro-evidence skill), so the strategy must plan for it.
  const platforms = ((yamlOf(files)?.platforms as unknown[] | undefined) ?? []).map((p) => String(p).toLowerCase());
  const mobile = platforms.filter((p) => MOBILE_PLATFORMS.has(p));
  if (mobile.length && !/\bmaestro\b/i.test(text)) {
    issues.push(`test-strategy.md must use Maestro for the mobile platforms (${mobile.join(", ")}), as the e2e step runs Maestro flows there`);
  }
  return result(issues, "Test strategy ready");
}

/** Prototype screens: HTML files directly under .factory/prototype/. */
export function prototypeScreens(paths: string[]): string[] {
  return paths
    .filter((p) => /^\.factory\/prototype\/[^/]+\.html$/.test(p))
    .map((p) => p.slice(".factory/prototype/".length))
    .sort();
}

function design(files: FactoryFiles): StageValidation {
  const issues: string[] = [];
  const tokens = files[".factory/design/tokens.json"];
  if (tokens === undefined) issues.push(missing(".factory/design/tokens.json"));
  else {
    try {
      const parsed = JSON.parse(tokens) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) issues.push(".factory/design/tokens.json must be a JSON object");
    } catch {
      issues.push(".factory/design/tokens.json is not valid JSON");
    }
  }
  if (!files[".factory/design/components.md"]?.trim()) issues.push(missing(".factory/design/components.md"));
  const screens = prototypeScreens(Object.keys(files)).length;
  if (screens === 0) issues.push(".factory/prototype/ has no HTML screen");
  return result(issues, plural(screens, "screen"));
}

function backlog(files: FactoryFiles): StageValidation {
  const tasks = Object.keys(files)
    .map((p) => /^\.factory\/backlog\/(TASK-\d{3,})\.md$/.exec(p)?.[1])
    .filter((id): id is string => Boolean(id))
    .sort();
  if (tasks.length === 0) return result([".factory/backlog/ has no tasks (TASK-001.md ...)"], "");
  const requirementsText = files[".factory/requirements.md"] ?? "";
  const frs = new Set(requirementIds(requirementsText));
  const nfrs = new Set([...requirementsText.matchAll(/^\s*[-*]\s*(NFR-\d{2,})\b/gm)].map((m) => m[1]!));
  const issues: string[] = [];
  const deps = new Map<string, string[]>();
  const covered = new Set<string>();
  for (const id of tasks) {
    const text = files[`.factory/backlog/${id}.md`] ?? "";
    // A task covers functional requirements, or a non-functional one on its own (a health endpoint for NFR-01).
    const covers = /^\s*-\s*Covers:\s*(.+)$/im.exec(text)?.[1]?.match(/\bN?FR-\d{2,}\b/g) ?? [];
    if (covers.length === 0) issues.push(`${id} covers no requirement (- Covers: FR-001)`);
    for (const req of covers) {
      if (frs.has(req) || nfrs.has(req)) covered.add(req);
      else issues.push(`${id} covers ${req}, which is not in requirements.md`);
    }
    if (!/^\s*[-*]\s*AC-\d+/m.test(text)) issues.push(`${id} has no acceptance criteria (- AC-1 (FR-001) ...)`);
    if (!/^\s*-\s*Size:\s*[SML]\b/im.test(text)) issues.push(`${id} has no size (S, M or L)`);
    const line = /^\s*-\s*Depends on:\s*(.+)$/im.exec(text)?.[1] ?? "";
    const list = [...new Set(line.match(/\bTASK-\d{3,}\b/g) ?? [])];
    for (const dep of list) if (!tasks.includes(dep)) issues.push(`${id} depends on ${dep}, which is not in the backlog`);
    deps.set(id, list.filter((d) => tasks.includes(d)));
  }
  const cycle = findCycle(tasks, deps);
  if (cycle) issues.push(`Dependency cycle: ${cycle.join(" → ")}`);
  for (const fr of [...frs].sort()) if (!covered.has(fr)) issues.push(`${fr} is not covered by any task`);
  return result(issues, plural(tasks.length, "task"));
}

function findCycle(nodes: string[], edges: Map<string, string[]>): string[] | null {
  const state = new Map<string, "visiting" | "done">();
  const path: string[] = [];
  const visit = (node: string): string[] | null => {
    if (state.get(node) === "done") return null;
    if (state.get(node) === "visiting") return [...path.slice(path.indexOf(node)), node];
    state.set(node, "visiting");
    path.push(node);
    for (const next of edges.get(node) ?? []) {
      const found = visit(next);
      if (found) return found;
    }
    path.pop();
    state.set(node, "done");
    return null;
  };
  for (const node of nodes) {
    const found = visit(node);
    if (found) return found;
  }
  return null;
}

const VALIDATORS: Record<DefinitionStage, (files: FactoryFiles) => StageValidation> = {
  intake,
  requirements,
  architecture,
  test_strategy: testStrategy,
  design,
  backlog,
};

/** Checks what a stage must leave in `.factory/` before a person reviews it. Pure. */
export function validateStage(stage: DefinitionStage, files: FactoryFiles): StageValidation {
  return VALIDATORS[stage](files);
}
