# ADR 0015 — A code_review step reviews the diff before the PR, at a depth the backend decides

- Status: accepted
- Date: 2026-11-26
- Deviates from: "Pipeline" in `docs/Forge — Project Definition.md` (plan, design, development, security, e2e,
  pr). Extends ADR 0004 (the backend validates every step report).

## Context

Between development and the PR, Forge checks security (tools and the threat model) and behavior (e2e against the
acceptance criteria). Nothing reads the change itself for logic errors, tests that cannot fail, swallowed errors
or broken contracts; that waited for the person reviewing the PR. gentle-ai reviews every change through up to
four lenses (risk, resilience, readability, reliability) with a refuter that tries to disprove blocking findings
before they block, and picks the lenses from what the change touches, not from its size. The person accepted
bringing that into the pipeline: "Revisores por lente más un refutador. La profundidad la decide el backend
según el diff."

## Decision

- **New step kind `code_review`**, between `e2e` and `pr`, and in `review.then` before `pr`, so a review round
  re-reviews the fix. The id `review` was taken by the board column, the run mode and the review loop.
- **The backend decides the depth** from `git diff <merge base>..HEAD` of the task branch
  (`src/domain/review-depth.ts`, pure and unit-tested), never the agent:
  - `passive`, no lens: every changed path is documentation, an image, `docs/**` or `.factory/**`.
  - `high`, all four lenses: a non-test code path names sensitive code (auth, login, session, token, password,
    secret, permission, role, payment, webhook, crypto, migration, upload), or an added line hits a dangerous
    sink (`eval(`, `new Function(`, `child_process`, `exec(` with interpolation, `innerHTML =`,
    `dangerouslySetInnerHTML`, `document.write(`, SQL built from strings).
  - `medium`, `reliability` only: any other code change.
  - Size and file count are not inputs: a one-line change to a login check needs more review than a rename of
    two hundred files. A diff that cannot be read gets every lens.
  The depth is written into `input.md` ("Review depth") and recomputed the same way at report time, since the
  step never commits.
- **One session with subagents.** Forge runs one Claude Code session per step, so the step agent
  (`forge-code-reviewer`) launches one read-only `forge-review-<lens>` subagent per lens in parallel, then one
  `forge-review-refuter` subagent with every introduced BLOCKER or CRITICAL finding in a single batch. The step
  agent and its subagents never change code.
- **Contract and exit check** (`review_clean`): `output.md` lists the `lenses` reviewed and a `findings` ledger
  (lens, severity BLOCKER/CRITICAL/WARNING/SUGGESTION, location, claim, proof, origin, refuter verdict). The
  backend refuses `done` when the lenses differ from the assigned ones or an introduced BLOCKER or CRITICAL
  finding was not refuted, and rejects such a finding without a refuter verdict. A failed review goes back to
  development (`on_fail`, three attempts) with `code-review.md` as the reason.

## Consequences

- Every task pays for one more opus session before its PR; a `high` diff pays for four lens subagents and a
  refuter on top. Passive changes (docs, handoffs) cost one short session that reports an empty ledger.
- The depth rule is deterministic and visible in `input.md` and the run's `review_depth` event, so a person can
  see why a change got four lenses. Its token lists are heuristics: they miss sensitive code with neutral names
  and flag names like `tokens.js` that may be harmless; both err toward reviewing more.
- Findings are agent-reported: the backend checks their shape and the blocking rule, not that a proof is true.
  The refuter is the guard against unproven blockers; WARNING and SUGGESTION findings never block.
