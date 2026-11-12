# TASK-001 — Add and list todos

- Covers: FR-001, FR-002
- Size: S
- Depends on: none
- Prototype screens: none (CLI)

## Scope

Implement `todo add <title>` and `todo list` with a JSON file store at `~/.todo.json`.

## Acceptance criteria

- AC-1 (FR-001) Given an empty store, when I run `todo add "Buy milk"`, then the CLI prints `Added #1` and the todo is stored.
- AC-2 (FR-001) Given any store, when I run `todo add ""`, then the CLI exits with code 1 and prints `Title cannot be empty`.
- AC-3 (FR-002) Given two stored todos, when I run `todo list`, then both are printed with their id, in creation order.
- AC-4 (FR-002) Given an empty store, when I run `todo list`, then the CLI prints `No todos yet`.
