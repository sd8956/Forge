# ADR 0008 — Orchestrator plans and the scheduler queue

- Status: accepted
- Date: 2026-11-17
- Phase: F3
- Deviates from / makes concrete: "Panel 2 — Execution" (execution plan, scheduler rules), the data model and the
  concurrency NFR.

## Decision

- **Plans instead of a `task` table.** The backlog files stay the source of truth for tasks. A plan the orchestrator
  proposes is stored as `execution_plan` (`proposed → approved | rejected`, then `done` or `cancelled`) with one
  `plan_task` per task: wave, modules it touches, priority, dependencies copied from the backlog, queue state
  (`planned → queued → launched`, or `cancelled`), the scheduler's latest wait reason and the `run_id` it launched.
  A newer proposal for the same project supersedes an older one that is still `proposed`.
- **The backend validates every plan** (`validatePlan`, pure): tasks exist in the backlog and appear once, every task
  lists its modules, and every dependency is merged or in an earlier wave. Nothing is queued until a person
  approves the plan in the panel; approving queues all its tasks.
- **Persistent queue state.** A `setting` key-value table keeps the queue pause and the latest usage window, so a
  restart neither forgets a pause nor launches past a limit.

## Consequences

- `task` from the definition's data model is not created; its `depends_on` and status live in the backlog files,
  `plan_task` and `run`.
