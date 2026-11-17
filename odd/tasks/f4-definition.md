# F4 — Definition panel

Objective: from an empty repo and an idea, run the 6 definition stages, each behind a person's gate, and end with a valid `.factory/` the Execution panel can run. Branch `feat/f4-definition`. Delivery: work-unit commits; push/PR decided by the user. Test runner: vitest + Playwright.

## Specs

- S1 Stages as sessions: intake, requirements, architecture (with threat model), test strategy, UI design, backlog; each a Claude Code session with its own agent, reusing the step machinery (tmux, hooks, guard, Stop hook) without a run, ending with `report_stage`.
- S2 `definition_stage` table with a transition table: `pending → running → in_review → approved`, or `changes_requested → running`.
- S3 Gate: "Approve and continue" approves the stage and launches the next; "Request changes" relaunches the same stage with the person's feedback and its previous output.
- S4 Backend validation: `requirements.md` FRs with IDs and Given/When/Then, measurable NFRs; `threat-model.md` STRIDE per component; backlog tasks cover existing FRs with criteria, size and acyclic dependencies; `tokens.json` valid JSON; prototype exists.
- S5 Where it writes: stages work in a worktree on branch `forge/definition` and may only write inside `.factory/` (guard). Each approval commits the stage; approving the backlog opens a "Project definition" PR the person merges.
- S6 Template: agents, skills, `pipeline.yaml` and step settings are copied by Forge from a template (the `demo-project` fixture), never written by the LLM.
- S7 Small F3 pending item: `orchestrator_control` is not recorded on every panel reconnect.
- S8 Panel per PDF page 4: "Definition" sidebar item, progress of the 6 stages, `.factory/` tree with status, session terminal with "Ask for a change…", tabs with rendered documents (`react-markdown`, no raw HTML), prototype in an isolated iframe (`sandbox` without `allow-same-origin`, CSP) approved screen by screen, gate bar with "Request changes" and "Approve and continue".
- S9 Tests: unit (transition table, validators); integration with fake claude (6 stages end to end, Request changes with feedback, invalid output rejected in `report_stage`, writes outside `.factory/` rejected, restart mid-stage); Playwright (stage progress, tabs, prototype iframe, gate); real run: a small new project from scratch in `sd8956/forge-definition-sandbox` through the 6 stages to the definition PR; after the merge the orchestrator plans and one task reaches its PR (~15 sessions).
- S10 Exit gate:
  - From an empty repo the 6 stages produce a `.factory/` that passes backend validation, and none advances without the person's approval.
  - "Request changes" fixes the same stage without losing what was approved.
  - The prototype shows in the iframe and is approved screen by screen.
  - No definition session writes outside `.factory/`.
  - After the definition merge, the Execution panel runs one task of that backlog to its PR.
  - `test`, `lint`, `typecheck` and e2e green.

## Tasks

| ID | Specs | Route | Status | Commit |
| --- | --- | --- | --- | --- |
| T1 | S2, S4 | inline | done | e43962a |
| T2 | S1, S3, S5, S6 | inline | done | ea7af28, c2d26b8 |
| T3 | S1 | inline | done | ea7af28 |
| T4 | S7 | inline | done | 1cac540 |
| T5 | S8 | inline | done | a591c23 |
| T6 | S9 | inline | done | ea7af28, a591c23 |
| T7 | S9, S10 | inline | in progress | |

## Log

- L1 (2026-11-17) User: "mezclado que sigue?" → F4 plan proposed. L2 User: "si apruebo el plan, ya cree el repo https://github.com/sd8956/forge-definition-sandbox".
- L3 T1-T6 done inline. Findings: a `description` with ": " broke an agent's YAML frontmatter (fixture test now parses every agent); the hand-written sandbox showed a task may cover only an NFR; an NFR may be measurable by a universal rule; a new repo has no base branch on GitHub, so Forge pushes it before the PR (c2d26b8). 367 tests + 11 Playwright green. T7: cloned sd8956/forge-definition-sandbox into .sandbox/forge-definition-sandbox (empty, HEAD set to main), backend restarted.
