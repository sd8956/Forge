/**
 * How deep the code_review step reviews a task, decided from the task branch
 * diff and never by the agent. Pure: the run service reads the diff with git.
 * The size of the change is deliberately not an input: a one-line change to a
 * login check needs more review than a large rename.
 */
export const REVIEW_LENSES = ["risk", "resilience", "readability", "reliability"] as const;
export type ReviewLens = (typeof REVIEW_LENSES)[number];

export type ReviewTier = "passive" | "medium" | "high";

export interface AddedLine {
  path: string;
  /** Line number in the new version of the file. */
  line: number;
  text: string;
}

export interface DiffSummary {
  /** Changed paths, relative to the repository root (the new path of a rename). */
  files: string[];
  added: AddedLine[];
}

export interface ReviewDepth {
  tier: ReviewTier;
  lenses: ReviewLens[];
  /** The path or line signals that decided the tier. */
  reasons: string[];
}

const PASSIVE_EXTENSIONS = /\.(md|mdx|txt|png|jpe?g|gif|svg|webp|ico|avif)$/i;
const PASSIVE_DIRS = /^(docs|\.factory)\//;
const TEST_PATH = /(^|\/)(test|tests|__tests__|e2e|spec|fixtures)\/|\.(test|spec)\.[cm]?[jt]sx?$/i;

/** Words of a path that name sensitive code; matched against whole words so `authors` is not `auth`. */
const SENSITIVE_WORD = /^(o?auth[nz]?|authenticat\w*|authoriz\w*|login\w*|sessions?|tokens?|passwords?|secrets?|permissions?|roles?|payments?|webhooks?|crypto\w*|migrations?|uploads?)$/;

const SINKS: { name: string; pattern: RegExp }[] = [
  { name: "eval", pattern: /(^|[^\w.$])eval\s*\(/ },
  { name: "new Function", pattern: /\bnew\s+Function\s*\(/ },
  { name: "child_process", pattern: /['"](node:)?child_process['"]/ },
  { name: "exec with interpolation", pattern: /\b(exec|execSync)\s*\(\s*(`[^`]*\$\{|(['"])[^'"]*\3\s*\+)/ },
  { name: "innerHTML assignment", pattern: /\.(inner|outer)HTML\s*\+?=(?!=)/ },
  { name: "dangerouslySetInnerHTML", pattern: /\bdangerouslySetInnerHTML\b/ },
  { name: "document.write", pattern: /\bdocument\.write(ln)?\s*\(/ },
  {
    name: "SQL built from strings",
    pattern: /\b(select\s[\s\S]*\sfrom|insert\s+into|update\s+\w+\s+set|delete\s+from)\b(?=[\s\S]*(\$\{|['"`]\s*\+))|(['"`]\s*\+|\$\{)[\s\S]*\b(select\s[\s\S]*\sfrom|insert\s+into|update\s+\w+\s+set|delete\s+from)\b/i,
  },
];

const MAX_REASONS = 10;

const isPassive = (path: string) => PASSIVE_DIRS.test(path) || PASSIVE_EXTENSIONS.test(path);
const isTest = (path: string) => TEST_PATH.test(path);

/** Lower-case words of a path, split on separators and camelCase: `src/sessionStore.ts` → src, session, store, ts. */
function words(path: string): string[] {
  return path
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function listed(items: string[]): string {
  const shown = items.slice(0, 5).join(", ");
  return items.length > 5 ? `${shown} and ${items.length - 5} more` : shown;
}

export function reviewDepth(diff: DiffSummary): ReviewDepth {
  const code = diff.files.filter((f) => !isPassive(f));
  if (code.length === 0) {
    return { tier: "passive", lenses: [], reasons: [diff.files.length ? `only documentation, assets or Forge handoffs changed (${listed(diff.files)})` : "no changes against the base commit"] };
  }

  const reviewed = code.filter((f) => !isTest(f));
  const signals: string[] = [];
  for (const path of reviewed) {
    const hit = words(path).find((w) => SENSITIVE_WORD.test(w));
    if (hit) signals.push(`${path}: sensitive path (${hit})`);
  }
  const reviewedSet = new Set(reviewed);
  for (const added of diff.added) {
    if (!reviewedSet.has(added.path)) continue;
    const sink = SINKS.find((s) => s.pattern.test(added.text));
    if (sink) signals.push(`${added.path}:${added.line}: ${sink.name} (${added.text.trim().slice(0, 120)})`);
  }

  if (signals.length) {
    const reasons = signals.slice(0, MAX_REASONS);
    if (signals.length > MAX_REASONS) reasons.push(`and ${signals.length - MAX_REASONS} more signals`);
    return { tier: "high", lenses: [...REVIEW_LENSES], reasons };
  }
  return { tier: "medium", lenses: ["reliability"], reasons: [`code changed in ${listed(code)}, with no sensitive path or dangerous sink`] };
}

/** Reads `git diff --unified=0` output: the changed files and the added lines with their new line numbers. */
export function parseUnifiedDiff(text: string): DiffSummary {
  const files: string[] = [];
  const added: AddedLine[] = [];
  let path: string | undefined;
  let line = 0;
  const addFile = (p: string) => {
    path = p;
    if (!files.includes(p)) files.push(p);
  };
  for (const raw of text.split("\n")) {
    const header = /^diff --git a\/.+ b\/(.+)$/.exec(raw);
    if (header?.[1]) {
      addFile(header[1]);
      line = 0;
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk?.[1]) {
      line = Number(hunk[1]);
      continue;
    }
    if (!path || line === 0) continue;
    if (raw.startsWith("+") && !raw.startsWith("+++ ")) {
      added.push({ path, line, text: raw.slice(1) });
      line++;
    } else if (raw.startsWith(" ")) {
      line++;
    }
  }
  return { files, added };
}
