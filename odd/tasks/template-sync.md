# Template sync — keep projects on the latest Forge files

Objective: projects get Forge's latest agents, skills, pipeline and step settings automatically, through a PR the person merges, without overwriting what a project customized. Branch `feat/post-f5`. Delivery: work-unit commits; push/PR decided by the user. Test runner: vitest + Playwright.

## Specs

- S1 Detect: for each registered project with a GitHub remote, compare its Forge files (the template paths: `.claude/agents`, `.claude/skills` except `repo-conventions`, `.factory/pipeline.yaml`, `.factory/steps`, `.factory/orchestrator.settings.json`, `.semgrep`) with the template.
- S2 Never overwrite customizations: a project file that matches some past version of the template file (Forge's git history, with the agents' Engram project name normalized) is an untouched copy and is updated; a file that matches none is listed in the PR as customized and left alone; files new in the template are added; files removed from the template are left.
- S3 Deliver by PR: changes go to branch `forge/template-update` in a worktree from `origin/<base>` (the person's checkout is untouched), pushed, with a PR "chore: update Forge files" listing updated, added and customized files. An open PR on that branch gets a new commit instead of a second PR. The person merges.
- S4 When: at backend start and every 6 hours, plus "Check now" in the project's Settings and `forge template sync --project <path>`.
- S5 User's words (L1): "yo creo que lo ideal es la 2 que se actualice el proyecto automaticamente para tener lo ultimo siempre".

## Tasks

| ID | Specs | Route | Status | Commit |
| --- | --- | --- | --- | --- |
| T1 | S1, S2 | inline | done | dc17759 |
| T2 | S3, S4 | inline | done | c02b9d6, da411af |
| T3 | S4 | inline | done | 8d418b0 |

## Log

- L1 (2026-11-25) Real conflict round on daily-tasks PR #4 worked (MERGEABLE CLEAN) but no PR comment: the project's copy of pr-thread-reply predates the conflict section. Options offered: (1) backend posts replies for conflict/check threads, (2) update the template in existing projects. User: "yo creo que lo ideal es la 2 que se actualice el proyecto automaticamente para tener lo ultimo siempre".
- L2 Done. Real: on service restart, sync opened sd8956/forge-sandbox#7 (1 updated, 8 added, security-scan left alone as customized) and sd8956/forge-definition-sandbox#5 (5 updated incl. pr-thread-reply with the conflict section, 1 added). Bug found: git remote get-url applies insteadOf and hid the GitHub slug (da411af). 394 tests + 13 Playwright green; the e2e no longer reaches the network.
