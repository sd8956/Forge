# Requirements — demo-project

A single-page todo list served by a small Node server.

## Functional requirements

### FR-001 Add a todo

- Given the page with no todos, when I type `Buy milk` in the "New todo" field and press "Add", then
  `Buy milk` appears in the list and the field is cleared.
- Given the page, when I press "Add" with an empty or blank field, then the page shows
  `Title cannot be empty` and the list does not change.

### FR-002 List todos

- Given two added todos, when I reload the page, then both appear in creation order.
- Given no todos, when I open the page, then it shows `No todos yet`.

### FR-003 Count todos

- Given two todos, when I look at the heading, then it reads `Todos (2)`.
- Given no todos, then the heading reads `Todos (0)`.

## Non-functional requirements

- NFR-01 Performance: the page and the API answer in under 200 ms (p95) on a laptop.
- NFR-02 Accessibility: every form control has a visible label; the error message is announced (`role="alert"`).
- NFR-03 Security: user text is never rendered as HTML; request bodies are capped at 10 KB; no secrets in the repo.
- NFR-04 Portability: Node 22 on Linux and macOS, no runtime dependencies.
