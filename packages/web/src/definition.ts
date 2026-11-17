import type { DefinitionStage, DefinitionView } from "./api.js";

export const STAGE_LABELS: Record<DefinitionStage, string> = {
  intake: "Intake",
  requirements: "Requirements",
  architecture: "Architecture",
  test_strategy: "Test strategy",
  design: "UI design",
  backlog: "Backlog",
};

/** Which `.factory/` paths each stage writes; used for the file tree and the document tabs. */
export const STAGE_PATHS: Record<DefinitionStage, string[]> = {
  intake: [".factory/intake.md", ".factory/project.yaml"],
  requirements: [".factory/requirements.md"],
  architecture: [".factory/architecture.md", ".factory/adr/", ".factory/threat-model.md"],
  test_strategy: [".factory/test-strategy.md"],
  design: [".factory/design/", ".factory/prototype/"],
  backlog: [".factory/backlog/"],
};

/** The stage the person is working on: the first one not approved yet. */
export function currentStage(view: DefinitionView) {
  return view.stages.find((s) => s.status !== "approved") ?? null;
}

export function stageStatusText(stage: DefinitionView["stages"][number]): string {
  switch (stage.status) {
    case "approved":
      return stage.summary ?? "Approved";
    case "in_review":
      return "In review";
    case "running":
      return "Working";
    case "changes_requested":
      return "Changes requested";
    default:
      return stage.lastError ? "Needs a retry" : "Pending";
  }
}

export type TreeState = "approved" | "current" | "pending";

/** One line per top-level `.factory/` entry, with the state of the stage that writes it. */
export function factoryTree(view: DefinitionView): { path: string; state: TreeState }[] {
  const current = currentStage(view)?.stage;
  const rows: { path: string; state: TreeState }[] = [];
  for (const s of view.stages) {
    for (const path of STAGE_PATHS[s.stage]) {
      if (rows.some((r) => r.path === path)) continue;
      rows.push({ path, state: s.status === "approved" ? "approved" : s.stage === current ? "current" : "pending" });
    }
  }
  return rows.map((r) => ({ ...r, path: r.path.replace(/^\.factory\//, "") }));
}
