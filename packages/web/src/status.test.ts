import { RUN_STATUSES, STEP_STATUSES } from "@forge/shared";
import { describe, expect, it } from "vitest";
import { duration, runStatus, stepStatus } from "./status.js";

describe("status badges", () => {
  it("label every run and step status, never by color alone", () => {
    for (const s of RUN_STATUSES) expect(runStatus(s).label.length).toBeGreaterThan(0);
    for (const s of STEP_STATUSES) expect(stepStatus(s).label.length).toBeGreaterThan(0);
  });

  it("maps statuses to the design's tones", () => {
    expect(runStatus("waiting_review")).toEqual({ tone: "awaiting_review", label: "Awaiting review" });
    expect(runStatus("needs_human")).toEqual({ tone: "needs_attention", label: "Needs attention" });
    expect(stepStatus("blocked")).toEqual({ tone: "needs_attention", label: "Blocked" });
  });

  it("formats durations", () => {
    expect(duration(null, null)).toBe("");
    expect(duration(0 + 1, 46_001)).toBe("46 s");
    expect(duration(1, 11 * 60_000)).toBe("11 min");
    expect(duration(1, 125 * 60_000)).toBe("2 h 5 min");
  });
});
