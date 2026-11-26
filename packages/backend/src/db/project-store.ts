import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { loadProjectConfig } from "../projects/project-config.js";
import type { Db } from "./client.js";
import { projects, type ProjectRow } from "./schema.js";

function git(path: string, args: string[]): string | null {
  try {
    return execFileSync("git", ["-C", path, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

export class ProjectStore {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Registers a repository, or refreshes its config, remote and default branch.
   * A project being defined has no project.yaml on its base branch yet: with
   * `fallbackName` it is registered under that name until the definition merges.
   */
  upsert(repoPath: string, opts: { fallbackName?: string } = {}): ProjectRow {
    const config =
      opts.fallbackName && !existsSync(join(repoPath, ".factory", "project.yaml"))
        ? { name: opts.fallbackName, platforms: [], commands: {}, policies: {}, review: { allowed_authors: [] } }
        : loadProjectConfig(repoPath);
    const values = {
      name: config.name,
      // The configured URL: get-url would apply url.<x>.insteadOf rewrites and hide the GitHub slug.
      remote: git(repoPath, ["config", "--get", "remote.origin.url"]),
      defaultBranch: git(repoPath, ["rev-parse", "--abbrev-ref", "HEAD"]) ?? "main",
      config: config as Record<string, unknown>,
      updatedAt: this.now(),
    };
    const existing = this.getByPath(repoPath);
    if (existing) {
      this.db.update(projects).set(values).where(eq(projects.id, existing.id)).run();
      return this.mustGet(existing.id);
    }
    return this.db
      .insert(projects)
      .values({ id: randomUUID(), repoPath, createdAt: this.now(), ...values })
      .returning()
      .get();
  }

  get(id: string): ProjectRow | undefined {
    return this.db.select().from(projects).where(eq(projects.id, id)).get();
  }

  getByPath(repoPath: string): ProjectRow | undefined {
    return this.db.select().from(projects).where(eq(projects.repoPath, repoPath)).get();
  }

  list(): ProjectRow[] {
    return this.db.select().from(projects).all();
  }

  private mustGet(id: string): ProjectRow {
    const row = this.get(id);
    if (!row) throw new Error(`Unknown project ${id}`);
    return row;
  }
}
