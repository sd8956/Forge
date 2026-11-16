# ADR 0005 — F1 scope adjustments: skills, fixture, entry points

- Status: accepted
- Date: 2026-11-16
- Phase: F1
- Deviates from: "Agents and skills per step" (skill list) and the F0 CLI.

## Decision

- **Skills.** F1 ships `forge-step-protocol`, `test-plan-authoring`, `repo-conventions`, `security-scan`,
  `playwright-evidence`, `evidence-manifest` and `pr-report`. `engram-recall` is part of
  `forge-step-protocol`, and `threat-model-review` is part of `security-scan`. `api-contracts`,
  `ui-from-prototype` and `tdd-loop` are left for later: the designer and developer prompts carry those
  rules for now.
- **Fixture.** `fixtures/demo-project` is a small web app (Node `http`, no runtime dependencies), because
  the E2E step needs `make up` and Playwright. A lockfile is committed so osv-scanner has packages to scan.
- **Where templates are read.** `pipeline.yaml` and `.factory/steps/*.settings.json` are read from the
  project's main checkout, not the task worktree (F0 found worktrees freeze them). Agents and skills are
  still loaded by Claude Code from the worktree.
- **Trust preflight.** `run-task` refuses a project that `~/.claude.json` does not mark as trusted, or that
  sits under a folder marked untrusted. The file is only read, never written.
- **Engram scope.** Agents start Engram with `--project <name>`, the skill forbids `all_projects`, and the
  backend reads only with an explicit `project`. Each saved observation ends with `Ref: TASK-xxx/<step>`.
- **CLI.** `run-step` and `POST /steps` (F0) are replaced by `run-task`, `status`, `resume` and `cancel`
  (`/runs`). `cancel` is added because the run state machine has `cancelled`.
- **Blocked steps.** A step reported `blocked` puts the run in `needs_human` (`exitReason: blocked:<step>`);
  the run has no `blocked` state.
