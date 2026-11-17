#!/usr/bin/env node
// Forge's status line for step sessions. Claude Code pipes its status JSON on stdin; this script
// forwards the usage window (rate_limits) to the backend and prints a short line. It must never
// fail or block the session, so every error is swallowed and the request times out quickly.
import { readFileSync, writeFileSync } from "node:fs";

const configFile = process.argv[2];
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", async () => {
  let status = {};
  try {
    status = JSON.parse(input);
  } catch {
    // Not JSON: nothing to forward.
  }
  const limits = status.rate_limits;
  const five = limits?.five_hour;
  process.stdout.write(`forge${five ? ` · usage ${Math.round(five.used_percentage)}%` : ""}\n`);
  if (!limits || !configFile) return;
  try {
    const { url, token } = JSON.parse(readFileSync(configFile, "utf8"));
    const body = JSON.stringify({ session_id: status.session_id, rate_limits: limits });
    // The status line refreshes often; only send what changed.
    const last = `${configFile}.last`;
    let previous = "";
    try {
      previous = readFileSync(last, "utf8");
    } catch {
      // First report.
    }
    if (previous === body) return;
    const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-forge-token": token }, body, signal: AbortSignal.timeout(2000) });
    if (response.ok) writeFileSync(last, body, { mode: 0o600 });
  } catch {
    // The backend may be restarting; the next refresh sends it again.
  }
});
