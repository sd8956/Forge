---
name: maestro-evidence
description: How the Forge e2e step turns test cases of a mobile app (Android or iOS) into committed Maestro flows and runs them with evidence, one screenshot per step under the step's evidence directory. Use in the e2e step when project.yaml platforms include mobile, android or ios.
---

# Maestro with evidence

Use this skill instead of `playwright-evidence` for the mobile platforms of `.factory/project.yaml`. Web cases of
the same project still use `playwright-evidence`.

## Setup

- The Maestro CLI, Java and an Android emulator (or an iOS simulator on macOS) are installed on the machine; do not
  install them. `make e2e` boots what it needs, builds and installs the app, then runs the flows; read the Makefile
  and `.factory/test-strategy.md` before changing anything.
- If `maestro --version` fails or no device is available, report `blocked` and say which tool is missing.

## Flows

- One flow per end-to-end `TC-xx` in `.maestro/`, named after the case: `.maestro/TC-01-add-task.yaml`.
- Start each flow with `appId` from the test strategy, then `launchApp` with `clearState: true`.
- After every user action, take a screenshot into the case's evidence folder:

  ```yaml
  - tapOn: "Add"
  - takeScreenshot: ${EVIDENCE_DIR}/TC-01/02-add-task
  ```

  Number the files in order (`01-…`, `02-…`). Maestro adds `.png`.
- Worst-case data: for every case whose screen shows a list or text a user typed, also capture it with data
  chosen to break the layout: empty, one item, very long names, and many rows. Change the data, not the
  component; name the shots `worst-<what>`. A screen that breaks fails the case.
- Assert the exact texts of the test plan with `assertVisible` (and `assertNotVisible` for removals). Prefer
  accessibility labels and ids over coordinates. No fixed waits: use `extendedWaitUntil` when something is slow.

## Run

```bash
make e2e EVIDENCE_DIR=<out>/evidence
```

Type the output directory literally (from `input.md`). The `e2e` target passes it to Maestro as
`maestro test .maestro --env EVIDENCE_DIR=<out>/evidence --format junit --output <out>/evidence/maestro-junit.xml`.

## After the run

- Commit the flows (`git add .maestro && git commit -m "test(e2e): ..."`). Never commit `.factory/runs/`.
- Read `maestro-junit.xml` with the Read tool for each case's result and duration; never guess a result.
- Write `test-report.md` as for Playwright: one row per TC with result, duration and evidence files; for failures,
  the assertion that failed and the screenshot that shows it.
- Write `<out>/evidence/manifest.json` with the `evidence-manifest` skill. A Maestro case's `files` are its step
  screenshots (`TC-01/01-open-app.png`, ...) plus `maestro-junit.xml`.
- If any case fails, status is `failed` and the summary names the failing cases.
