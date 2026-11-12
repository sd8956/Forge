# ADR 0002 — Step sessions: rendered settings, project-only setting sources, dedicated tmux socket

- Status: accepted
- Date: 2026-11-11
- Phase: F0 spike
- Deviates from: the launch command in "Lifecycle of a step session in tmux" (`--settings .factory/steps/<step>.settings.json`, plain `tmux new-session`).

## Context

- The step settings carry the hook URLs and the local token header. The URL depends on the backend port
  and the token must not live in the worktree ("Secrets never enter the worktrees").
- `--settings` hooks merge with the user's `~/.claude/settings.json` hooks and plugins. On a developer
  machine those add their own Stop and SessionEnd hooks, MCP servers and output styles to every step,
  which breaks the clean context and makes the Stop logic depend on foreign hooks.
- Forge kills and lists sessions. Doing that on the user's default tmux server risks touching their
  own sessions.
- `tmux kill-session` makes Claude Code fire `SessionEnd` with `reason: "other"`; `/exit` fires it with
  `prompt_input_exit`. Both were observed on 2.1.322.

## Decision

- `.factory/steps/<step>.settings.json` is a **template** with `{{FORGE_URL}}` and `{{FORGE_TOKEN}}`. The
  backend renders it into `<FORGE_HOME>/steps/<stepId>/settings.json` (mode 0600) and passes that file to
  `--settings`.
- Every step runs with `--setting-sources project`: user-level settings, hooks and plugins are not loaded.
  Tools a step needs (Engram) are declared in the agent.
- Sessions run on a dedicated tmux socket (`tmux -L forge`, configurable with `FORGE_TMUX_SOCKET`).
  "Reconcile with `tmux ls`" means `tmux -L forge ls`. Attach with `tmux -L forge attach -t <session>`.
- The token and port are stable across restarts (token in `<FORGE_HOME>/token`, port fixed, default
  7420), because running sessions keep the settings rendered at launch.
- The command run in tmux records the CLI exit code in `<FORGE_HOME>/steps/<stepId>/exit-code`, so a
  session that dies without hooks still leaves a reason.

## Consequences

- The fixed port is part of the contract with running sessions: changing it strands live steps until
  they time out.
- Users must use `-L forge` to see Forge sessions with the tmux CLI.
