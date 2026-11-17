# ADR 0007 — Execution panel access, PR watcher and review loop

- Status: accepted
- Date: 2026-11-17
- Phase: F2
- Deviates from / makes concrete: "Panel 2 — Execution", "PR lifecycle and review handling" and the panel security NFR.

## Decision

- **Panel access.** `forge serve` and `forge login` print a one-time login link. Opening it sets an
  `HttpOnly; SameSite=Strict` cookie signed with HMAC from the local token, so it survives restarts and dies
  when the token changes. Every request must target a local `Host` (DNS rebinding). Cookie requests that change
  state, and every WebSocket, must come from the panel's own `Origin`. The CLI, hooks and MCP keep the token header.
- **Live data.** Every `event` insert is published on `/ws/events`; the panel refetches instead of patching state.
- **Terminal.** `/ws/terminal/:stepId` streams `tmux attach -r` through node-pty. `mode=control` forwards
  keystrokes and records `operator_control`. The backend still never reads the screen to decide anything.
- **Projects.** A `project` table (definition's data model) is filled from `.factory/project.yaml` when a run starts
  or from the panel's "Add project" form. `review.allowed_authors` decides whose feedback counts.
- **PR watcher.** Polls with the `gh` CLI (`gh pr view` plus `gh api --paginate --jq`), so it reuses the person's
  GitHub login. A pure `diffSnapshot` turns a snapshot into new threads; `pr_thread` is unique per (run, external id),
  so nothing is handled twice, across restarts too. Draft (pending) reviews are invisible to the API and ignored.
- **Own replies.** Replies posted by review_fix end with `<!-- forge:reply -->`; the watcher ignores marked comments.
  They come from the same GitHub account as the reviewer, so the author alone cannot tell them apart.
- **Review loop.** `pipeline.yaml` gains `review: { max_rounds, fix, then }`. A round runs review_fix, then the
  re-verification steps; in review mode an `on_fail.goto` outside the loop (development) maps to review_fix.
  Comment bodies enter `input.md` fenced and labelled as untrusted data.
- **Merge.** On merge the backend archives `.factory/runs/<TASK>` into `<FORGE_HOME>/archive/<run>`, removes the
  worktree, saves the handled feedback to Engram (`TASK-xxx/review`, through a backend-owned Engram session), and
  only then marks the run `done`. Closing a PR unmerged cancels the run.

## Consequences

- A task worktree created before an agent existed cannot run that step (agents load from the worktree; F0 finding).
  A launch preflight turns this into `needs_human` with `forge resume --merge-base` as the fix.
- Posting replies is allowed only through two exact `gh api -X POST` shapes (thread replies and PR comments), verified
  with a real probe; any other API write still asks a person.
