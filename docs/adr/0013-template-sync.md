# ADR 0013 — Projects stay on the latest Forge files through a PR

- Status: accepted
- Date: 2026-11-25
- Extends: ADR 0009 (the definition copies Forge's template into a project once).

## Context

A project keeps the copy of Forge's agents, skills, pipeline and step settings it got when it was defined. When the
template improves, the project does not see it: `daily-tasks` resolved a merge conflict correctly but did not explain
it on the PR, because its `pr-thread-reply` skill predated the conflict section. The person asked for projects to be
updated automatically so they always have the latest.

## Decision

- At backend start, every 6 hours (`FORGE_TEMPLATE_SYNC_MS`, 0 turns it off), with "Check now" in the project's Settings
  and with `forge template sync --project <path>`, Forge compares each project's Forge files (the template paths of ADR
  0009, except the project's own `repo-conventions` skill) with the template.
- **Never overwrite a customization.** A project file whose content (with the agents' Engram project name normalized)
  matches some version of that template file in Forge's git history is an untouched copy: it gets the current version,
  with the project's Engram name kept. A file that matches no version was changed in the project: it is listed in the PR
  and left alone. Files new in the template are added; files removed from it are left.
- **Through a PR, never on the base branch.** Changes are made in a worktree created from `origin/<base>` on branch
  `forge/template-update` (the person's checkout is untouched), pushed, and opened as "chore: update Forge files". The
  branch belongs to Forge and is rebuilt from the base on every sync (`--force-with-lease`); an open PR gets the new
  commit instead of a second PR, and nothing is pushed when the branch already has the same content. The person merges.
- A project's remote is read with `git config remote.origin.url`: `git remote get-url` applies `insteadOf` rewrites and
  hid the GitHub slug.

## Consequences

- Tasks already running keep their branch's copy until they merge the base branch.
- Recognizing old copies needs Forge's git history. In a shallow clone of Forge (CI's default checkout) every old copy
  looks customized, so sync only adds new files and lists the rest, never overwriting; CI fetches the full history.
- A project that wants a template file to stay as it is edits it; from then on it is reported, not updated.
