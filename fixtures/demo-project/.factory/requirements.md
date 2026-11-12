# Requirements — demo-project

## Functional requirements

### FR-001 Add a todo

- Given an empty store, when I run `todo add "Buy milk"`, then the CLI prints `Added #1` and the todo is stored.
- Given any store, when I run `todo add ""`, then the CLI exits with code 1 and prints `Title cannot be empty`.

### FR-002 List todos

- Given two stored todos, when I run `todo list`, then both are printed with their id, in creation order.
- Given an empty store, when I run `todo list`, then the CLI prints `No todos yet`.

## Non-functional requirements

- NFR-01 Performance: `todo list` with 1,000 todos answers in under 200 ms (p95) on a laptop.
- NFR-02 Portability: runs on Node 22 on Linux and macOS.
- NFR-03 Security: the store is a local JSON file with mode 0600; no network access.
