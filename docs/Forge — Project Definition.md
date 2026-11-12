# Forge — Project Definition

Nov 11, 2026 · @Santiago

## Vision and scope

Forge is a local web panel that drives Claude Code sessions in tmux. It takes a project from definition to merge-ready PRs, with shared memory in Engram. It has two panels that work on the same repository:

- **Definition panel (Project Studio):** a guided session that lays down the full project foundation. It produces functional and non-functional requirements, the architecture, the interface design, a clickable HTML prototype and the initial task backlog. Everything lives in the repo's `.factory/` folder.
- **Execution panel (Factory Floor):** you pick a project and talk to an orchestrator. The orchestrator breaks the work down and launches N pipelines in parallel, one per task: plan (with test plan) → design → development → security → E2E tests with evidence → PR → review handling.

Each pipeline step is an independent Claude Code session: it starts with a clean context, writes its results to disk and to Engram, closes and hands off to the next step.

**Out of scope for v1:** other model providers (a separate project, Paperclip-style), multiple users, cloud execution and automatic deploys.

## Principles and constraints

1. **One engine: the official Claude Code CLI.** The panel opens `claude` inside tmux and drives it. It never uses the OAuth token to call the API directly, which is what Anthropic blocks for third-party tools.
2. **The LLM orchestrator proposes; the backend executes.** The state machine for pipelines, queues and retries lives in deterministic code. The LLM decides which tasks to launch and how to split them, but it does not control the transitions.
3. **One session per step, clean context.** State moves between steps through on-disk artifacts with a fixed schema. Engram complements this as long-term memory and is not the only handoff channel.
4. **Nothing is scraped from the screen.** Step completion, blockers and results are reported through Claude Code hooks and a custom MCP tool (`report_step`). Reading the tmux TUI is fragile and breaks with every release.
5. **No PR without test evidence.** Every case in the test plan must have a result and evidence files (screenshots, video, trace, logs).
6. **Security blocks.** A critical or high finding sends the task back to development and never reaches the PR.
7. **Configurable human gates.** By default you approve the definition, the UI design, the orchestrator's execution plan and the merge. A person always merges.
8. **Local-first and isolated.** Everything runs on your machine, each task in its own git worktree and branch.
9. **Responsible use of the subscription.** Concurrency is low and configurable, and a person is always in the loop. An API key can be configured instead, in case Anthropic's policy on automation changes.

## System architecture

The system has four layers: the browser, a local backend that holds all the logic, tmux with the Claude Code sessions, and the services those sessions use. Sessions never talk to each other; everything goes through the backend.

&#91;embedded content: architecture · 4 layers\]

Sessions notify the backend two ways: Claude Code's HTTP hooks and the `report_step` MCP tool. The backend opens and closes sessions through the Runner.

**Recommended stack and why:**

- **Node 22 + TypeScript backend (Fastify).** The official MCP SDK, `node-pty` and xterm.js all live in this ecosystem, and frontend and backend share types.
- **React + xterm.js frontend.** Any tmux session can be watched live inside the panel, read-only or interactive.
- **SQLite (Drizzle) for state.** One file, no server, enough for a single user.
- **tmux.** Sessions survive a backend restart, and on startup the backend reconciles its state with `tmux ls`.
- **`gh` CLI** for PRs, comments and CI status.
- **Engram** behind a `MemoryAdapter` interface, so the memory provider can be swapped later.

## Panel 1 — Project definition

The panel's output is the `.factory/` folder in the project repo. It is the contract the whole Execution panel reads. Each stage is a Claude Code session shown in the panel as an embedded terminal, and each ends with an approval gate.

1. **Intake.** You describe the idea in plain language and give the constraints: platforms (web, mobile, CLI), preferred stack and budget or infrastructure limits.
2. **Requirements.** Output: `requirements.md`.
   - Functional requirements with IDs (`FR-001`), each with Given/When/Then acceptance criteria.
   - Measurable non-functional requirements (`NFR-01`): p95 latency, availability, security, accessibility and observability.
   - Gate: you approve or ask for changes.
