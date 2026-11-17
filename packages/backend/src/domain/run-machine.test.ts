import { describe, expect, it } from "vitest";
import { RUN_STATUSES, type RunStatus } from "@forge/shared";
import { RUN_EVENTS, RUN_TRANSITIONS, nextRunStatus, type RunEvent } from "./run-machine.js";

describe("run state machine", () => {
  const allowed: [RunStatus, RunEvent, RunStatus][] = [
    ["queued", "start", "running"],
    ["running", "complete", "waiting_review"],
    ["running", "attention", "needs_human"],
    ["needs_human", "resume", "running"],
    ["queued", "fail", "failed"],
    ["running", "fail", "failed"],
    ["needs_human", "fail", "failed"],
    ["queued", "cancel", "cancelled"],
    ["running", "cancel", "cancelled"],
    ["needs_human", "cancel", "cancelled"],
    ["waiting_review", "review_requested", "running"],
    ["waiting_review", "merged", "done"],
    ["waiting_review", "pr_closed", "cancelled"],
    ["waiting_review", "cancel", "cancelled"],
  ];

  it.each(allowed)("%s --%s--> %s", (from, event, to) => {
    expect(nextRunStatus(from, event)).toEqual({ ok: true, from, to });
  });

  it("rejects every pair that is not in the table", () => {
    const keys = new Set(allowed.map(([from, event]) => `${from}:${event}`));
    for (const from of RUN_STATUSES) {
      for (const event of RUN_EVENTS) {
        if (keys.has(`${from}:${event}`)) continue;
        expect(nextRunStatus(from, event), `${from}:${event}`).toEqual({ ok: false, from, event });
      }
    }
  });

  it("keeps done, failed and cancelled closed", () => {
    for (const closed of ["done", "failed", "cancelled"] as const) {
      expect(RUN_TRANSITIONS.filter((t) => t.from.includes(closed))).toEqual([]);
    }
  });

  it("keeps the table and the test in sync", () => {
    expect(RUN_TRANSITIONS.reduce((n, t) => n + t.from.length, 0)).toBe(allowed.length);
  });
});
