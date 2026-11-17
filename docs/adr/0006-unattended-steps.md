# ADR 0006 — Unattended steps: tool guard, activity resume, dependency guard

- Status: accepted
- Date: 2026-11-17
- Phase: F1 hardening (before Phase 2)
- Deviates from: "Lifecycle of a step session in tmux" (only Stop, Notification and SessionEnd hooks) and the
  Phase 3 scheduler rule "A task does not start until its dependencies are merged", brought forward as a guard.

## Context

F1 real run 1 needed 12 operator answers. Almost all came from how agents use Bash (heredocs, inline scripts,
`$(...)`, variables, `cd`), which Claude Code always asks about, even in `acceptEdits` with an allowlist.
Instructions in prompts and skills reduced it but are not a guarantee. A step also stayed `needs_human` after
the person answered, so a second prompt in the same step was invisible. TASK-002 ran before TASK-001 was merged,
so its PR carried TASK-001's commits.

## Decision

- **PreToolUse guard.** Every step settings file sends `PreToolUse` (matcher
  `Bash|Read|Write|Edit|MultiEdit|Glob|Grep`) to `/hooks/pre-tool-use`. A pure function
  (`src/domain/tool-guard.ts`, tested with the 79 real commands of the F1 runs) answers
  `permissionDecision: "deny"` with a corrective reason for: heredocs, inline interpreters, redirects to files,
  `sed -i`/`tee`, shell variables and expansions, `cd`, and paths outside the worktree. Anything else falls
  through to Claude Code's normal permission flow, so unknown commands still reach a person.
- **Activity resume.** `PostToolUse` (every tool) and `UserPromptSubmit` go to `/hooks/activity`. A
  `needs_human` step moves back to `running` (`resume_work`), and so does its run.
- **Metrics.** `step.permission_prompts` and `step.tool_denials` count prompts and guard denials; `status`
  shows them per step and in total.
- **Dependency guard.** `run-task` refuses a task whose `- Depends on:` tasks are not merged into the base
  branch. Merged means the task branch is an ancestor of the base, or the base history has a commit naming
  `(TASK-xxx)` (a squash merge of a Forge PR, whose title ends with the task id).
- **No AI attribution.** Step settings set `attribution: { commit: "", pr: "" }`.
- **Project Semgrep rule.** `.semgrep/forge.yml` in the target project adds a taint rule for request data
  reflected into raw Node http responses; `security-scan` runs it with `p/default`.

## Alternatives considered

- `permissions.denyInsteadOfPrompting` (user or `--settings` scope) denies everything that would prompt.
  It keeps sessions moving, but removes the person from legitimate decisions (an unexpected `gh` or `npm`
  call) and gives the agent no hint on what to do instead. Kept as an option for fully unattended runs.

## Consequences

- A guard false positive costs one denied call and a retry with Write/Edit; the reason tells the agent why.
- The dependency heuristic misses a squash merge whose message drops the task id; the error says how to fix it.