3. **Architecture and security.** Outputs: `architecture.md`, `adr/` and `threat-model.md`.
   - Architecture with bounded contexts, stack and decisions recorded as ADRs.
   - STRIDE threat model per component. Each task's security step uses it as its reference.
4. **Test strategy.** Output: `test-strategy.md`.
   - Tool per platform: Playwright for web, Maestro for mobile and HTTP tests for APIs.
   - Environments, seed data and how to start the app locally (`make up` or similar).
   - Which evidence is mandatory per case type.
5. **Interface design.** Outputs: `design/tokens.json`, `design/components.md` and `prototype/*.html`.
   - Design system tokens and a component inventory.
   - Clickable HTML prototype with fake data. The panel shows it in an iframe so you can iterate in the chat.
   - Gate: you approve screen by screen.
6. **Backlog.** Output: `backlog/TASK-xxx.md`.
   - Each task lists the FRs it covers, its acceptance criteria, the prototype screens it implements, dependencies and size (S/M/L).
   - Gate: you approve the backlog and the project is ready for the Execution panel.

```
.factory/
  project.yaml          # name, platforms, commands (build, test, up), policies
  requirements.md
  architecture.md
  adr/
  threat-model.md
  test-strategy.md
  design/tokens.json
  design/components.md
  prototype/index.html
  backlog/TASK-001.md
  runs/                 # handoffs and evidence for each pipeline (gitignored)
.claude/
  agents/forge-*.md     # one agent per pipeline step
  skills/*/SKILL.md     # reusable procedures
CLAUDE.md               # repo conventions, points to .factory/
```

**About the HTML prototype:** it is a visual reference, not code to copy. For a mobile app, the development agent uses the tokens and the component inventory and looks at the HTML only for layout and behavior. That way less is lost moving from HTML to another platform.

## Panel 2 — Execution

You pick a project and talk to the orchestrator. It is a Claude Code session connected to the `factory` MCP server, so it can only act through tools: `list_backlog`, `propose_plan`, `launch_pipeline`, `get_status` and `cancel`.

- **Execution plan:** the orchestrator reads the backlog, builds a task DAG with dependencies and proposes it to you. Once you approve, it launches one pipeline per task.
- **Scheduler rules (in code):**
  - Configurable max concurrency; 3 sessions by default.
  - A task does not start until its dependencies are merged.
  - Two tasks that touch the same module never run in parallel.
- **Model per step:** chosen by task size and set by the step's agent or with `--model`.
- **Board:** one column per step and one card per task, with live terminal, artifacts, evidence and time per step.

&#91;embedded content: pipeline per task · 8 steps, 3 loops\]

Every loop has a configurable attempt limit. When it runs out, the pipeline moves to `needs_human` and notifies you.

| Step | Input | Output | Exits when |
| --- | --- | --- | --- |
| Plan + test plan | TASK, requirements, architecture, test-strategy, Engram | `plan.md`, `test-plan.md` with `TC-xx` cases linked to FRs | every acceptance criterion has at least one case |
| Technical design | plan, prototype, tokens, ADRs | `design.md`: API contracts, schema, UI components | `report_step` is done |
| Development | plan, design | code, unit tests, commits, `dev-notes.md` | build, lint and unit tests green (checked by the Stop hook) |
| Security | diff, threat model, security NFRs | `security-report.md` with findings and severity | zero critical or high findings |
| E2E tests | test plan, running app | E2E specs in the repo, `test-report.md`, `evidence/` | every TC passes and has evidence |
| Pull request | all reports | GitHub PR with covered FRs, tests and security | PR created |
| Review fix | comments, CI logs | commits and replies on the PR | every thread answered |

**Security step.** Deterministic tools run first: Semgrep (SAST), gitleaks (secrets) and osv-scanner or `npm audit`/`pip-audit` (dependencies). If there is IaC or containers, Trivy too. Then Claude reviews the diff against the threat model and the OWASP Top 10, and confirms or discards each finding. Critical and high findings block; medium and low are listed in the PR.

