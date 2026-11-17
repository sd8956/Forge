import { isAbsolute, relative, resolve } from "node:path";

/**
 * Decides, before a tool runs, whether a step's tool call is one that would
 * stop the pipeline on a permission prompt (or leave the worktree). Denying it
 * with a corrective reason lets the agent fix its own call instead of waiting
 * for a person. Pure: the PreToolUse hook endpoint applies it.
 */
export type GuardRule =
  | "heredoc"
  | "inline_script"
  | "variable"
  | "expansion"
  | "cd"
  | "redirect"
  | "in_place_edit"
  | "unquoted_glob"
  | "outside_worktree";

export type GuardResult = { allow: true } | { allow: false; rule: GuardRule; reason: string };

const WRITE_WITH_TOOLS =
  "Forge steps write files only with the Write and Edit tools. Use Write or Edit instead of heredocs, redirects, inline scripts or in-place edits; those Bash forms stop the pipeline on a permission prompt.";
const LITERAL_VALUES =
  "Use literal values instead of shell variables, $(...) or backticks: type the path, commit or value from input.md directly. Expansions stop the pipeline on a permission prompt.";
const QUOTE_GLOBS =
  "Quote glob patterns (find . -name '*.js'), or use the Glob tool to list files and Grep to search them. An unquoted glob in find, git, sed or sort stops the pipeline on a permission prompt, because it could expand to a flag.";
/** Commands with write- or exec-capable flags: Claude Code asks about any unquoted glob in them. */
const GLOB_SENSITIVE = new Set(["find", "git", "sed", "sort"]);
const NO_CD = "Do not cd. Run every command from the worktree root with relative paths (git and the tools already run there).";

const deny = (rule: GuardRule, reason: string): GuardResult => ({ allow: false, rule, reason });

function insideWorktree(path: string, worktree: string): boolean {
  if (path === "/dev/null") return true;
  const rel = relative(worktree, resolve(worktree, path));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function outside(path: string, worktree: string): GuardResult {
  return deny("outside_worktree", `Stay inside the task worktree (${worktree}). Do not read, list or write ${path}.`);
}

export function guardBash(command: string, worktree: string): GuardResult {
  if (/<<-?\s*['"]?[A-Za-z_]+/.test(command)) {
    return /\b(python3?|node|perl|ruby)\b[^\n|;&]*<</.test(command) ? deny("inline_script", WRITE_WITH_TOOLS) : deny("heredoc", WRITE_WITH_TOOLS);
  }

  // Single-quoted text is literal for the shell; double-quoted text still expands.
  const noSingle = command.replace(/'[^']*'/g, "''");
  if (/^\s*[A-Za-z_][A-Za-z0-9_]*=\S*\s*($|[;\n]|&&)/m.test(noSingle) || /[;\n&]\s*[A-Za-z_][A-Za-z0-9_]*=\S*\s*($|[;\n]|&&)/.test(noSingle)) {
    return deny("variable", LITERAL_VALUES);
  }
  if (/\$\(|`|\$[A-Za-z_{]/.test(noSingle)) return deny("expansion", LITERAL_VALUES);

  const code = noSingle.replace(/"(?:[^"\\]|\\.)*"/g, '""');
  if (/(^|[;&|\n]\s*)cd\s/.test(code)) return deny("cd", NO_CD);
  if (/\b(python3?|node|perl|ruby|deno|bun)(\s+-[A-Za-z]+)*?\s+(-c|-e|-p|--eval|--print|-)(\s|$)/.test(code)) return deny("inline_script", WRITE_WITH_TOOLS);
  if (/\bsed\s+(-[a-zA-Z]*i|--in-place)\b/.test(code) || /(^|[|;&\n]\s*)tee\b/.test(code)) return deny("in_place_edit", WRITE_WITH_TOOLS);

  for (const part of code.split(/[;&|\n]+/)) {
    const [program, ...args] = part.trim().split(/\s+/);
    if (program && GLOB_SENSITIVE.has(program) && args.some((a) => /[*?[]/.test(a))) return deny("unquoted_glob", QUOTE_GLOBS);
  }

  for (const match of code.matchAll(/(^|[^0-9&<>])>>?\s*([^\s;&|]+)/g)) {
    const target = match[2] ?? "";
    if (!target.startsWith("&") && target !== "/dev/null") return deny("redirect", WRITE_WITH_TOOLS);
  }

  for (const token of code.split(/[\s;&|()<>]+/)) {
    if (token.startsWith("~")) return outside(token, worktree);
    if (token.startsWith("/") && !insideWorktree(token, worktree)) return outside(token, worktree);
  }
  return { allow: true };
}

/** Tools whose path argument must stay inside the worktree. */
const PATH_FIELDS: Record<string, string> = { Read: "file_path", Write: "file_path", Edit: "file_path", MultiEdit: "file_path", NotebookEdit: "notebook_path", Glob: "path", Grep: "path" };

export function guardTool(toolName: string, toolInput: Record<string, unknown>, worktree: string): GuardResult {
  if (toolName === "Bash") {
    const command = toolInput.command;
    return typeof command === "string" ? guardBash(command, worktree) : { allow: true };
  }
  const field = PATH_FIELDS[toolName];
  const path = field ? toolInput[field] : undefined;
  if (typeof path === "string" && isAbsolute(path) && !insideWorktree(path, worktree)) return outside(path, worktree);
  return { allow: true };
}
