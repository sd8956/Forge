# demo-project

A tiny todo web app (Node, no runtime dependencies) used to exercise the Forge pipeline.

- Project definition lives in `.factory/`: requirements, architecture, test strategy, threat model,
  backlog, `pipeline.yaml` and the per-step settings in `steps/`.
- Pipeline steps run as `forge-*` agents from `.claude/agents/` and follow the `forge-step-protocol` skill.
- Code conventions: `.claude/skills/repo-conventions/SKILL.md`. Keep `make check` green.
- Step handoffs live in `.factory/runs/<TASK>/<step>/<attempt>/` and are never committed.
