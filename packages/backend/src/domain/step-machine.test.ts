import { describe, expect, it } from "vitest";
import { STEP_STATUSES, type StepStatus } from "@forge/shared";
import { STEP_EVENTS, STEP_TRANSITIONS, nextStatus, type StepEvent } from "./step-machine.js";

describe("step state machine", () => {
  const allowed: [StepStatus, StepEvent, StepStatus][] = [
    ["queued", "launch", "running"],
    ["queued", "launch_failed", "failed"],
    ["queued", "orphaned", "failed"],
    ["running", "report_done", "done"],
    ["running", "report_blocked", "blocked"],
    ["running", "report_failed", "failed"],
    ["running", "attention", "needs_human"],
    ["running", "timeout", "failed"],
    ["running", "session_ended", "failed"],
    ["running", "orphaned", "failed"],
    ["needs_human", "report_done", "done"],
    ["needs_human", "report_blocked", "blocked"],
    ["needs_human", "report_failed", "failed"],
    ["needs_human", "timeout", "failed"],
    ["needs_human", "session_ended", "failed"],
    ["needs_human", "orphaned", "failed"],
  ];

  it.each(allowed)("%s --%s--> %s", (from, event, to) => {
    expect(nextStatus(from, event)).toEqual({ ok: true, from, to });
  });

  it("rejects every pair that is not in the table", () => {
    const allowedKeys = new Set(allowed.map(([from, event]) => `${from}:${event}`));
    for (const from of STEP_STATUSES) {
      for (const event of STEP_EVENTS) {
        if (allowedKeys.has(`${from}:${event}`)) continue;
        expect(nextStatus(from, event), `${from}:${event}`).toEqual({ ok: false, from, event });
      }
    }
  });

  it("has no transitions out of terminal statuses", () => {
    for (const terminal of ["done", "blocked", "failed"] as const) {
      expect(STEP_TRANSITIONS.filter((t) => t.from.includes(terminal))).toEqual([]);
    }
  });

  it("keeps the table and the test in sync", () => {
    const tableSize = STEP_TRANSITIONS.reduce((n, t) => n + t.from.length, 0);
    expect(tableSize).toBe(allowed.length);
  });
});
