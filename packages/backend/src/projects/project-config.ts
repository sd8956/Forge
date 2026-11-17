import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { parseDependencies } from "../runs/dependencies.js";

/** `.factory/project.yaml`. Unknown keys are kept: the definition panel will add more. */
export const projectConfigSchema = z.looseObject({
  name: z.string().min(1),
  platforms: z.array(z.string()).default([]),
  commands: z.record(z.string(), z.string()).default({}),
  policies: z.looseObject({}).default({}),
  review: z
    .looseObject({
      /** GitHub logins whose PR comments the review loop handles. Empty means nobody. */
      allowed_authors: z.array(z.string().min(1)).default([]),
      /** Seconds between PR polls for this project. */
      poll_interval_seconds: z.number().int().min(10).max(3600).optional(),
    })
    .default({ allowed_authors: [] }),
});
export type ProjectConfig = z.infer<typeof projectConfigSchema>;

export class ProjectConfigError extends Error {}

export function loadProjectConfig(projectPath: string): ProjectConfig {
  const file = join(projectPath, ".factory", "project.yaml");
  if (!existsSync(file)) throw new ProjectConfigError(`Missing .factory/project.yaml in ${projectPath}`);
  const parsed = projectConfigSchema.safeParse(parse(readFileSync(file, "utf8")));
  if (!parsed.success) {
    throw new ProjectConfigError(`Invalid project.yaml: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  return parsed.data;
}

export interface BacklogTask {
  id: string;
  title: string;
  size: string | null;
  covers: string[];
  dependsOn: string[];
}

/** Tasks in `.factory/backlog/`, read from the project's main checkout. */
export function listBacklog(projectPath: string): BacklogTask[] {
  const dir = join(projectPath, ".factory", "backlog");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /^TASK-\d{3,}\.md$/.test(f))
    .sort()
    .map((file) => {
      const text = readFileSync(join(dir, file), "utf8");
      const id = file.replace(/\.md$/, "");
      const title = new RegExp(`^#\\s*${id}\\s*[—-]\\s*(.+)$`, "m").exec(text)?.[1]?.trim() ?? id;
      const size = /^\s*-\s*Size:\s*([SML])\b/m.exec(text)?.[1] ?? null;
      const covers = /^\s*-\s*Covers:\s*(.+)$/m.exec(text)?.[1]?.match(/\b(FR|NFR)-\d+\b/g) ?? [];
      return { id, title, size, covers, dependsOn: parseDependencies(text) };
    });
}
