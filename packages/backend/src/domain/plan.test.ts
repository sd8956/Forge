import { describe, expect, it } from "vitest";
import { validatePlan, type PlanProposal } from "./plan.js";

const backlog = [
  { id: "TASK-001", dependsOn: [] },
  { id: "TASK-002", dependsOn: ["TASK-001"] },
  { id: "TASK-003", dependsOn: [] },
  { id: "TASK-004", dependsOn: ["TASK-002", "TASK-003"] },
];
const plan = (waves: PlanProposal["waves"]): PlanProposal => ({ rationale: "r", waves });
const t = (id: string, modules = ["src/server"], priority?: number) => ({ id, modules, ...(priority === undefined ? {} : { priority }) });

describe("validatePlan", () => {
  it("accepts waves that respect dependencies and normalises modules", () => {
    const result = validatePlan(plan([{ tasks: [t("TASK-001", ["src/server/", " public "]), t("TASK-003")] }, { tasks: [t("TASK-002", ["src/server"], 5)] }]), backlog, new Set());
    expect(result).toEqual({
      ok: true,
      tasks: [
        { taskId: "TASK-001", wave: 0, modules: ["src/server", "public"], priority: 0, dependsOn: [] },
        { taskId: "TASK-003", wave: 0, modules: ["src/server"], priority: 0, dependsOn: [] },
        { taskId: "TASK-002", wave: 1, modules: ["src/server"], priority: 5, dependsOn: ["TASK-001"] },
      ],
    });
  });

  it("accepts a dependency that is already merged", () => {
    expect(validatePlan(plan([{ tasks: [t("TASK-002")] }]), backlog, new Set(["TASK-001"])).ok).toBe(true);
  });

  it.each([
    ["an unknown task", plan([{ tasks: [t("TASK-999")] }]), "TASK-999 is not in the backlog"],
    ["a task planned twice", plan([{ tasks: [t("TASK-001")] }, { tasks: [t("TASK-001")] }]), "TASK-001 appears more than once"],
    ["a dependency in the same wave", plan([{ tasks: [t("TASK-001"), t("TASK-002")] }]), "TASK-002 depends on TASK-001, which must be merged or in an earlier wave"],
    ["a dependency in a later wave", plan([{ tasks: [t("TASK-002")] }, { tasks: [t("TASK-001")] }]), "TASK-002 depends on TASK-001, which must be merged or in an earlier wave"],
    ["a dependency that is neither merged nor planned", plan([{ tasks: [t("TASK-002")] }]), "TASK-002 depends on TASK-001, which must be merged or in an earlier wave"],
    ["a task without modules", plan([{ tasks: [t("TASK-001", [])] }]), "TASK-001 must list the modules it touches"],
    ["an empty plan", plan([]), "The plan has no tasks"],
  ])("rejects %s", (_name, proposal, issue) => {
    const result = validatePlan(proposal, backlog, new Set());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues).toContain(issue);
  });
});
