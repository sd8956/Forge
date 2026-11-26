---
name: test-plan-authoring
description: How to write a Forge test plan. Cases TC-xx linked to FR ids and acceptance criteria AC-n, written from the requirements before any code, with a coverage table. Use in the plan step.
---

# Test plan authoring

Write `test-plan.md` from `.factory/requirements.md` and the task's acceptance criteria, before any code
exists. Tests describe the behavior the user asked for, not an implementation.

## Format

```markdown
# Test plan — TASK-001 <title>

## Coverage

| AC | FR | Cases |
| --- | --- | --- |
| AC-1 | FR-001 | TC-01, TC-02 |

## Cases

### TC-01 — <short behavior>
- Covers: FR-001, AC-1
- Type: e2e | unit | integration
- Steps: numbered, concrete (exact input text, exact button)
- Expected: observable result (exact text, status code, list order)
```

## Rules

- Every `AC-n` of the task appears in the coverage table and in at least one case. The backend checks it.
- Number cases `TC-01`, `TC-02`, ... in order. Never reuse a number.
- Each case checks one rule and names every observable effect of it, taken from the requirements: the
  exact text, the status or exit code, and that rejected input leaves stored data unchanged.
- `unit` and `integration` cases become tests written first in the development step; the backend checks
  that each one has red/green evidence. Keep them small enough to fail for one reason.
- Prefer `e2e` for anything a user does on the page (they become Playwright specs with evidence) and
  `unit` for validation rules and pure logic.
- Include the negative path the criteria name (empty input, error message, no change to the list).
- Do not invent requirements. If an AC is ambiguous, write the case with the reading you chose and put the
  ambiguity under `## Open questions` in `output.md`.
