import { describe, expect, it } from "vitest";
import { parseDependencies } from "./dependencies.js";

describe("parseDependencies", () => {
  it.each([
    ["- Depends on: TASK-001", ["TASK-001"]],
    ["- Depends on: TASK-001, TASK-014", ["TASK-001", "TASK-014"]],
    ["- Depends on: none", []],
    ["- Depends on: TASK-001 (merged first)", ["TASK-001"]],
    ["# Title\n- Size: S\n", []],
  ])("%j", (spec, deps) => {
    expect(parseDependencies(spec)).toEqual(deps);
  });
});
