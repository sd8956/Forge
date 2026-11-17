# ADR 0004 — The backend validates every step report against its output contract

- Status: accepted
- Date: 2026-11-16
- Phase: F1
- Deviates from: "Lifecycle of a step session in tmux" (the Stop hook as the only exit check) and the
  handoff layout `.factory/runs/TASK/<step>/`.

## Context

In F0 a step ended as soon as the agent called `report_step`, whatever it had written. The definition
puts the development exit check (`make check`) only in the Stop hook. But a step that reports `done` is
closed right away, so a Stop hook after the report never gets to block it. And an agent can report `done`
with a missing test case, a high finding or no evidence.

## Decision

- Each step kind has an output contract in code (`packages/backend/src/handoff/contracts.ts`): the files it
  writes and the step-specific fields of the `output.md` frontmatter. Every `output.md` starts with the
  common frontmatter `step`, `task`, `attempt`, `status`, `summary`, `artifacts`.
- `report_step` runs `validateReport` before accepting: schema, agreement with the report, artifacts that
  exist inside the worktree and, for `done`, the exit criteria of `pipeline.yaml` (`requires`,
  `every_ac_has_tc`, `command`, `max_severity`, `all_cases_pass`, `pr_created`). A rejected report returns
  every problem to the agent; the step keeps running.
- The exit `command` (`make check`) runs at report time and also in the Stop hook, whose reminder includes
  its result when the agent tries to stop without reporting.
- Handoffs live in `.factory/runs/<TASK>/<step>/<attempt>/`, so retries never overwrite the evidence of an
  earlier attempt.
- tmux sessions are named `forge-<TASK>-<step>-<attempt>`. With one name per step, the delayed close of
  attempt n killed attempt n+1 (found by the integration tests).

## Consequences

- Exit criteria are deterministic and do not depend on the model reading `input.md` correctly.
- A step that cannot satisfy its contract keeps getting rejections until the Stop reminders run out
  (`needs_human`) or its timeout fires.
