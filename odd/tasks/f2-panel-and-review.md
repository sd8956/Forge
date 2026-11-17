# F2 — execution panel, PR watcher and review fix

Objective: operate runs from the browser and close the PR loop (comment → fix → push → merge → done). Branch `feat/f2-panel-and-review`. Delivery: work-unit commits; push/PR decided by the user. Test runner: vitest (+ Playwright for the panel).

## Specs

- S1 Panel access: `forge serve` prints a one-time login link that sets an `HttpOnly; SameSite=Strict` cookie; the API accepts the header token or the cookie; WebSockets require the cookie and a local `Origin`/`Host`.
- S2 Live events: every `event` insert is published on `/ws/events`.
- S3 Terminal bridge: node-pty runs `tmux -L forge attach -r` (read-only) streamed to xterm.js; "take control" is explicit and recorded as an event. The backend never reads the screen for state.
- S4 `project` table per the definition's data model; reads `project.yaml` including `review.allowed_authors`.
- S5 PR watcher: configurable polling (default 2 min) of `waiting_review` runs with `gh api` (review comments, reviews, checks); threads stored in `pr_thread` so none is handled twice; agent replies carry `<!-- forge:reply -->` and are ignored.
- S6 Review loop: `pipeline.yaml` `review: { steps: [review_fix, security, e2e, pr], max_rounds: 3 }`; the `pr` step pushes and updates the existing PR body with `gh pr edit`.
- S7 Run transitions: `waiting_review → running` on a new comment or red CI; `→ done` on merge (worktree removed, feedback patterns saved to Engram as `TASK-xxx/review`); `→ cancelled` when the PR is closed unmerged.
- S8 Agent `forge-review-fixer` (Sonnet) and skill `pr-thread-reply`: fix and answer each thread with what changed or why it does not apply. Comments enter `input.md` quoted as untrusted data. The backend validates that `output.md` answers every thread in the input. Never `gh pr merge`.
- S9 Web (`packages/web`, Vite + React + xterm.js, tokens and layout of `docs/design/`): board (one column per step, one card per run: status, current step, time, attempts, prompts/denials, PR); run detail tabs Pipeline, Terminal, Test plan and evidence (files served with path containment), Artifacts, Memory; actions start a backlog task, resume, cancel.
- S10 Tests: unit (run transitions, watcher diff as a pure function, thread dedupe and marked replies, panel auth, path containment); integration with a fake `gh` (comment → review_fix → security → e2e → updated PR → waiting_review → merge → done, no thread handled twice); Playwright e2e of the panel against the backend with the fake claude; real runs: TASK-003 (health endpoint) followed from the panel and measuring prompts after the guard, and a Review fix on sandbox PR #1 from a user comment.
- S11 Exit gate:
  - Panel on 127.0.0.1 shows runs and the terminal live (read-only by default).
  - A user comment on a sandbox PR leads to a fix, a reply in the thread and a new push; the run returns to `waiting_review`. Non-allowed authors and own replies are ignored.
  - Merge leaves the run `done`, without worktree and with feedback in Engram.
  - No thread is handled twice, even across a backend restart.
  - The real run needs at most 2 permission prompts.
  - `pnpm test`, `pnpm lint` and `pnpm typecheck` green, including the panel e2e.
- S12 Approved sandbox actions: add a CI workflow (`make check`) to `forge-sandbox`; the user leaves a review comment on sandbox PR #1 when asked.

## Tasks

| ID | Specs | Route | Status | Commit |
| --- | --- | --- | --- | --- |
| T1 | S1, S4 | inline | pending | |
| T2 | S2 | inline | pending | |
| T3 | S5 | inline | pending | |
| T4 | S6, S7 | inline | pending | |
| T5 | S8 | inline | pending | |
| T6 | S9 | inline | pending | |
| T7 | S3 | inline | pending | |
| T8 | S10 | inline | pending | |
| T9 | S10, S11, S12 | inline | pending | |

## Log

- L1 (2026-11-17) User: "si proponlo tu" → plan proposed; L2 User: "Si apruebo el plan" (includes S12 sandbox actions).
