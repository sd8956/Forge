# TASK-001 — Add and list todos

- Covers: FR-001, FR-002
- Size: S
- Depends on: none
- Prototype screens: none (single page)

## Scope

Add a JSON API (`GET /api/todos`, `POST /api/todos`) backed by an in-memory store, and a form on the page
to add todos and show the list.

## Acceptance criteria

- AC-1 (FR-001) Given the page with no todos, when I type `Buy milk` in the "New todo" field and press "Add", then `Buy milk` appears in the list and the field is cleared.
- AC-2 (FR-001) Given the page, when I press "Add" with an empty or blank field, then the page shows `Title cannot be empty` and the list does not change.
- AC-3 (FR-002) Given two added todos, when I reload the page, then both appear in creation order.
- AC-4 (FR-002) Given no todos, when I open the page, then it shows `No todos yet`.
