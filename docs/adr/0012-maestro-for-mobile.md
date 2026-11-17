# ADR 0012 — Maestro for mobile projects

- Status: accepted
- Date: 2026-11-17
- Phase: F5
- Makes concrete: "Tool per platform: … Maestro for mobile" and the v2 row of the open decisions ("Web only with
  Playwright; Maestro in v2"), with the `maestro-evidence` skill named for the tester.

## Decision

- A project is mobile when `.factory/project.yaml` `platforms` includes `mobile`, `android` or `ios`. For such a project
  the test strategy stage must plan Maestro (the backend rejects a `test-strategy.md` that does not name it), and the
  stage is told to name the app id, the device and how `make e2e` boots it.
- The e2e step (`forge-tester`) gets the `maestro-evidence` skill next to `playwright-evidence`: one committed flow per
  end-to-end case in `.maestro/`, `takeScreenshot` into `${EVIDENCE_DIR}/<TC>/` after every action, a JUnit report as the
  source of each result, and the same `evidence/manifest.json` the backend already checks. Web cases of a mixed project
  keep Playwright.
- Forge installs nothing: Maestro, Java and the emulator are the machine's, and the step reports `blocked` naming what is
  missing.

## Consequences

- Verified with tests only until Maestro and an emulator are installed; installing them is a global change the person
  approves first.
