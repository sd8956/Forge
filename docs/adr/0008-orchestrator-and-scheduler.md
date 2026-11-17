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
  are busy. A run waiting for review frees its slot but keeps its modules until the merge (amended after the
  daily-tasks run: two open PRs changing the same file conflicted at merge time). Modules overlap when one is the other or a folder above it.
  `FORGE_MAX_CONCURRENCY` (default 3) caps all projects; `policies.max_concurrency` can lower it for one project.
- **Merged dependencies.** A dependency counts as merged only when git says so *and* no Forge run for it is
  unfinished (open or waiting for review) and it is not still queued. A fresh task branch with no commits is an
  ancestor of the base branch, so git alone called it merged (this also fixes `forge run-task`).
- **Pulling the base branch.** When a dependency is merged on GitHub but not locally, the scheduler fetches
  `origin/<base>` and fast-forwards the project checkout, the way a person pulls main before the next task. It does
  so only when the checkout is on the base branch and has no uncommitted changes; otherwise the wait reason says why.
- **Restarts.** A queued task whose run already exists (the backend stopped between inserting the run and linking it)
  is linked, not launched again.

- **Usage limits from hooks, not the screen.** Every rendered step settings file gets, whatever its template says,
  a `StopFailure` HTTP hook and a `statusLine` (Forge infrastructure, like the MCP config). Verified on 2.1.322: the
  `StopFailure` input carries `error` (`rate_limit`, `model_not_found`, ...) and `last_assistant_message`; the status
  line input carries `rate_limits.five_hour/seven_day.{used_percentage, resets_at}`. The status line script reads the
  backend URL and token from a private file next to the settings, so the token is never in a command line, and posts
  only when the window changes.
- **Rate limit.** `StopFailure` with `rate_limit` pauses the queue (`source: rate_limit`, until the known 5-hour
  reset) before the step closes as `rate_limited`. That outcome relaunches the same step without counting an attempt
  and without failure context. Other API errors move the step to `needs_human`.
- **A pause holds every pipeline.** While the queue is paused (by a person or by a usage limit), no step launches:
  the run records `launch_held` and keeps its slot, and the scheduler advances it again when the pause lifts. The
  usage threshold (`FORGE_USAGE_PAUSE_PERCENT`, default 90) only stops new tasks and review rounds. A person's pause
  is never replaced by an automatic one.

- **The orchestrator session.** One Claude Code session per project (`forge-orch-<id>` on Forge's tmux socket), in
  the project's own checkout, with the `forge-orchestrator` agent, `--permission-mode default` and settings from
  `.factory/orchestrator.settings.json`. Its tools are Read, Grep, Glob and the `factory` MCP server at
  `/mcp/orchestrator/<projectId>`; Bash, writes, web access and subagents are denied three times (agent `tools`,
  settings `deny` and `--disallowedTools`), and reads of Forge's home (rendered settings carry the token) are denied.
  The person talks to it through the panel terminal in control mode.
- **Its tools.** `list_backlog` (tasks with status), `propose_plan` (validated; stored as `proposed`),
  `launch_pipeline` (refuses a plan that is not approved, otherwise wakes the scheduler), `get_status` and `cancel`
  (a queued task or an open run, only when the person asks). Approving or rejecting a plan exists only as an HTTP
  route for the panel; approval queues the tasks, so the scheduler starts them without waiting for the orchestrator.
- **A dependency's run decides first.** When Forge ran a dependency, it counts as merged only if its latest run is
  `done`; git decides only for tasks Forge never ran (a cancelled or failed run can leave an empty branch).

## Consequences

- `task` from the definition's data model is not created; its `depends_on` and status live in the backlog files,
  `plan_task` and `run`.
