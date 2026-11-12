# ADR 0003 — F0 `step` table and step states

- Status: accepted
- Date: 2026-11-11
- Phase: F0 spike
- Deviates from: "Data model" in `docs/Forge — Project Definition.md`.

## Context

F0 only has the `step` and `event` tables; `project`, `task` and `run` arrive in Phase 1. The definition
lists `run` states but not `step` states.

## Decision

- `step` keeps every column of the definition and adds what F0 needs without `run`/`task`:
  `project_path`, `task_id`, `worktree_path`, `timeout_ms`, `deadline_at`, `stop_block_count`,
  `reported_at`, `summary`, `artifacts`, `created_at`. `run_id` stays nullable until `run` exists.
- A partial unique index on `(project_path, task_id, kind)` for live statuses (`queued`, `running`,
  `needs_human`) makes a duplicate live step impossible, even across backend restarts.
- Step states: `queued → running → (done | blocked | failed | needs_human)`. `needs_human` is not
  terminal: the person answers in the terminal and the agent can still report. Every transition is in
  the table in `packages/backend/src/domain/step-machine.ts`.
- `exit_reason` records why a step ended: `reported_<status>`, `timeout`, `launch_failed`,
  `session_ended_without_report:<reason>`, `session_vanished`, `orphaned_before_launch`,
  `orphaned_session_missing`.

## Consequences

- Phase 1 adds `run` and moves `project_path`/`task_id` there; the migration is additive.
- The brand and interface design shows run cards as Queued, Running, Awaiting review, Needs attention,
  Failed and Done, with no "Blocked". Phase 1 must decide how a `blocked` step shows on a run card (most
  likely `needs_human` at run level).
