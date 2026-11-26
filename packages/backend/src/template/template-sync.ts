import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { promisify } from "node:util";
import { TEMPLATE_PATHS } from "../definition/template.js";

const run = promisify(execFile);

/** Each project keeps its own conventions skill (a definition writes a generic one); sync never touches it. */
const PROJECT_OWNED = [".claude/skills/repo-conventions/"];

export interface SyncPlan {
  /** Untouched copies of an older template version: replaced with the current one. */
  update: string[];
  /** In the template, missing in the project. */
  add: string[];
  /** Changed in the project (no template version matches): left alone and listed for the person. */
  customized: string[];
}

/** The agents' Engram project name is the one difference a copy may have from the template. */
const PROJECT_ARG = /("--project",\s*)"[^"]*"/g;
const normalize = (text: string) => text.replace(PROJECT_ARG, '$1"<project>"');
const hash = (text: string) => createHash("sha256").update(normalize(text)).digest("hex");
const forProject = (text: string, projectName: string) => text.replace(PROJECT_ARG, `$1${JSON.stringify(projectName)}`);

/** Files Forge owns in a project, relative to the template root. */
export function templateFiles(templateDir: string): string[] {
  const files: string[] = [];
  const walk = (rel: string) => {
    const full = join(templateDir, rel);
    if (!existsSync(full)) return;
    if (statSync(full).isDirectory()) {
      for (const entry of readdirSync(full).sort()) walk(join(rel, entry));
    } else if (!PROJECT_OWNED.some((p) => rel.startsWith(p))) {
      files.push(rel);
    }
  };
  for (const path of TEMPLATE_PATHS) walk(path);
  return files;
}

const histories = new Map<string, Promise<Set<string>>>();

/**
 * Hashes of every version a template file has had: each commit that touched it in Forge's repository, plus the
 * working copy. Outside a git repository only the current version is known. Cached for the process.
 */
export function templateHistory(templateDir: string, file: string): Promise<Set<string>> {
  const key = `${templateDir}\0${file}`;
  let found = histories.get(key);
  if (!found) {
    found = (async () => {
      const versions = new Set<string>();
      const current = join(templateDir, file);
      if (existsSync(current)) versions.add(hash(readFileSync(current, "utf8")));
      try {
        const root = (await run("git", ["-C", templateDir, "rev-parse", "--show-toplevel"], { encoding: "utf8" })).stdout.trim();
        const rel = relative(root, current);
        const revs = (await run("git", ["-C", root, "log", "--format=%H", "--", rel], { encoding: "utf8" })).stdout.split("\n").filter(Boolean);
        for (const rev of revs) {
          const shown = await run("git", ["-C", root, "show", `${rev}:${rel}`], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 }).catch(() => null);
          if (shown) versions.add(hash(shown.stdout));
        }
      } catch {
        // Not a git checkout: only the current version is known.
      }
      return versions;
    })();
    histories.set(key, found);
  }
  return found;
}

export async function planSync(opts: { templateDir: string; projectRoot: string; projectName: string; history: (file: string) => Promise<Set<string>> }): Promise<SyncPlan> {
  const plan: SyncPlan = { update: [], add: [], customized: [] };
  for (const file of templateFiles(opts.templateDir)) {
    const target = join(opts.projectRoot, file);
    if (!existsSync(target)) {
      plan.add.push(file);
      continue;
    }
    const mine = hash(readFileSync(target, "utf8"));
    if (mine === hash(readFileSync(join(opts.templateDir, file), "utf8"))) continue;
    if ((await opts.history(file)).has(mine)) plan.update.push(file);
    else plan.customized.push(file);
  }
  return plan;
}

/** Writes the planned updates and additions, keeping the project's Engram project name in agents. */
export function applySync(opts: { templateDir: string; projectRoot: string; projectName: string; plan: SyncPlan }): void {
  for (const file of [...opts.plan.update, ...opts.plan.add]) {
    const target = join(opts.projectRoot, file);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, forProject(readFileSync(join(opts.templateDir, file), "utf8"), opts.projectName));
  }
}
