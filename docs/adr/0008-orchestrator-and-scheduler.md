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

- **The scheduler owns every launch from a plan and every review round.** A pass gathers open runs, merged
  dependencies, the pause and the usage window, asks the pure `schedule` what may start and starts it through the
  run service. It runs on an interval and whenever a run changes status. The PR watcher no longer starts review
  rounds: it stores the threads and wakes the scheduler, which gives review rounds the free slots first.
- **Slots and modules.** Runs that are `queued`, `running` or `needs_human` hold a slot (the definition's "sessions"),
  whether a plan or `forge run-task` started them; `forge run-task` itself is not capped. Their plan task's modules
  are busy; a run waiting for review holds neither. Modules overlap when one is the other or a folder above it.
  `FORGE_MAX_CONCURRENCY` (default 3) caps all projects; `policies.max_concurrency` can lower it for one project.
- **Merged dependencies.** A dependency counts as merged only when git says so *and* no Forge run for it is
  unfinished (open or waiting for review) and it is not still queued. A fresh task branch with no commits is an
  ancestor of the base branch, so git alone called it merged (this also fixes `forge run-task`).
- **Pulling the base branch.** When a dependency is merged on GitHub but not locally, the scheduler fetches
  `origin/<base>` and fast-forwards the project checkout, the way a person pulls main before the next task. It does
  so only when the checkout is on the base branch and has no uncommitted changes; otherwise the wait reason says why.
- **Restarts.** A queued task whose run already exists (the backend stopped between inserting the run and linking it)
  is linked, not launched again.

## Consequences

- `task` from the definition's data model is not created; its `depends_on` and status live in the backlog files,
  `plan_task` and `run`.
