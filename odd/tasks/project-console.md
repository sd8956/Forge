# Project console

Objective: a global console in the panel where the person opens Claude Code on the selected project, asks about the project and the state of every task's steps, and delegates fixing what is blocked. Branch `feat/open-project-and-sessions`. Test runner: vitest + Playwright.

## Specs

- S1 User (L1): "Una consola global donde pueda abrir claude y le pueda preguntar cosas del proyecto o por el estado del resto de pasos de las tareas en caso que alguno se bloquee y delegarle que solucione los problemas". Chosen option B: "Claude Code completo en el proyecto, más las herramientas de Forge".
- S2 Session: one per project, in the project's checkout, the person's own Claude Code (their settings apply), `--permission-mode default` so every command or edit asks the person in the terminal; bypass locked; the API key setting applies.
- S3 Forge tools (`factory` MCP at `/mcp/console/<project>`): queue and plan status, list runs, one run's steps/events/threads/handoff paths, which step sessions are live (and their worktrees), resume (optionally merging the base) and cancel a run, start a task, pause and resume the queue.
- S4 Rule given to the session: check live steps before editing a task's worktree, and change run or queue state through the Forge tools, never by hand.
- S5 Panel: a "Console" button in the sidebar opens a drawer on every page with the console's terminal (start, stop, type).

## Tasks

| ID | Specs | Route | Status | Commit |
| --- | --- | --- | --- | --- |
| T1 | S2, S3, S4 | inline | pending | |
| T2 | S5 | inline | pending | |

## Log

- L1 (2026-11-25) User asked for the console; offered A (Forge tools only) or B (full Claude Code + Forge tools). User: "vamos con B".
