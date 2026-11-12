# Forge

A local software factory that drives Claude Code sessions in tmux. The full definition is in
[`docs/Forge — Project Definition.md`](docs/Forge%20—%20Project%20Definition.md).

Current state: **Phase 0 spike** (see [`docs/spikes/f0.md`](docs/spikes/f0.md)). The backend launches one
pipeline step as a `claude --agent` session in tmux, learns its result only through hooks and the
`report_step` MCP tool, and closes it.

## Requirements

- Node 22+, pnpm 11, tmux, git
- Claude Code 2.1.322 or newer, signed in
- `engram` on the `PATH` (used by the demo planner agent)

## Usage

```bash
pnpm install
pnpm forge serve                                   # backend on 127.0.0.1:7420
pnpm forge run-step --project <path> --task TASK-001 --step plan
pnpm forge status [<step-id>]
tmux -L forge attach -t forge-TASK-001-plan        # watch a step or answer a prompt
```

The project must be a git repository with a `.factory/` folder (see `fixtures/demo-project/`) and must be
trusted once in Claude Code. State lives in `./.forge/` (database, local token, rendered step settings).

## Development

```bash
pnpm test        # unit + integration tests (real tmux, fake claude)
pnpm lint
pnpm typecheck
```
