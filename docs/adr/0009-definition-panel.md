# ADR 0009 — Definition stages, their worktree and the project template

- Status: accepted
- Date: 2026-11-17
- Phase: F4
- Deviates from / makes concrete: "Panel 1 — Project definition", the data model and "Agents and skills per step".

## Decision

- **Stages are steps without a run.** Each stage is a Claude Code session started by `StepService` with
  `runId = null`, kind `def_<stage>`, agent `forge-def-<stage>` (Opus) and task id `DEF-<project id prefix>`, so tmux,
  hooks, the guard, timeouts, restart reconciliation and the terminal bridge are the same as for pipeline steps. A
  policy router sends `def_*` steps to `DefinitionService` and the rest to `RunService`. Stages report with
  `report_stage` (the same input as `report_step`); the backend validates the stage's files before accepting it.
- **Data.** `definition_stage` (the definition's data model) holds status, summary, step, feedback, last error,
  approved prototype screens, approval time and commit; its status moves only through a table: `pending → running →
  in_review → approved`, or `in_review → changes_requested → running`; a session that ends without a valid report goes
  `running → pending` with the reason, and the person retries it. A `definition` table keeps the idea, the worktree and
  the PR URL.
- **Conversation.** The definition settings template has no Stop hook: a stage may end its turn to ask the person, and
  then waits in `needs_human` (idle notification) until they answer in the panel terminal.
- **Where it writes.** Stages work in `<repo>/.worktrees/definition` on `forge/definition`. An empty clone first gets
  an empty commit (`chore: start the project`) so a worktree can branch. `.worktrees/` goes to `.git/info/exclude`.
  The guard denies Write and Edit outside `.factory/` and inside `.factory/steps/`; Bash is not among the stage tools.
- **Template.** Forge copies `.claude/agents`, `.claude/skills`, `.factory/pipeline.yaml`, `.factory/steps`,
  `.factory/orchestrator.settings.json` and `.semgrep` from the template (`FORGE_TEMPLATE_DIR`, default the
  `demo-project` fixture) and commits it. `repo-conventions` is replaced by a generic skill that points to the
  architecture, and the agents' Engram project is renamed to the name chosen at intake.
- **Gates.** Approving checks the files again, commits `.factory/` (`docs(definition): approve the <stage>`) and starts
  the next stage. The design needs every prototype screen approved first. Approving the backlog pushes
  `forge/definition` and opens the "docs: project definition" PR; the person merges it.
- **Project registration.** A project being defined has no `project.yaml` on its base branch yet, so it is registered
  under its folder name until the definition merges.
- **Validation** (pure, `definition-validators.ts`): intake and `project.yaml`; FR headings with Given/Then criteria
  ("When" is optional for state checks, as in the hand-written sandbox) and NFRs with a number or a rule that holds
  everywhere; architecture, at least one ADR, every STRIDE category and `commands.check`/`commands.e2e`; a test
  strategy that names its evidence; tokens as a JSON object, a component inventory and one HTML file per screen; and a
  backlog whose tasks cover existing FRs or NFRs, have criteria and a size, depend on known tasks without cycles and
  together cover every FR.

## Consequences

- The prototype is untrusted HTML. It is served with a CSP that blocks the network and shown in an iframe with
  `sandbox="allow-scripts"` only (opaque origin: no access to the panel or its cookie).
