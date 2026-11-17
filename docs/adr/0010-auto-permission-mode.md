# ADR 0010 — Pipeline steps run in auto permission mode by default

- Status: accepted
- Date: 2026-11-17
- Phase: F4 (real run on `forge-definition-sandbox`)
- Deviates from: principle 7 "A person always in the loop" as `CLAUDE.md` applied it ("Steps never run with
  `bypassPermissions` or `auto`") and ADR 0006.

## Context

In the first real run of a project defined by Forge (`daily-tasks`, TypeScript and pnpm), almost every step stopped on
a permission prompt: `node -v; pnpm -v`, `mktemp -d`, `pnpm prettier --write ... && make check`, `git clone --branch
feat/TASK-001 . <dir>`. The template's allow lists were written for `demo-project`'s stack, so a new stack prompts
until its commands are listed. Choosing "Yes, and switch to auto mode" let the steps continue. The person decided to
make auto the default and keep a way back.

## Decision

- Pipeline steps start with `--permission-mode auto` unless the project's `.factory/project.yaml` sets
  `policies.permission_mode: agent`, which uses the agent file's mode (acceptEdits).
- What still holds in auto (Claude Code docs, permissions): deny and ask rules apply to every subcommand, and the
  PreToolUse guard is a hook, so force pushes, `gh pr merge`, `rm -rf`, `curl`, heredocs and paths outside the worktree
  stay blocked. A person still merges every PR.
- `permissions.disableBypassPermissionsMode: "disable"` is set in every rendered step settings file; with
  `permission_mode: agent`, `permissions.disableAutoMode: "disable"` is set too, so the prompt's "switch to auto mode"
  cannot silently change a step.
- The agent file is still checked (it may never ask for `bypassPermissions`), and each step's launch event records the
  mode it ran with.
- Definition stages and the orchestrator keep their own modes: they have no Bash, so they rarely prompt.

## Consequences

- A classifier, not the person, approves the commands that are neither allowed nor denied. Projects that want every
  such command reviewed set `permission_mode: agent`.
- Project-specific allow lists (`policies.allow_commands`) were considered and left for later; auto mode makes them
  optional.
