import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { STATE_FILE, type E2eState } from "./global-setup.js";

const state = JSON.parse(readFileSync(STATE_FILE, "utf8")) as E2eState;
const shots = join(import.meta.dirname, "..", "..", "..", ".forge-e2e", "screenshots");

async function api<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${state.url}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "x-forge-token": state.token, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return (await res.json()) as T;
}

async function login(page: Page) {
  const { url } = await api<{ url: string }>("/auth/login-link", {});
  await page.goto(url);
  await expect(page.getByRole("heading", { name: "Execution" })).toBeVisible();
}

test.describe.configure({ mode: "serial" });

test("asks for a login link without a session", async ({ page }) => {
  await page.goto(state.url);
  await expect(page.getByText("Open the login link")).toBeVisible();
});

test("adds a project from the empty panel", async ({ page }) => {
  const { url } = await api<{ url: string }>("/auth/login-link", {});
  await page.goto(url);
  await expect(page.getByRole("heading", { name: "Add a project" })).toBeVisible();
  await page.getByLabel("Repository path").fill(`${state.project}/missing`);
  await page.getByRole("button", { name: "Add project" }).click();
  await expect(page.getByRole("alert")).toContainText("Not a git repository");
  await page.getByLabel("Repository path").fill(state.project);
  await page.getByRole("button", { name: "Add project" }).click();
  await expect(page.getByRole("heading", { name: "Execution" })).toBeVisible();
  await expect(page.getByText("Add and list todos")).toBeVisible();
});

test("shows a run moving across the board live, ending in Awaiting review", async ({ page }) => {
  await login(page);
  await api("/runs", { projectPath: state.project, taskId: "TASK-001" });
  const card = page.getByTestId("run-card-TASK-001");
  await expect(card).toBeVisible();
  const prs = page.getByRole("region", { name: "Pull requests" });
  await expect(prs.getByTestId("run-card-TASK-001")).toBeVisible({ timeout: 40_000 });
  await expect(prs.getByText("Awaiting review")).toBeVisible();
  await expect(prs.getByText("PR #7")).toBeVisible();
  await page.screenshot({ path: join(shots, "board.png"), fullPage: true });
});

test("shows the pipeline, the evidence and the artifacts of a run", async ({ page }) => {
  await login(page);
  await page.getByTestId("run-card-TASK-001").click();
  await expect(page.getByRole("heading", { name: "Add and list todos" })).toBeVisible();
  await expect(page.getByText(/Covers FR-001, FR-002 · size S/)).toBeVisible();
  await expect(page.getByRole("heading", { name: "Pipeline" })).toBeVisible();
  for (const label of ["Plan + test plan", "Technical design", "Development", "Security", "E2E tests", "Pull request"]) {
    await expect(page.locator(".timeline").getByText(label)).toBeVisible();
  }
  await page.getByRole("tab", { name: "Test plan and evidence" }).click();
  await expect(page.getByRole("cell", { name: "TC-01" })).toBeVisible();
  await expect(page.getByRole("row", { name: /TC-04/ }).getByText("Passed")).toBeVisible();
  await page.screenshot({ path: join(shots, "run-evidence.png"), fullPage: true });

  await page.getByRole("tab", { name: "Artifacts" }).click();
  await page.getByRole("button", { name: "plan/1/output.md" }).click();
  await expect(page.locator("pre.doc")).toContainText("step: plan");
  await expect(page.getByText("No blockers")).toBeVisible();
});

test("refuses to launch a task whose dependency is not merged", async ({ page }) => {
  await login(page);
  await expect(page.getByText("Waits for TASK-001 merge")).toBeVisible();
  await page.getByRole("button", { name: "Launch TASK-002" }).click();
  await expect(page.getByRole("alert")).toContainText("TASK-002 depends on TASK-001, which is not merged into main yet");
});

test("watches a live session read-only, takes control explicitly, and cancels the run", async ({ page }) => {
  await login(page);
  await page.getByRole("button", { name: "Launch TASK-003" }).click();
  const card = page.getByRole("region", { name: "Plan + test plan" }).getByTestId("run-card-TASK-003");
  await expect(card).toBeVisible();
  await card.click();
  await expect(page.getByTestId("terminal")).toContainText("fake claude ready: plan attempt 1", { timeout: 20_000 });
  await expect(page.getByText("read-only")).toBeVisible();
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: "Take control" }).click();
  await expect(page.getByText("you have control")).toBeVisible();
  await expect(page.getByTestId("terminal")).toContainText("fake claude ready");
  await page.screenshot({ path: join(shots, "terminal.png"), fullPage: true });
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByText("Run cancelled.")).toBeVisible();
});

test("answers a review comment and shows the thread as answered", async ({ page }) => {
  await login(page);
  const gh = JSON.parse(readFileSync(state.ghState, "utf8")) as { prs: Record<string, { comments: unknown[] }> };
  gh.prs["7"]?.comments.push({ id: 51, login: "sd8956", body: "Please rename createTodo", path: "src/server.js", line: 3, url: "https://github.com/example/demo-project/pull/7#discussion_r51" });
  writeFileSync(state.ghState, JSON.stringify(gh));
  await expect(page.getByRole("region", { name: "Pull requests" }).getByText(/review round 1/)).toBeVisible({ timeout: 40_000 });
  await page.getByTestId("run-card-TASK-001").click();
  await page.getByRole("tab", { name: "Review" }).click();
  await expect(page.getByRole("row", { name: /review_comment:51/ }).getByText("Answered")).toBeVisible();
  await expect(page.locator(".timeline").getByText("Review fix")).toBeVisible();
  await page.screenshot({ path: join(shots, "review.png"), fullPage: true });
});
