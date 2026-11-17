# Test strategy — demo-project

| Level | Tool | Where | Run with |
| --- | --- | --- | --- |
| Unit | `node:test` + `node:assert` | `test/*.test.js` | `make unit` (part of `make check`) |
| End to end (web) | Playwright (Chromium) | `e2e/*.spec.js` | `make e2e`; Playwright starts the app with `make up` |

## Evidence (mandatory for every E2E case)

- One screenshot per test step, with `stepShot(page, "TC-xx", "<step>")` from `e2e/evidence.js`.
- Video and trace for every test (configured in `playwright.config.js`).
- Run with `EVIDENCE_DIR=<step output dir>/evidence` so everything lands in the step's handoff.

## Conventions

- Each E2E test title starts with its case id: `test("TC-01 add a todo", ...)`.
- E2E specs are committed; they are the regression suite CI repeats.
- Seed data: none. Each test starts from a fresh server (in-memory store).
