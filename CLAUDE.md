# Forge — repository conventions

Forge is a local software factory that drives Claude Code sessions in tmux. Source of truth:
`docs/Forge — Project Definition.md`. When an ADR in `docs/adr/` contradicts it, the ADR wins.

## Layout

- `packages/shared`: types and zod schemas shared by backend and (later) web.
- `packages/backend`: Fastify backend, SQLite (Drizzle), tmux runner, MCP `factory` server, CLI.
  - `src/domain/`: pure logic (state machines, decisions). No I/O. Unit-tested.
  - `src/db/`: schema, migrations (`pnpm --filter @forge/backend db:generate`), stores.
  - `src/runner/`: tmux and git worktrees.
  - `src/steps/`, `src/runs/`: services that own step and run lifecycles.
- `fixtures/demo-project/`: target project used by tests and real runs (`.factory/`, `.claude/`).
- `docs/adr/`: one ADR per deviation from the definition. `docs/spikes/`, `docs/runs/`: phase reports.
- `odd/tasks/`: feature documents (specs, tasks, log) for multi-session work.

## Rules

- Code, identifiers, commits and docs in English. Conventional Commits, small work units. No AI attribution.
- TypeScript strict; no `any`; zod at every boundary (HTTP bodies, hook payloads, YAML, frontmatter).
- State changes only through the transition tables in `src/domain/`; never update `status` directly.
- Nothing reads the tmux screen. Step results arrive only through `report_step` and hooks.
- The backend listens on `127.0.0.1` only and every route but `/health` needs the local token.
- Steps never run with `bypassPermissions` or `auto`; the runner passes `--permission-mode` from the agent.
- Tests: unit for `src/domain`, integration with the fake `claude` (`packages/backend/test/fake-claude/`)
  in real tmux on a throwaway socket. Scratch state goes in `mktemp -d`, never in the repo.

## Commands

```bash
pnpm test && pnpm lint && pnpm typecheck
pnpm forge serve
pnpm forge run-task --project <path> --task TASK-001
```
