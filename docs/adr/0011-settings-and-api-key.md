# ADR 0011 — Settings and the API key fallback

- Status: accepted
- Date: 2026-11-17
- Phase: F5
- Makes concrete: principle 9 ("An API key can be configured instead") and the Settings item of the design.

## Decision

- **Forge-wide settings** (session cap, usage threshold, authentication) are stored in the `setting` table and win over
  the environment defaults (`FORGE_MAX_CONCURRENCY`, `FORGE_USAGE_PAUSE_PERCENT`). The scheduler and the queue view read
  the effective values on every pass.
- **Project settings stay in `.factory/project.yaml`**, the project's source of truth. The panel shows them read-only
  (permission mode, project session cap, extra review authors, poll interval, commands) with the file to edit.
- **Authentication.** Subscription (the person's `/login`) is the default. With "API key", every step session, definition
  stage and orchestrator session gets `apiKeyHelper: cat <FORGE_HOME>/anthropic-api-key` in its rendered settings.
  Verified in Claude Code's docs: `apiKeyHelper` may be set in any settings file (so `--settings` works) and ranks above
  the subscription login in the credential order.
- **Where the key lives.** Only in that file, mode 0600. It is never written to the database (a test checks the database
  file's bytes), never returned by the API (only its last four characters), never passed through a session's
  environment (where `env` would show it to the agent), and a rejected value is not echoed back. The guard already denies
  reads outside the worktree, and the orchestrator's settings deny reads of Forge's home.
- Switching to "API key" needs a saved key, and the key in use cannot be removed until the setting is back on the
  subscription.

## Consequences

- A real run with an API key spends API credits and needs the person's key; it is optional for F5.
