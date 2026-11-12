# F0 spike — drive Claude Code in tmux without reading the screen

Objective: Phase 0 of `docs/Forge — Project Definition.md`. Branch `feat/f0-spike`. Delivery: work-unit commits, push/PR decided by the user. Test runner: vitest (`pnpm test`).

## Specs

- S1 Runner: "crea el worktree de la tarea, escribe el `input.md` del paso, lanza la sesión con `--agent`, `--session-id` y los settings del paso, y la cierra con `tmux kill-session` al recibir el reporte."
- S2 Hook receiver: "endpoints HTTP para Stop, Notification y SessionEnd que registran eventos y aplican la lógica de bloqueo del Stop." Stop: "si no hubo `report_step` para ese `session_id`, devuelve `decision: block` con la instrucción de reportar. Respeta `stop_hook_active` y un máximo de bloqueos."
- S3 MCP server `factory`: "una sola herramienta por ahora: `report_step(status: done|blocked|failed, summary, artifacts[])`, validada con zod."
- S4 State machine: "`queued → running → (done | blocked | failed | needs_human)`, con las transiciones definidas como tabla y probadas de forma unitaria. Incluye timeout de pared."
- S5 Reconciliation: "si el backend se reinicia, cruza la base con `tmux ls` y retoma o marca los pasos huérfanos."
- S6 CLI: "`pnpm forge run-step --project <ruta> --task TASK-001 --step plan`."
- S7 Fixture: "`fixtures/demo-project/` con un `.factory/` mínimo escrito a mano (project.yaml, requirements.md, una tarea en backlog/, steps/planner.settings.json), más `.claude/agents/forge-planner.md` y la skill `forge-step-protocol`".
- S8 Tests: unit tests for the state machine and Stop logic; integration tests with a fake `claude` binary; "Una ejecución manual con el `claude` real, documentada en `docs/spikes/f0.md`."
- S9 Platform constraints: Node 22 + strict TS, pnpm workspaces (`packages/backend`, `packages/shared`), Fastify on `127.0.0.1` with a local token header, SQLite via Drizzle (better-sqlite3) with only `step` and `event` tables. Never the OAuth token, never `--dangerously-skip-permissions`, never scrape the TUI.
- S10 Exit gate:
  - "Con el `claude` real y `--agent forge-planner`, un paso termina y el backend lo marca `done` solo vía `report_step`, sin leer la pantalla."
  - "Si el agente intenta detenerse sin reportar, el hook Stop lo obliga a reportar."
  - "Un permiso pendiente pasa el paso a `needs_human` vía Notification."
  - "La sesión de tmux se cierra sola y queda registrado el `transcript_path`."
  - "Matar y reiniciar el backend con un paso en curso no pierde ni duplica el paso."
  - "`pnpm test`, `pnpm lint` y `pnpm typecheck` en verde."
- S11 Every deviation from `docs/` is recorded as an ADR; final summary in `docs/spikes/f0.md`.

## Tasks

| ID | Specs | Route | Status | Commit |
| --- | --- | --- | --- | --- |
| T0 | S9 | inline | done | 8d14e25, bf656ae (CI) |
| T1 | S11 | inline | done | bf656ae (ADRs 0001-0003) |
| T2 | S3, S9 | inline | done | f9561e9 |
| T3 | S4 | inline | done | 1b5bb4d |
| T4 | S2 | inline | done | 570d0b3, c96440b |
| T5 | S9 | inline | done | c0dd4f1 |
| T6 | S2 | inline | done | c96440b |
| T7 | S3 | inline | done | c96440b |
| T8 | S1, S4 | inline | done | c4b3113, c96440b, 9e0ccc4 |
| T9 | S5 | inline | done | c96440b, c14e2e7 |
| T10 | S6 | inline | done | 8fd8607 |
| T11 | S8 | inline | done | c14e2e7 |
| T12 | S7 | inline | done | e45a1d7, latest fixture fix |
| T13 | S8, S10, S11 | inline | done | docs/spikes/f0.md |

Route evidence: no Writer trigger (units depend on each other); all inline.

## Log

- L1 (2026-11-11) Original request: Forge Phase 0 spike prompt (pasted), scope "solo la Fase 0 (spike técnico)"; deliverables S1–S8, exit gate S10, work style: "Commits pequeños con Conventional Commits, en la rama `feat/f0-spike`. Cada desviación de `docs/` se registra como ADR." "Pregúntame antes de instalar algo global o de tocar archivos fuera del repo."
- L2 (2026-11-11) User: "ya cree este repo https://github.com/sd8956/Forge para este proyecto, apruebo el plan". Plan approved, including writing per-worktree trust to `~/.claude.json` only if worktrees do not inherit trust.
- L3 Probes on Claude Code 2.1.322: agent `mcpServers` load with `--agent` only in trusted folders; worktrees under a trusted repo inherit trust (no `~/.claude.json` writes needed); `${VAR}` is NOT expanded in agent frontmatter `mcpServers`; `--mcp-config` loads regardless of trust; agent `tools:` must list `mcp__<server>`; `SessionEnd` fires on `tmux kill-session` (`reason: other`) and on `/exit` (`prompt_input_exit`).
- L4 Real-run findings: agent `permissionMode` ignored as main thread (CLI default `auto`), fixed by passing `--permission-mode` from the agent file; in `acceptEdits` MCP tools need `permissions.allow`; agent refuses drill instructions from task data; Engram search used `all_projects: true`; task worktrees freeze step templates at creation; `tsx` CLI child survives SIGKILL (use `node --import tsx`).
- L5 Exit gate passed: 6 real runs documented in `docs/spikes/f0.md`; 52 tests green; lint and typecheck green.
- Next: user decides push/PR; Phase 1 design changes listed in `docs/spikes/f0.md`.
