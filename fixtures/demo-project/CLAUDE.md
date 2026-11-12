# demo-project

A tiny todo CLI used to exercise the Forge pipeline.

- Project definition lives in `.factory/` (requirements, backlog, step settings).
- Pipeline steps run as `forge-*` agents from `.claude/agents/` and follow the `forge-step-protocol` skill.
- Step handoffs live in `.factory/runs/<TASK>/<step>/` and are not committed.