**Test step.** The test plan is written in the Plan step, before any code, so nobody fits the tests to what they already built. The agent starts the app (`make up`) and runs every case:

- **Web:** Playwright with a screenshot per step, video and trace.
- **Mobile:** Maestro on an emulator or simulator, with screenshots.
- **APIs:** request and response saved.

Cases are committed as versioned specs so CI repeats them, not just as agent clicks. `evidence/manifest.json` links each `TC-xx` to its result and its files.

## Brand and UI

The visual identity and the three reference screens live in the design canvas [Forge — Brand and interface](https://claude.ai/artifact/WHLFRacHtPoVYbBNX6LSsi). Agents cannot open that link, so the values below are the source of truth for code, mirrored in `docs/design/tokens.json` with the logo in `docs/design/logo.svg` and `docs/design/logo-dark.svg`.

- **Name:** Forge (wordmark in lowercase: “forge”).
- **Logo:** a rounded square in the brand color with an “F” built from three pipeline bars, plus a small diamond for the output spark. At 16 px the diamond is dropped so it stays legible.
- **Themes:** light and dark, switched at runtime with CSS variables; every screen supports both.

| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| `bg` | `#FAFAF9` | `#0F1011` | page background |
| `surface` | `#FFFFFF` | `#17181A` | cards, panels, sidebar |
| `surface-2` | `#F4F4F2` | `#1F2023` | inputs, nested blocks |
| `border` | `#E4E2DE` | `#2C2E32` | dividers, card borders |
| `text` | `#1C1B19` | `#EDEDEC` | primary text |
| `text-muted` | `#5F5C57` | `#A3A19C` | secondary text, labels |
| `brand` | `#C2410C` | `#F97316` | primary buttons, active nav, focus |
| `brand-ink` | `#FFFFFF` | `#1A0B04` | text on `brand` |
| `brand-soft` | `#FFF1EA` | `#2A1A10` | active nav background, gate bar |
| `terminal-bg` | `#1C1B19` | `#0B0C0D` | embedded terminal (dark in both themes) |
| `terminal-text` | `#E7E5E1` | `#D9D7D2` | terminal text |

| Pipeline state | Color | Light (text / background) | Dark (text / background) |
| --- | --- | --- | --- |
| Queued | gray | `#5F5C57` / `#EEEDEA` | `#A3A19C` / `#232427` |
| Running | blue | `#1D4ED8` / `#E8EEFC` | `#7AA7FF` / `#16213A` |
| Awaiting review | teal | `#0F766E` / `#E3F3F1` | `#2DD4BF` / `#0F2A27` |
| Needs attention | violet | `#6D28D9` / `#F0EAFC` | `#B79CFF` / `#221A38` |
| Failed | red | `#B91C1C` / `#FBE9E9` | `#F87171` / `#2E1616` |
| Done | green | `#166534` / `#E7F4EC` | `#4ADE80` / `#122A1C` |

**Typography:** Space Grotesk 600 for headings, Inter 400–600 for the interface (14–16 px), JetBrains Mono for the terminal, IDs and file paths.

**Rules:**

- Text and badges meet a 4.5:1 contrast ratio in both themes.
- A state is never shown by color alone; badges always carry their label.
- The brand orange is never used for a state. “Needs attention” is violet, not amber, so it is not confused with the brand. Medium severity findings use amber (`#B45309` light, `#FBBF24` dark).
- Icons are inline stroke SVGs, never emoji.

**Reference screens in the canvas:** Execution panel (dark by default), Task detail with test plan and evidence (light), and Definition panel with the approval gate (light).

## Lifecycle of a step session in tmux

A step counts as finished only when the agent calls `report_step`. The Stop hook is the safety net that keeps a session from going idle without reporting. The tmux screen is never read to learn the state.

1. **Prepare.** On the task's first step, the Runner creates the worktree with `git worktree add .worktrees/TASK-012 -b feat/TASK-012`. Before each step, the backend writes `.factory/runs/TASK-012/<step>/input.md` with the goal, the paths to earlier artifacts and the output contract.
2. **Launch.** Each step is a tmux session started with its step agent (`--agent`), which carries the role prompt, tools, model and the `factory` MCP server. The backend adds the `session-id` and the per-step settings with the hooks:

```bash
tmux new-session -d -s forge-TASK-012-dev -c .worktrees/TASK-012 \
  "claude --agent forge-developer --session-id $UUID \
     --settings .factory/steps/developer.settings.json \
     'Read .factory/runs/TASK-012/dev/input.md and run the step.'"
```

3. **Run with least privilege.** Each step has its own tool allowlist. Development can edit files and run `npm test` and `git commit`; Security can run `semgrep` and `gitleaks`. Edits are auto-accepted, and `--dangerously-skip-permissions` is never used outside a container. If a permission prompt appears, the Notification hook (`permission_prompt`) flags the card as “needs attention” and you answer from the embedded terminal.
4. **Report.** The agent calls `report_step` with its status (`done`, `blocked` or `failed`), a summary and the list of artifacts.
   - If it did not, the Stop hook answers `decision: block` with the instruction to call it.
   - In Development, the same hook runs `make check` and blocks if it is red.
   - The hook honors `stop_hook_active` and a maximum number of blocks so it cannot loop.
5. **Close.** The backend stores the step's `transcript_path`, runs `tmux kill-session` and records the duration. The SessionEnd hook confirms the close and the backend queues the next step.
6. **Failures.** Each step has a wall-clock timeout. An `idle_prompt` notification without a report moves the step to `needs_human`. A detected rate limit pauses the whole queue, not just the step.

**Two Runner modes:** `tmux-interactive` by default, and `headless` with `claude -p --output-format stream-json` as an alternative. Headless is simpler because it ends on its own and returns JSON. But how it is billed under the subscription has already seen announced changes, so it stays behind a flag.

## Agents and skills per step

Each step has exactly one agent; skills are reusable procedures shared across steps. The agent is who does the step: `.claude/agents/forge-<step>.md` defines its role prompt, tools, model, permission mode and MCP servers, and the Runner starts the session with `claude --agent`. A skill is how something is done: steps, formats and scripts that several agents load.

| Step | Agent | Model | Skills |
| --- | --- | --- | --- |
| Plan + test plan | `forge-planner` | Opus | `test-plan-authoring` (TC ↔ FR format), `engram-recall` |
| Technical design | `forge-designer` | Opus | `api-contracts`, `ui-from-prototype` (tokens + component inventory) |
| Development | `forge-developer` | Sonnet (Opus for L tasks) | `repo-conventions`, `tdd-loop` |
| Security | `forge-security` | Opus | `security-scan` (runs Semgrep, gitleaks and osv, triages false positives), `threat-model-review` |
| E2E tests | `forge-tester` | Sonnet | `playwright-evidence`, `evidence-manifest`; `maestro-evidence` in v2 |
| Pull request | `forge-pr` | Sonnet | `pr-report` |
| Review fix | `forge-review-fixer` | Sonnet | `pr-thread-reply`, `playwright-evidence` |
| **All** | — | — | **`forge-step-protocol`**: read `input.md`, recall and save in Engram, write `output.md`, call `report_step` |

- **`forge-step-protocol` is the key skill.** It holds the contract every step shares, instead of repeating it in seven prompts.
- **Pin a minimum Claude Code version.** Loading an agent's `mcpServers` when it runs as the main thread with `--agent` is recent (v2.1.117+). Without the `factory` MCP there is no `report_step`, so Phase 0 checks this first.
- **Do not chain steps with subagents.** Steps stay separate tmux sessions controlled by the backend, so each has a clean context, its own permissions and a state visible in the panel. Inside a step, subagents are fine, for example to review several test cases in parallel.

## Memory and handoff with Engram

Handoff between steps goes through files with a fixed schema, and Engram keeps the knowledge that is useful across tasks. Mixing both roles in Engram would make the next step depend on a search finding the right thing. With files, the handoff is reproducible and can be inspected from the panel.

| Layer | Contents | Read by | Lifetime |
| --- | --- | --- | --- |
| Handoff (`.factory/runs/TASK/step/`) | `input.md`, `output.md` and the step's artifacts (plan, design, reports, evidence) | the next step of the same task and the panel | the life of the task |
| Engram | decisions, discovered conventions, errors and their fix, review-feedback patterns | any step of any future task in the project | permanent |

**How Engram is used:**

- At start, each step searches Engram with its task context, for example “API error handling” or “E2E test conventions”.
- At the end, it saves only what is useful for the future, not a summary of what it did. Observations carry the project and a `TASK-xxx/step` reference for traceability.
- The backend reads Engram through its HTTP API and shows on each card what that task saved.
- Access goes through the `MemoryAdapter` interface (`search`, `save`, `listByTask`), so the memory provider can change without touching the steps.

**To validate:** that Engram handles concurrent writes from several sessions without SQLite lock conflicts.

## PR lifecycle and review handling

The agent only handles comments from allowed authors and never merges. PR comments are third-party text, so they are treated as possible prompt injection.

1. **Open the PR.** `gh pr create` with a template: summary, covered FRs, a table of `TC-xx` cases with results, a security summary and known risks.
2. **Watch.** The PR watcher polls `gh api` every few minutes: review comments, review state and CI checks. It polls because a webhook on a local machine would need a tunnel.
3. **Trigger the fix.** When there are new comments from an allowed author or CI is red, the backend builds `input.md` with each thread (file, line, text) or the failed check's log, and launches the Review fix step.
4. **Fix and reply.** The agent applies the changes and replies to each thread with what it did or why it does not apply.
5. **Re-verify.** The code changed, so Security and E2E tests run again before the push. Then the report on the PR is updated.
6. **Close.** When you merge, the backend removes the worktree, marks the task `done`, saves the feedback patterns to Engram and releases the tasks that depended on this one.

**Evidence on the PR:** the GitHub API does not allow uploading images to a comment. The options are under Open decisions.

## Data model

Seven entities in SQLite. The `event` table is the audit log and feeds the UI over WebSocket.

| Entity | Key fields | Notes |
| --- | --- | --- |
| `project` | id, name, repo\_path, remote, default\_branch, config (from `project.yaml`) | one per repo |
| `definition_stage` | project\_id, stage (intake, requirements, architecture, test\_strategy, design, backlog), status, approved\_at | the Panel 1 gates |
| `task` | id (`TASK-012`), project\_id, spec\_path, size, depends\_on\[\], status | comes from `backlog/` |
| `run` | id, task\_id, worktree, branch, status, current\_step, pr\_number, attempts per loop | one pipeline per task |
| `step` | id, run\_id, kind, agent, status, model, tmux\_session, claude\_session\_id, transcript\_path, input\_path, output\_path, started\_at, ended\_at, exit\_reason | one Claude session |
| `pr_thread` | id, run\_id, github\_comment\_id, author, path, line, body, handled\_by\_step\_id | so a thread is never handled twice |
| `event` | id, entity, entity\_id, type, payload, ts | audit and streaming |

**`run` states:** `queued`, `running`, `waiting_review`, `needs_human`, `done`, `failed`, `cancelled`. Valid transitions are defined as a table in code and unit-tested.

## Non-functional requirements

| Attribute | Requirement |
| --- | --- |
| Panel security | Listens only on `127.0.0.1` and requires a local token. It can launch shells, so exposing it on the network would mean remote code execution. |
| Agent permissions | Allowlist per step. No `--dangerously-skip-permissions` outside a container. Secrets never enter the worktrees. |
| Resilience | If the backend restarts, it reconciles the database with `tmux ls` and the worktrees. No running session is lost. |
| Concurrency | Configurable max sessions, FIFO queue with priority and a global pause on rate limit. |
| Observability | Full event log, linked transcripts, and duration and retries per step, to measure where the factory gets stuck. |
| Traceability | FR → TASK → TC → evidence → PR, navigable from the panel. |
| Extensibility | Pipelines defined in YAML (steps, agent, model, permissions, exit criterion). Adapters for memory and, later, for other providers. |
| Portability | Linux and macOS. Windows through WSL2, because tmux does not run natively. |

## Risks and mitigations

The two biggest risks are not technical: the subscription usage policy, and hitting the 5-hour window limit with several sessions in parallel.

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Anthropic considers heavy automation outside normal subscription use | High | Official CLI in interactive mode, low concurrency, human in the loop, API key as a configurable fallback |
| N parallel sessions exhaust the usage limit | High | Default concurrency of 3, global pause on rate limit, cheaper models for mechanical steps |
| Misdetecting the end of a step | High | `report_step` over MCP plus the Stop hook; no screen reading |
| Merge conflicts between parallel tasks | Medium | DAG, never two tasks on the same module, automatic rebase before the PR |
| “Green” tests written to fit the code | Medium | Test plan written before development; every case requires evidence |
| Prompt injection from PR comments, issues or dependencies | Medium | Author allowlist, least privilege per step, no secrets in the worktree |
| Destructive commands from the agent | Medium | Bash allowlist per step; in v2, a container per worktree |
| The HTML prototype translates poorly to mobile | Low | Tokens and component inventory as the source; HTML only as a visual reference |

## Open decisions

Each row has a recommendation. Rows marked as blocking must be closed before Phase 1.

| Decision | Options | Recommendation | Blocking? |
| --- | --- | --- | --- |
| Panel stack | Node/TS · Python (FastAPI) | Node/TS, for xterm.js, node-pty and the MCP SDK | Yes |
| Conversation UI | embedded terminal (xterm.js over tmux) · custom chat over `stream-json` | Embedded terminal in v1 | Yes |
| Platforms tested in v1 | web only · web + mobile | Web only with Playwright; Maestro in v2 | Yes |
| How a step is defined | `--agent` with `.claude/agents/` · `--append-system-prompt` + settings | `--agent`; fall back to `--append-system-prompt` if the agent's MCP servers do not load | Yes (Phase 0) |
| Where PR evidence lives | committed to the branch · served by the panel (local only) · CI artifacts | Served by the panel in v1, with a text summary on the PR | No |
| Merge | human · automatic on green CI | Human | No |
| Isolation | worktree · worktree + devcontainer | Worktree in v1, container in v2 | No |
| GitHub events | polling · webhook through a tunnel | Polling | No |
| Allowed review authors | only you · per-project list | List in `project.yaml` | No |
| Model per step | fixed per step type · by task size | By size, with defaults in the agent definition | No |

## Roadmap by phase

The execution core is built first, because that is where the technical risk is. The Definition panel comes last: until then, a test project's `.factory/` folder can be written by hand.

&#91;embedded content: roadmap · 5 phases with exit gates\]

F0 is highlighted because it validates the premise of the whole system: driving Claude Code reliably without reading the screen. If it fails its gate, the design changes before any panel is written.

## Sources

- [Claude Code — Hooks reference](https://docs.claude.com/en/docs/claude-code/hooks)
- [Claude Code — Subagents](https://code.claude.com/docs/en/sub-agents.md)
- [Engram (Gentleman Programming)](https://github.com/Gentleman-Programming/engram)
- [Anthropic ends subscription access for third-party tools (VPNCentral)](https://vpncentral.com/?p=247938)
- [The Register — Anthropic clarifies ban on third-party harnesses](https://www.theregister.com/2026/02/20/anthropic_clarifies_ban_third_party_claude_access)
