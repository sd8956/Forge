import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

/**
 * Permission modes a step may run with. `bypassPermissions` and `auto` approve
 * actions without asking, which would hide permission prompts from the
 * Notification hook and defeat the per-step allowlist.
 */
const ALLOWED_PERMISSION_MODES = ["acceptEdits", "default", "manual", "dontAsk", "plan"] as const;
const DEFAULT_PERMISSION_MODE = "acceptEdits";

/**
 * Reads `permissionMode` from `.claude/agents/<agent>.md`. Claude Code 2.1.322
 * does not apply it when the agent runs as the main thread with `--agent`,
 * so the runner passes it explicitly with `--permission-mode`.
 */
export function agentPermissionMode(worktreePath: string, agent: string): string {
  const file = join(worktreePath, ".claude", "agents", `${agent}.md`);
  if (!existsSync(file)) throw new Error(`Missing agent definition: .claude/agents/${agent}.md`);
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(readFileSync(file, "utf8"));
  if (!match?.[1]) throw new Error(`Agent .claude/agents/${agent}.md has no frontmatter`);
  const frontmatter = parse(match[1]) as Record<string, unknown> | null;
  const mode = frontmatter?.permissionMode ?? DEFAULT_PERMISSION_MODE;
  if (typeof mode !== "string" || !(ALLOWED_PERMISSION_MODES as readonly string[]).includes(mode)) {
    throw new Error(
      `Agent ${agent} asks for permissionMode ${JSON.stringify(mode)}; steps may only use ${ALLOWED_PERMISSION_MODES.join(", ")}`,
    );
  }
  return mode;
}
