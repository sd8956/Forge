import { existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Claude Code skips the agent's MCP servers and stops at a trust dialog in
 * folders the user never trusted (ADR 0001). Worktrees inherit the project's
 * trust, so it is enough to check the project root or one of its parents.
 * Read-only: Forge never writes the Claude config.
 */
export function isTrusted(claudeConfigFile: string, projectPath: string): boolean {
  if (!existsSync(claudeConfigFile)) return false;
  let projects: Record<string, { hasTrustDialogAccepted?: boolean }>;
  try {
    projects = (JSON.parse(readFileSync(claudeConfigFile, "utf8")) as { projects?: typeof projects }).projects ?? {};
  } catch {
    return false;
  }
  for (let dir = projectPath; ; dir = dirname(dir)) {
    const entry = projects[dir];
    if (entry?.hasTrustDialogAccepted === true) return true;
    if (entry?.hasTrustDialogAccepted === false) return false;
    if (dirname(dir) === dir) return false;
  }
}
