# Forge

A local software factory that drives Claude Code sessions in tmux. The full definition is in
[`docs/Forge — Project Definition.md`](docs/Forge%20—%20Project%20Definition.md).

Current state: **Phase 1** (see [`docs/runs/f1.md`](docs/runs/f1.md)). One backlog task runs the whole
pipeline (plan → design → development → security → e2e → pr) as separate `claude --agent` sessions in
tmux and ends in `waiting_review` with a pull request. The backend learns each result only through hooks
and the `report_step` MCP tool, validates it, and decides the next step.

## Requirements

- Node 22+, pnpm 11, tmux, git
- Claude Code 2.1.322 or newer, signed in
- `engram` on the `PATH`, and `engram serve` for the memory view in `status`
- For the demo project's security and E2E steps: `semgrep`, `gitleaks`, `osv-scanner`, Playwright Chromium, `gh`

## Usage

```bash
pnpm install
pnpm forge serve                                   # backend on 127.0.0.1:7420
pnpm forge run-task --project <path> --task TASK-001
pnpm forge status [<run-id>]
pnpm forge resume <run-id>                         # after a person fixed what needs_human asked for
pnpm forge cancel <run-id>
tmux -L forge attach -t forge-TASK-001-plan-1      # watch a step or answer a prompt
```

The project must be a git repository with a `.factory/` folder and a `pipeline.yaml` (see
`fixtures/demo-project/`), and must be trusted once in Claude Code. State lives in `./.forge/` (database, local token, rendered step settings).

## Development

```bash
pnpm test        # unit + integration tests (real tmux, fake claude)
pnpm lint
pnpm typecheck
```
