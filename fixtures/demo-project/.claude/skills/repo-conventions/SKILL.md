---
name: repo-conventions
description: Coding conventions of demo-project. Layout, no runtime dependencies, API and error format, testing with node:test, commits. Use in the development step and whenever code is changed.
---

# Repository conventions (demo-project)

## Layout

- `src/server.js`: HTTP server and routing only. `src/todos.js`: pure domain functions and validation.
- `public/index.html`, `public/app.js`: the page and its ES module.
- `test/*.test.js`: unit tests with `node:test` and `node:assert/strict`.
- `e2e/*.spec.js`: Playwright specs (written by the e2e step).

## Rules

- **No runtime dependencies.** Node 22 built-ins only. Do not edit `package.json` dependencies.
- JSON API under `/api`. Errors are `{ "error": "<message>" }` with a 4xx status. Exact messages come from
  the requirements (for example `Title cannot be empty`).
- Cap request bodies at 10 KB (413) and answer malformed JSON with 400. Bind to `127.0.0.1`.
- Render user text with `textContent`, never `innerHTML`.
- Accessible forms: every input has a `<label for>`; errors use `role="alert"`.
- `make check` must stay green: `make build` (syntax), `make lint` (no `debugger`, no `console.log` in
  `src/`, no tabs or trailing spaces) and `make unit`.

## Tests

- Test-first: a failing test, then the code. One test per rule.
- Test the domain in `test/todos.test.js` and the API through a real server on port 0 (see
  `test/server.test.js`).

## Commits

- Conventional Commits (`feat:`, `fix:`, `test:`), one logical change each, on the task branch.
- Never commit `.factory/runs/`, `node_modules/`, `test-results/` or secrets.
