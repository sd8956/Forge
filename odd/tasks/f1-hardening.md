# F1 hardening — unattended steps before Phase 2

Objective: close the pre-Phase-2 items from `docs/runs/f1.md` so pipeline runs need almost no operator. Branch `feat/f1-hardening`. Delivery: work-unit commits, single PR (push/PR by the user). Test runner: vitest.

## Specs

- S1 User request (2026-11-17): "cubre todos los puntos que mencionas antes de avanzar a la fase 2". Points mentioned: PreToolUse hook that denies Bash file writes; leave `needs_human` when the person answers (PostToolUse); permissions per step as a metric; plus the `docs/runs/f1.md` list. The embedded terminal is Phase 2 panel scope (excluded, stated to the user).
- S2 PreToolUse guard: the backend denies, with a corrective reason, Bash commands that write files (heredocs, redirects to files, inline interpreters, `sed -i`, `tee`), use expansions (`$(...)`, backticks, `$VAR`), `cd`, or touch paths outside the worktree; and file tools on paths outside the worktree. Test cases come from the 79 real commands of the F1 runs.
- S3 needs_human exit: PostToolUse and UserPromptSubmit move a `needs_human` step back to `running`, and its run back to `running`.
- S4 Metrics: permission prompts and tool denials per step, shown by `status` and the API.
- S5 Dependency guard: `run-task` refuses a task whose `Depends on:` tasks are not merged into the base branch.
- S6 Semgrep project rule that flags request data reflected into an HTML response (the F1 seeded XSS that `p/default` missed); `security-scan` uses it.
- S7 Engram: per-step guidance on what to save.
- S8 Agents' commits and PRs carry no AI attribution (`attribution` setting in step settings).
- S9 ADR for the deviations; sandbox synced; docs updated; tests, lint, typecheck green.

## Tasks

| ID | Specs | Route | Status | Commit |
| --- | --- | --- | --- | --- |
| T1 | S2 | inline | pending | |
| T2 | S3 | inline | pending | |
| T3 | S4 | inline | pending | |
| T4 | S5 | inline | pending | |
| T5 | S6, S7, S8 | inline | pending | |
| T6 | S9 | inline | pending | |

## Log

- L1 (2026-11-17) User: "cubre todos los puntos que mencionas antes de avanzar a la fase 2".
- L2 Verified: PreToolUse deny JSON `hookSpecificOutput.permissionDecision: "deny"` + `permissionDecisionReason`; matcher `Bash`; PostToolUse without matcher fires for every tool; `attribution.commit`/`attribution.pr` replace deprecated `includeCoAuthoredBy`; `permissions.denyInsteadOfPrompting` exists (user/managed/--settings) — considered as an alternative. Found: agents add `Co-Authored-By: Claude` to sandbox commits.
