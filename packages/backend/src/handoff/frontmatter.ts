import { parse } from "yaml";

export type FrontmatterResult = { ok: true; data: unknown; body: string } | { ok: false; error: string };

/** Splits a Markdown document into its YAML frontmatter and body. */
export function parseFrontmatter(text: string): FrontmatterResult {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!match) return { ok: false, error: "output.md must start with a YAML frontmatter block between --- lines" };
  try {
    return { ok: true, data: parse(match[1] ?? ""), body: match[2] ?? "" };
  } catch (error) {
    return { ok: false, error: `frontmatter is not valid YAML: ${error instanceof Error ? error.message : String(error)}` };
  }
}
