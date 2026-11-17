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
| T1 | S2 | inline | done | 42f3ed2, 8727a3f |
| T2 | S3 | inline | done | 8727a3f |
| T3 | S4 | inline | done | 8727a3f |
| T4 | S5 | inline | done | c2d779d |
| T5 | S6, S7, S8 | inline | done | 7342acf, 8727a3f (attribution) |
| T6 | S9 | inline | done | 7d74e83, sandbox f25f6b5 |

## Log

- L1 (2026-11-17) User: "cubre todos los puntos que mencionas antes de avanzar a la fase 2".
- L2 Verified: PreToolUse deny JSON `hookSpecificOutput.permissionDecision: "deny"` + `permissionDecisionReason`; matcher `Bash`; PostToolUse without matcher fires for every tool; `attribution.commit`/`attribution.pr` replace deprecated `includeCoAuthoredBy`; `permissions.denyInsteadOfPrompting` exists (user/managed/--settings) — considered as an alternative. Found: agents add `Co-Authored-By: Claude` to sandbox commits.
- L3 (2026-11-17) Guard classifier checked against the 79 real F1 commands: 14 denied (6 heredoc, 4 variable, 1 inline script, 1 cd, 1 expansion, 1 outside worktree), 65 allowed. Semgrep rule: flags the seeded echo route and header reflection, no findings on the fixed server or JSON/static responses.
- L4 Real probe (Claude Code 2.1.322, haiku, -p): HTTP PreToolUse deny is honoured and the model switches to Write; PostToolUse fires for Write and Bash; `attribution: {commit: "", pr: ""}` leaves no Co-Authored-By trailer.
- L5 199 tests, lint and typecheck green. Next: user decides push/PR; optional real pipeline run to measure prompts.
