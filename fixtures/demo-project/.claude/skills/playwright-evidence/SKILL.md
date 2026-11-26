---
name: playwright-evidence
description: How the Forge e2e step turns test cases into committed Playwright specs and runs them with evidence. make up via Playwright webServer, one screenshot per step, video and trace, all under the step's evidence directory. Use in the e2e step.
---

# Playwright with evidence

## Setup

1. `npm install` (installs `@playwright/test` from the lockfile). Chromium is already installed on the
   machine; do not run `npx playwright install`.
2. The app is started by Playwright itself: `playwright.config.js` runs `make up` as its `webServer`.
   Do not start the server by hand.

## Specs

- One spec file per feature in `e2e/`, for example `e2e/todos.spec.js`.
- One `test` per end-to-end `TC-xx`. The title starts with the id: `test("TC-01 add a todo", ...)`.
- Wrap each user action in `test.step(...)` and call `stepShot(page, "TC-01", "<step-name>")` from
  `e2e/evidence.js` after each step. It returns the screenshot path relative to `EVIDENCE_DIR`.
- Assert the exact texts of the test plan with web-first assertions (`await expect(locator).toHaveText(...)`).
- Worst-case data: for every case whose screen shows a list or text a user typed, also capture it with
  data chosen to break the layout, not to look good: empty, one item, very long names, and many rows
  (1,000 when the screen lists items). Change the data, not the component; name the shots
  `worst-<what>` (for example `stepShot(page, "TC-02", "worst-1000-rows")`). A screen that breaks fails the case.
- Prefer role and label locators (`getByRole`, `getByLabel`). No fixed sleeps.

## Run

```bash
make e2e EVIDENCE_DIR=<out>/evidence
```

Type the output directory literally (from `input.md`).

This writes screenshots under `<out>/evidence/<TC-id>/`, video and trace under
`<out>/evidence/playwright/`, and `<out>/evidence/results.json`.

## After the run

- Commit the specs (`git add e2e && git commit -m "test(e2e): ..."`). Never commit `test-results/` or
  `.factory/runs/`.
- Write `test-report.md`: one row per TC with result, duration and evidence files; for failures, the
  assertion that failed and the screenshot that shows it.
- Write the manifest with the `evidence-manifest` skill.
- If any case fails, status is `failed` and the summary names the failing cases.
