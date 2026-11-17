#!/usr/bin/env node
// Fake Engram HTTP API for the panel e2e: GET /observations and /search for one project, and the two POSTs the
// backend uses to save review feedback. Usage: fake-engram.mjs <port>
import { createServer } from "node:http";

const observations = [
  { id: 1, title: "Todo store seam", type: "decision", content: "**What**: The store is the only module that touches todos.\nRef: TASK-001/plan", project: "demo-project", created_at: "2026-11-17 10:00:00" },
  { id: 2, title: "Reviewers ask for addTodo naming", type: "learning", content: "**What**: Rename createTodo to addTodo.\nRef: TASK-001/review", project: "demo-project", created_at: "2026-11-17 11:00:00" },
  { id: 3, title: "E2E evidence layout", type: "convention", content: "**What**: One folder per TC with screenshots.\nRef: TASK-003/e2e", project: "demo-project", created_at: "2026-11-17 12:00:00" },
];
let nextId = 100;

createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const send = (body) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(body));
  };
  if (req.method === "POST") {
    req.resume();
    req.on("end", () => send({ id: nextId++ }));
    return;
  }
  const project = url.searchParams.get("project");
  const mine = observations.filter((o) => o.project === project);
  if (url.pathname === "/observations") return send(mine);
  if (url.pathname === "/search") {
    const q = (url.searchParams.get("q") ?? "").toLowerCase();
    return send(mine.filter((o) => `${o.title} ${o.content}`.toLowerCase().includes(q)));
  }
  res.statusCode = 404;
  send({ error: "not found" });
}).listen(Number(process.argv[2]), "127.0.0.1");
