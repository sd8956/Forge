# ADR 0014 — The project console

- Status: accepted
- Date: 2026-11-25
- Adds to: "Panel 2 — Execution" (the person talks to an orchestrator) a console for asking and fixing.

## Context

The person wanted a console in the panel to ask Claude about the project and the state of every task's steps, and to
delegate fixing what is blocked. Two scopes were offered: Forge's tools only (like the orchestrator, no Bash or
writes), or a full Claude Code session in the project plus Forge's tools. The person chose the second.

## Decision

- One console session per project (`forge-console-<id>` on Forge's tmux socket), in the project checkout, started from
  a "Console" drawer available on every page; the person types in its terminal or in an "Ask the console" box.
- It is the person's own Claude Code: their settings apply (no `--setting-sources`), no agent, `--permission-mode
  default` so every command or edit asks them in the terminal. Forge adds only `disableBypassPermissionsMode` and, with
  an API key in Settings, `apiKeyHelper`.
- Forge's tools come from a `factory` MCP server at `/mcp/console/<projectId>`: `get_status`, `list_runs`, `get_run`
  (steps, last events, threads, handoff paths), `active_steps` (live sessions and their worktrees), `resume_run` (with
  an optional base merge), `cancel_run`, `start_task`, `pause_queue`, `resume_queue`. They call the same services as the
  panel, so every state change goes through the transition tables.
- An appended system prompt tells it to check `active_steps` before editing a task's worktree, never to edit one whose
  step is live, and to change run and queue state only through the tools.

## Consequences

- The console can edit code and run commands, but only with the person's approval of each action; it cannot merge
  for them more than they can already (a person merges every PR).
