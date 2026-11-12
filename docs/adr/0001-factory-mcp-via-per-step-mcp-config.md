# ADR 0001 — The `factory` MCP server is attached per step with `--mcp-config`

- Status: accepted
- Date: 2026-11-11
- Phase: F0 spike
- Deviates from: "Agents and skills per step" in `docs/Forge — Project Definition.md`, which puts the `factory` MCP server in each agent's `mcpServers`.

## Context

The definition expects each `.claude/agents/forge-<step>.md` to carry the `factory` MCP server in its
frontmatter, loaded when the agent runs as the main thread with `--agent` ("v2.1.117+").

Probes on Claude Code **2.1.322** showed:

1. Frontmatter `mcpServers` load with `--agent` **only when the agent file's folder is trusted**. Otherwise
   the debug log says `Skipping frontmatter MCP servers for main-thread agent '<name>': the folder its
   definition file came from is not trusted`. The official docs date the trust check to v2.1.238. No source
   for v2.1.117 was found.
2. A git worktree under a trusted repository inherits its trust: an interactive `claude` started in
   `<repo>/.worktrees/TASK-001` shows no trust dialog and loads frontmatter servers.
3. `${VAR}` is **not** expanded inside frontmatter `mcpServers` (the same server with `${VAR}` in `args`
   exposed no tools, the literal value did).
4. No environment variable tells an MCP server the Claude `session_id`.
5. The agent's `tools:` allowlist hides MCP tools that it does not list (`mcp__<server>`).
6. `--mcp-config` servers load whether or not the folder is trusted. The flag is variadic, so a prompt
   placed after it is read as a config file path.

So a static frontmatter definition cannot tell `report_step` which step is reporting: the URL or
header would have to carry a per-step value, and frontmatter cannot interpolate one.

## Decision

- The backend renders one MCP config per step into its own home (`<FORGE_HOME>/steps/<stepId>/mcp.json`,
  mode 0600) with `factory` at `http://127.0.0.1:<port>/mcp/<stepId>` and the local token header, and
  passes it with `--mcp-config`. The step id in the URL identifies the step; the agent never handles it.
- Agents keep their other servers (Engram) in frontmatter `mcpServers` and list `mcp__factory` in
  `tools:`.
- The runner puts the prompt **before** the flags: `claude '<prompt>' --agent ... --mcp-config <file>`.
- The project root must be trusted once (accept the dialog in an interactive `claude` there). Worktrees
  inherit it, so Forge never writes `~/.claude.json`.
- Minimum Claude Code version: **2.1.322**, the version validated in this spike.

## Consequences

- `report_step` cannot be called by a session that does not own the step: the URL is per step and
  needs the token.
- The token lives outside the worktree, so it is not committed and the agent does not see it in its
  files.
- An untrusted project fails in a visible way: the interactive session stops at the trust dialog and the
  step ends by timeout. Phase 1 should check trust before launching and report a clear error.
