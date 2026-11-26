import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
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
  it("shows a run in code review in its own column, between E2E and the pull request", () => {
    render(<Board project={project} runs={[run("TASK-001", "running", "code_review", step("code_review", "running"))]} backlog={backlog} now={61_000} onChanged={() => undefined} />);
    expect(within(screen.getByRole("region", { name: "Code review" })).getByText("Add and list todos")).toBeTruthy();
    const names = screen.getAllByRole("region").map((r) => r.getAttribute("aria-label"));
    expect(names.indexOf("Code review")).toBe(names.indexOf("E2E tests") + 1);
    expect(names.indexOf("Pull request")).toBe(names.indexOf("Code review") + 1);
  });

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
    // The PR number opens the PR on GitHub; the rest of the card still opens the run.
    const prLink = review.getByRole("link", { name: "PR #4" });
    expect(prLink.getAttribute("href")).toBe("https://x/pull/4");
    expect(prLink.getAttribute("target")).toBe("_blank");
    expect(review.getByRole("link", { name: /Health endpoint/ }).getAttribute("href")).toBe("#/runs/run-TASK-003");
    fireEvent.click(screen.getByRole("tab", { name: /Pull requests/ }));
    const prs = within(screen.getByRole("tabpanel", { name: "Pull requests" }));
    expect(prs.getByText("PR #4")).toBeTruthy();
    expect(prs.getByText("Awaiting review")).toBeTruthy();
    expect(screen.getByText("Need attention").parentElement?.textContent).toContain("1");
  });

  it("lists not-started tasks with the dependency they wait for", () => {
    render(<Board project={project} runs={[]} backlog={backlog} now={0} onChanged={() => undefined} />);
    fireEvent.click(screen.getByRole("tab", { name: /Backlog/ }));
    expect(screen.getByText("Waits for TASK-001 merge")).toBeTruthy();
    expect(screen.getAllByText("Ready")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Launch TASK-003" })).toBeTruthy();
  });

  it("shows one list at a time behind tabs that carry their counts", () => {
    const runs = [run("TASK-001", "waiting_review", "pr", step("pr", "done"), { prUrl: "https://x/pull/4", prNumber: 4 })];
    render(<Board project={project} runs={runs} backlog={backlog} now={0} onChanged={() => undefined} />);
    expect(screen.getByRole("tab", { name: "Queued 0" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Pull requests 1" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Backlog 2" })).toBeTruthy();
    expect(screen.getAllByRole("tabpanel")).toHaveLength(1);
    fireEvent.click(screen.getByRole("tab", { name: "Backlog 2" }));
    expect(screen.getByRole("tab", { name: "Backlog 2" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tabpanel", { name: "Backlog" })).toBeTruthy();
    expect(screen.queryByRole("tabpanel", { name: "Pull requests" })).toBeNull();
    expect(screen.queryByTestId("pr-row-TASK-001")).toBeNull();
  });

  it("pages long lists ten at a time", () => {
    const many: BacklogTask[] = Array.from({ length: 23 }, (_, i) => ({ id: `TASK-${String(i + 1).padStart(3, "0")}`, title: `Task ${i + 1}`, size: "S", covers: [], dependsOn: [], latestRun: null }));
    render(<Board project={project} runs={[]} backlog={many} now={0} onChanged={() => undefined} />);
    fireEvent.click(screen.getByRole("tab", { name: /Backlog/ }));
    const panel = within(screen.getByRole("tabpanel", { name: "Backlog" }));
    expect(panel.getAllByRole("button", { name: /^Launch / })).toHaveLength(10);
    expect(panel.getByText("1–10 of 23")).toBeTruthy();
    expect(panel.getByRole<HTMLButtonElement>("button", { name: "Previous page" }).disabled).toBe(true);
    fireEvent.click(panel.getByRole("button", { name: "Next page" }));
    expect(panel.getByText("11–20 of 23")).toBeTruthy();
    expect(panel.getByRole("button", { name: "Launch TASK-011" })).toBeTruthy();
    expect(panel.queryByRole("button", { name: "Launch TASK-001" })).toBeNull();
    fireEvent.click(panel.getByRole("button", { name: "Next page" }));
    expect(panel.getAllByRole("button", { name: /^Launch / })).toHaveLength(3);
    expect(panel.getByRole<HTMLButtonElement>("button", { name: "Next page" }).disabled).toBe(true);
  });

  it("lists open pull requests first, then merged ones from the newest", () => {
    const runs = [
      run("TASK-001", "done", "pr", step("pr", "done"), { prNumber: 1, endedAt: 1_000 }),
      run("TASK-002", "done", "pr", step("pr", "done"), { prNumber: 2, endedAt: 3_000 }),
      run("TASK-003", "waiting_review", "pr", step("pr", "done"), { prNumber: 3 }),
    ];
    render(<Board project={project} runs={runs} backlog={backlog} now={0} onChanged={() => undefined} />);
    fireEvent.click(screen.getByRole("tab", { name: /Pull requests/ }));
    const rows = within(screen.getByRole("tabpanel", { name: "Pull requests" })).getAllByTestId(/^pr-row-/);
    expect(rows.map((r) => r.getAttribute("data-testid"))).toEqual(["pr-row-TASK-003", "pr-row-TASK-002", "pr-row-TASK-001"]);
  });
});
