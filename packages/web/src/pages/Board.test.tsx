import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { BacklogTask, Project, RunSummary } from "../api.js";
import { Board, columnOf } from "./Board.js";

const project: Project = { id: "p1", name: "demo-project", repoPath: "/repo", remote: null, defaultBranch: "main" };
const step = (kind: string, status: string, extra: Record<string, unknown> = {}) =>
  ({ id: `${kind}-s`, runId: "r", taskId: "TASK-001", kind, attempt: 1, model: "opus", permissionPrompts: 0, toolDenials: 0, agent: "a", status, tmuxSession: "t", claudeSessionId: "c", worktreePath: "/w", inputPath: "i", outputPath: "o", transcriptPath: null, exitReason: null, summary: null, artifacts: [], startedAt: 1000, endedAt: null, deadlineAt: null, ...extra }) as RunSummary["latestStep"];
const run = (taskId: string, status: RunSummary["status"], currentStep: RunSummary["currentStep"], latest: RunSummary["latestStep"], extra: Partial<RunSummary> = {}): RunSummary => ({
  id: `run-${taskId}`,
  taskId,
  projectPath: "/repo",
  branch: `feat/${taskId}`,
  baseBranch: "main",
  status,
  currentStep,
  attempts: {},
  prUrl: null,
  prNumber: null,
  mode: "build",
  reviewRound: 0,
  exitReason: null,
  createdAt: 0,
  endedAt: null,
  latestStep: latest,
  ...extra,
});
const backlog: BacklogTask[] = [
  { id: "TASK-001", title: "Add and list todos", size: "S", covers: [], dependsOn: [], latestRun: null },
  { id: "TASK-002", title: "Show the todo count", size: "S", covers: [], dependsOn: ["TASK-001"], latestRun: null },
  { id: "TASK-003", title: "Health endpoint", size: "S", covers: [], dependsOn: [], latestRun: null },
];

afterEach(cleanup);

describe("columnOf", () => {
  it("places open runs on their current step and closed runs on their outcome", () => {
    expect(columnOf(run("TASK-001", "running", "security", step("security", "running")))).toBe("security");
    expect(columnOf(run("TASK-001", "running", "e2e", step("security", "done")))).toBe("e2e");
    // A PR waiting for review, and its review rounds, stay on the board in the Review column.
    expect(columnOf(run("TASK-001", "waiting_review", "pr", step("pr", "done")))).toBe("review");
    expect(columnOf(run("TASK-001", "running", "review_fix", step("review_fix", "running"), { mode: "review" }))).toBe("review");
    expect(columnOf(run("TASK-001", "done", "pr", step("pr", "done")))).toBe("done");
    expect(columnOf(run("TASK-001", "cancelled", "pr", null))).toBe("closed");
  });
});

describe("Board", () => {
  it("shows each task once, in its column, with labelled states and the attention counter", () => {
    const runs = [
      run("TASK-001", "needs_human", "development", step("development", "needs_human", { permissionPrompts: 2 })),
      run("TASK-003", "waiting_review", "pr", step("pr", "done"), { prUrl: "https://x/pull/4", prNumber: 4 }),
    ];
    render(<Board project={project} runs={runs} backlog={backlog} now={61_000} onChanged={() => undefined} />);
    const development = screen.getByRole("region", { name: "Development" });
    expect(within(development).getByText("Add and list todos")).toBeTruthy();
    expect(within(development).getByText("Needs attention")).toBeTruthy();
    expect(within(development).getByText(/2 prompts/)).toBeTruthy();
    const review = within(screen.getByRole("region", { name: "Review" }));
    expect(review.getByText("Health endpoint")).toBeTruthy();
    expect(review.getByText("Awaiting review")).toBeTruthy();
    expect(review.getByText("PR #4")).toBeTruthy();
    const prs = within(screen.getByRole("region", { name: "Pull requests" }));
    expect(prs.getByText("PR #4")).toBeTruthy();
    expect(prs.getByText("Awaiting review")).toBeTruthy();
    expect(screen.getByText("Need attention").parentElement?.textContent).toContain("1");
  });

  it("lists not-started tasks with the dependency they wait for", () => {
    render(<Board project={project} runs={[]} backlog={backlog} now={0} onChanged={() => undefined} />);
    expect(screen.getByText("Waits for TASK-001 merge")).toBeTruthy();
    expect(screen.getAllByText("Ready")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Launch TASK-003" })).toBeTruthy();
  });
});
