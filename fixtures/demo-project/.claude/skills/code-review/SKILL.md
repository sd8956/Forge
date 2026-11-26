---
name: code-review
description: Forge code_review step procedure. Review the task diff through the lenses the backend assigned, one read-only subagent per lens in parallel, send every introduced BLOCKER or CRITICAL finding to one refuter, and write code-review.md and the findings ledger. Introduced blockers the refuter does not refute mean failed.
---

# Code review

Scope: `git diff <base-commit>..HEAD` of the task branch (the base commit is in `input.md`), against the task's
acceptance criteria. You coordinate; you do not review and you never change code.

## 1. Depth

"Review depth" in `input.md` names the tier and the lenses. The backend chose them from the diff:

- `passive` (only docs, assets, Forge handoffs): no lens.
- `medium` (ordinary code): `reliability`.
- `high` (a sensitive path such as auth, session, payment or migration, or a dangerous sink such as `eval`,
  `innerHTML =` or SQL built from strings): `risk`, `resilience`, `readability`, `reliability`.

Review exactly those lenses. With no lens, skip to step 4 with an empty ledger and report `done`.

## 2. Lenses, in parallel

In one message, launch one `forge-review-<lens>` subagent per lens with the Agent tool. Each prompt gives the
base commit, the task file, the list of changed files (`git diff --stat <base-commit>..HEAD`) and asks for the
YAML list the subagent returns. Wait for all of them.

Merge: drop duplicates (same location and claim; keep the higher severity), then number the rest `F-1`, `F-2`, ...
Drop any finding without a `proof`.

## 3. Refuter, once

Send every finding with severity BLOCKER or CRITICAL and `origin: introduced` to one `forge-review-refuter`
subagent, in a single batch. Copy its verdict into `refuter`: `corroborated`, `refuted` or `inconclusive`.
A finding it returned no verdict for is `inconclusive`. Every other finding gets `refuter: not_needed`.

## 4. `code-review.md`

```markdown
# Code review — <TASK> (attempt n)

Base: <sha> · Head: <sha> · Tier: <tier> · Lenses: <lenses or none>

| ID | Lens | Severity | Location | Claim | Proof | Origin | Refuter |
| --- | --- | --- | --- | --- | --- | --- | --- |

## For development (only when failed)
For each blocking finding: what to change, and the test that must fail before the fix.

## For the PR
WARNING and SUGGESTION findings the task introduced, one line each.

## Follow-ups
Pre-existing findings, one line each, for a separate task.
```

## 5. Ledger in `output.md`

```yaml
lenses: [reliability]            # exactly the assigned lenses; [] when none
findings:                        # [] when none
  - id: F-1
    lens: reliability
    severity: CRITICAL           # BLOCKER | CRITICAL | WARNING | SUGGESTION
    location: src/todos.js:18
    claim: An empty title is stored because the check uses `title === undefined`.
    proof: "node --test test/todos.test.js: 'rejects an empty title' passes only because it posts no body"
    origin: introduced           # introduced | pre-existing
    refuter: corroborated        # corroborated | refuted | inconclusive | not_needed
```

## 6. Blocking rule

- A finding blocks when its severity is BLOCKER or CRITICAL, its origin is `introduced` and its refuter verdict is
  not `refuted`. Any blocking finding: status `failed`, and the summary says what development must change.
  The backend refuses `done` in that case and sends the task back to development.
- BLOCKER or CRITICAL findings the task introduced never have `refuter: not_needed`; the backend rejects that.
- Otherwise `done`. WARNING and SUGGESTION findings never block; pre-existing findings never block.
