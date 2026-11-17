# F3 — orchestrator, scheduler and parallel pipelines

Objective: talk to an orchestrator that reads the backlog and proposes a DAG plan in waves; after the user approves it in the panel, a deterministic scheduler runs several pipelines in parallel within concurrency, dependency, module and usage limits. Branch `feat/f3-orchestrator`. Delivery: work-unit commits; push/PR decided by the user. Test runner: vitest + Playwright.

## Specs

- S1 Plans: tables `execution_plan` (`proposed → approved | rejected → done`) and `plan_task` (task, wave, modules, priority, queue state, `run_id`); DAG validated (no cycles, existing dependencies, waves respect order). ADR for `plan_task` instead of the definition's `task` table.
- S2 Scheduler as a pure tested function: concurrency (`policies.max_concurrency`, default 3), merged dependencies, never two tasks on the same module, FIFO with priority, manual pause, usage threshold (`policies.usage_pause_percent`, default 90). Review rounds have priority over new tasks but also wait for a slot.
- S3 Rate limit: `StopFailure` hook with matcher `rate_limit` pauses the whole queue; the affected step closes as an infrastructure failure without spending attempts and is relaunched when the pause lifts (`resets_at` or manual).
- S4 Usage: a `statusLine` script in the step settings sends `rate_limits` to `/hooks/usage`; the panel shows the usage window.
- S5 Orchestrator: a Claude Code session in the project's main checkout with agent `forge-orchestrator`, tools `Read`, `Grep`, `Glob` and an MCP at `/mcp/orchestrator/<project>` with `list_backlog`, `propose_plan`, `launch_pipeline`, `get_status`, `cancel`. No Bash, no Write. `launch_pipeline` only queues tasks of a plan the user approved.
- S6 Restart reconciliation: the queue continues without double launches (uniqueness between `plan_task` and `run`).
- S7 Panel per the PDF: Execution with "Active sessions N of M", Queued, Need attention, Open PRs; Pause/Resume queue; Launch tasks (opens the orchestrator); Queued list with wait reasons; orchestrator pane (terminal in control mode) and a proposed-plan card with waves and Approve/Reject; usage window widget in the sidebar.
- S8 Tests: unit (scheduler table, plan validation, usage parsing); integration with fake claude and fake gh (3-task plan with cap 2 and a dependency released by merge; module conflict; rate limit pause and recovery; usage 95% stops launches; restart without duplicates; fake orchestrator calling its tools; launch_pipeline refused without an approved plan); Playwright (approve plan from the panel, wait reasons, pause queue, orchestrator terminal, usage widget); real run: 3 small new sandbox tasks (two independent, one dependent), the user asks the orchestrator to plan them, approves, 2 run in parallel with cap 2, the user merges one so the dependent starts (~15 sessions).
- S9 Exit gate:
  - The real orchestrator reads the backlog and proposes a plan; nothing launches until approved in the panel.
  - With the plan approved, several pipelines run in parallel without exceeding the cap; the dependent starts only after the merge.
  - Two tasks sharing a module never run at the same time.
  - A rate limit pauses the whole queue (fake claude); "Pause queue" works; the usage window shows real data.
  - Restarting the backend mid-queue neither loses nor duplicates launches.
  - The orchestrator has no Bash or Write and acts only through tools; all transitions in code.
  - `test`, `lint`, `typecheck` and e2e green.

## Tasks

| ID | Specs | Route | Status | Commit |
| --- | --- | --- | --- | --- |
| T1 | S1 | inline | pending | |
| T2 | S2 | inline | pending | |
| T3 | S2, S6 | inline | pending | |
| T4 | S3, S4 | inline | pending | |
| T5 | S5 | inline | pending | |
| T6 | S7 | inline | pending | |
| T7 | S8 | inline | pending | |
| T8 | S8, S9 | inline | pending | |

## Log

- L1 (2026-11-17) User: "Mezclado avanza con el plan" → plan proposed; L2 User: "si apruebo el plan" (includes the ~15-session real run with 3 new sandbox tasks).
- L3 Verified in docs: `StopFailure` matcher values include `rate_limit` (input fields undocumented); statusline JSON has `rate_limits.five_hour.used_percentage`/`resets_at` for Pro/Max/Ultra after the first API response.
