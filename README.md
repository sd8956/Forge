# Forge

A local software factory that drives Claude Code sessions in tmux. The full definition is in
[`docs/Forge — Project Definition.md`](docs/Forge%20—%20Project%20Definition.md).

Current state: **Phase 2** (see [`docs/runs/f2.md`](docs/runs/f2.md)): a local web panel, a PR watcher
and a review loop on top of the Phase 1 pipeline (see [`docs/runs/f1.md`](docs/runs/f1.md)). One backlog task runs the whole
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
pnpm build:web                                     # build the panel once
pnpm forge serve                                   # backend + panel on 127.0.0.1:7420, prints a login link
pnpm forge login                                   # a new one-time panel login link
pnpm forge run-task --project <path> --task TASK-001
pnpm forge status [<run-id>]
pnpm forge resume <run-id>                         # after a person fixed what needs_human asked for
pnpm forge cancel <run-id>
pnpm forge service install                         # start Forge at login (systemd user service, Linux)
tmux -L forge attach -t forge-TASK-001-plan-1      # watch a step or answer a prompt
```

`forge service install` writes `~/.config/systemd/user/forge.service` (it captures your current `PATH`, so run it
from a shell where `claude`, `gh`, `tmux` and `engram` resolve) and starts it; `forge service uninstall` removes it,
and `journalctl --user -u forge` shows its log. Restarting the service stops only the backend: step sessions keep
running in tmux and the backend picks them up again. To start Forge at boot without logging in, also run
`loginctl enable-linger $USER`.

The project must be a git repository with a `.factory/` folder and a `pipeline.yaml` (see
`fixtures/demo-project/`), and must be trusted once in Claude Code. A task whose `Depends on:` tasks are not
merged into the base branch is refused. `status` shows, per step, the permission prompts a person answered and
the tool calls the backend's guard denied (ADR 0006). State lives in `./.forge/` (database, local token, rendered step settings).

## Development

```bash
pnpm test        # unit + integration tests (real tmux, fake claude, fake gh)
pnpm test:e2e    # panel end to end with Playwright
pnpm lint
pnpm typecheck
```
