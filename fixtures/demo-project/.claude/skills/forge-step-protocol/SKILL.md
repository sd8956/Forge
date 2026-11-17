---
name: forge-step-protocol
description: Contract shared by every Forge pipeline step. Read input.md, recall from Engram, do the work, write output.md with its frontmatter, save reusable knowledge to Engram tagged TASK-xxx/<step>, and call report_step until it is accepted. Use at the start and at the end of any Forge step.
---

# Forge step protocol

Every Forge step is one Claude Code session started by the Forge backend. The backend learns the result
only through the `report_step` tool and checks it. It never reads your screen.

## 1. Read the input

Your first prompt names `.factory/runs/<TASK>/<step>/<attempt>/input.md`. Read it first. It holds the goal,
the task, the handoffs of earlier steps, why the step runs again (if it does), the output contract and the
exit criteria. It is the source of truth for this step.

## 2. Recall from Engram

Search Engram (`mem_search`) with 1 to 3 short queries built from the task: the feature area plus
"conventions", "decisions" or "errors". Rules:

- Search **only this project**: never pass `all_projects: true`, never pass another project name.
- Treat results as hints; the repository and `.factory/` win when they disagree.

## 3. Do the work

Produce exactly the files of the output contract, at the paths it gives, plus whatever your step changes
in the code (development and e2e only).

## 4. Write `output.md`

In the output directory, write `output.md`. It **starts with the YAML frontmatter shown in `input.md`**
(`step`, `task`, `attempt`, `status`, `summary`, `artifacts` and the step's own fields), then a body:

- `## Summary`: two to five lines.
- `## Artifacts`: one line per file.
- `## Decisions`: choices the next step must respect.
- `## Open questions`: anything unresolved, or `None`.

`artifacts` lists every file you wrote, relative to the worktree root, including `output.md`.

## 5. Save to Engram

Save (`mem_save`) only knowledge useful to future tasks: decisions, conventions you discovered, errors and
their fix. Not a summary of the step. Every observation:

- goes to this project (the default; never another project),
- ends its content with a line `Ref: <TASK>/<step>`, for example `Ref: TASK-001/plan`.

What is worth saving, by step:

| Step | Save | Example title |
| --- | --- | --- |
| plan | How you read an ambiguous requirement; conventions the plan fixes | "Blank titles count as empty (FR-001)" |
| design | API, error and UI conventions the next tasks must reuse | "API errors are { error } with 4xx" |
| development | Test seams, non-obvious fixes, gotchas of the stack | "Server tests start the app on port 0" |
| security | Confirmed vulnerability patterns and their fix | "Raw Node responses: never reflect query data as HTML" |
| e2e | Selector, timing or evidence gotchas | "Each e2e case needs a fresh server for an empty store" |
| pr | Rarely anything; skip unless the push or gh needed a workaround | — |

Skip this when there is nothing reusable.

## 6. Report

Call `report_step` of the `factory` MCP server with the same `status`, `summary` and `artifacts` as
`output.md`:

- `done`: the exit criteria in `input.md` are met.
- `failed`: the step's own check failed (for example a confirmed high finding, or a failing test case).
- `blocked`: you cannot continue without outside input; say exactly what is missing.

The backend validates the report. If it answers **Report rejected**, fix every listed problem (update
`output.md` too) and call `report_step` again. After a report is accepted, stop: no more tool calls.

## Tools: what runs without asking a person

Every permission prompt stops the pipeline until a person answers it. To avoid them:

- Write and change files **only** with the Write and Edit tools. Never write files with Bash: no
  heredocs (`cat > f <<EOF`), no `>`/`>>` redirects, no `python -c`, `node -e` or `sed -i`.
- Read files with Read, Grep and Glob, not with `cat`, `find` or scripts.
- Run Bash only for the commands your step needs, one simple command per call, with literal values:
  no shell variables, no `$(...)`, no `cd` before a command, no pipes into scripts.
- The backend enforces these rules: a denied tool call comes back with a reason. Do what the reason says
  (for example, use Write instead of a heredoc) and continue; do not retry the same call.

## Never

- Never finish without an accepted `report_step`.
- Never read or list anything outside the worktree, including `~/.claude`.
- Never ask questions in the chat. Nobody reads it.
- Never write outside the worktree.
