---
name: forge-step-protocol
description: Contract shared by every Forge pipeline step. Read input.md, recall from Engram, do the work, write output.md, save reusable knowledge to Engram and call report_step exactly once. Use at the start and at the end of any Forge step.
---

# Forge step protocol

Every Forge step is one Claude Code session started by the Forge backend. The backend learns the
result only through the `report_step` tool. It never reads your screen, so anything you do not report
is lost.

## 1. Read the input

Your first prompt names `.factory/runs/<TASK>/<step>/input.md`. Read it first. It holds the goal, the
inputs, the output contract and the exit criteria. It is the source of truth for this step; this skill
only says how to run it.

## 2. Recall from Engram

Search Engram (`mem_search`) with 1 to 3 short queries built from the task context, for example the
feature area plus "conventions" or "decisions". Treat results as hints: the repository and `.factory/`
win when they disagree.

## 3. Do the work

Produce exactly the files of the output contract, at the paths it gives.

## 4. Write `output.md`

In the step's run directory, write `output.md` with these sections:

- `## Summary`: two to five lines on what you produced.
- `## Artifacts`: one line per file, path relative to the worktree root.
- `## Decisions`: choices the next step must respect.
- `## Open questions`: anything unresolved, or `None`.

## 5. Save to Engram

Save only knowledge useful to future tasks: decisions, conventions you discovered, errors and their
fix. Do not save a summary of this step. Put `<TASK>/<step>` (for example `TASK-001/plan`) in the
content for traceability. Skip this when there is nothing reusable.

## 6. Report

Call `report_step` of the `factory` MCP server exactly once:

- `status`: `done` when the exit criteria are met; `blocked` when you cannot continue without outside
  input (say what is missing); `failed` when the step cannot be completed.
- `summary`: the same summary as `output.md`.
- `artifacts`: the paths you wrote, relative to the worktree root, including `output.md`.

After `report_step` answers, stop. Do not call more tools; the backend closes the session.

## Never

- Never finish without calling `report_step`. If you are stuck, report `blocked`.
- Never ask questions in the chat. Nobody reads it.
- Never write outside the worktree.
