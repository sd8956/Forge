# Architecture — demo-project

- **Server** (`src/server.js`): Node `http`, no framework, no runtime dependencies. Serves `public/` and a
  JSON API under `/api`. Listens on `127.0.0.1:$PORT` (default 3000).
- **Domain** (`src/todos.js`, created by TASK-001): pure functions over an in-memory store; validation lives here.
- **Client** (`public/`): one HTML page and one ES module. It talks to the API with `fetch` and renders with
  `textContent` only.
- **Storage**: in memory, per process. Restarting the server clears the list (acceptable for the demo).

## API conventions

- JSON in and out, `content-type: application/json`.
- Errors: `{ "error": "<message>" }` with a 4xx status.
- Request bodies over 10 KB are rejected with 413.

## Commands

`make up` starts the app, `make check` runs build, lint and unit tests, `make e2e` runs Playwright.
