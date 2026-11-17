import { execFileSync } from "node:child_process";
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

/** Calls one tool of the orchestrator's `factory` MCP server, as the orchestrator session would. */
async function orchestratorTool(projectId: string, name: string, args: Record<string, unknown>): Promise<{ isError?: boolean; content: { text: string }[] }> {
  const res = await fetch(`${state.url}/mcp/orchestrator/${projectId}`, {
    method: "POST",
    headers: { "x-forge-token": state.token, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  return ((await res.json()) as { result: { isError?: boolean; content: { text: string }[] } }).result;
}

test("approves a proposed plan in the panel, shows why it waits, and pauses and resumes the queue", async ({ page }) => {
  await login(page);
  const projects = await api<{ id: string; repoPath: string }[]>("/projects");
  const projectId = projects.find((p) => p.repoPath === state.project)!.id;
  await page.getByRole("button", { name: "Pause queue" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Queue paused." })).toBeVisible();

  const proposed = await orchestratorTool(projectId, "propose_plan", { rationale: "Health endpoint on its own", waves: [{ tasks: [{ id: "TASK-003", modules: ["src/server"] }] }] });
  expect(proposed.isError).toBeFalsy();
  const plan = page.getByRole("region", { name: "Proposed plan" });
  await expect(plan.getByTestId("plan-task-TASK-003")).toContainText("src/server");
  await expect(plan.getByText("Wave 1")).toBeVisible();
  await page.screenshot({ path: join(shots, "plan.png"), fullPage: true });
  await plan.getByRole("button", { name: "Approve plan" }).click();
  await expect(plan).toBeHidden();

  const queued = page.getByRole("region", { name: "Queued" });
  await expect(queued.getByTestId("queued-TASK-003")).toContainText("Queue paused: Paused by a person");
  await page.getByRole("button", { name: "Resume queue" }).click();
  await expect(page.getByRole("region", { name: "Plan + test plan" }).getByTestId("run-card-TASK-003")).toBeVisible({ timeout: 20_000 });
  await expect(queued.getByText("Nothing queued.")).toBeVisible();
  await expect(page.getByTestId("active-sessions")).toHaveText("1 of 3");
});

test("shows the usage window the status line reports", async ({ page }) => {
  await login(page);
  await expect(page.getByTestId("usage-percent")).toHaveText("—");
  const resetsAt = Math.floor(Date.now() / 1000) + 2 * 3600 + 14 * 60 + 30;
  await fetch(`${state.url}/hooks/usage`, {
    method: "POST",
    headers: { "x-forge-token": state.token, "content-type": "application/json" },
    body: JSON.stringify({ rate_limits: { five_hour: { used_percentage: 62, resets_at: resetsAt } } }),
  });
  await page.reload();
  await expect(page.getByTestId("usage-percent")).toHaveText("62%");
  await expect(page.getByText("Resets in 2 h 14 min")).toBeVisible();
});

test("opens the orchestrator from Launch tasks and types into its session", async ({ page }) => {
  await login(page);
  await page.getByRole("button", { name: "Launch tasks" }).click();
  const pane = page.getByRole("region", { name: "Orchestrator" });
  await expect(pane.getByText("Connected")).toBeVisible();
  await expect(pane.getByTestId("orchestrator-terminal")).toContainText("fake claude ready", { timeout: 20_000 });
  await pane.getByLabel("Message the orchestrator").fill("plan the remaining tasks");
  await pane.getByRole("button", { name: "Send" }).click();
  await expect(pane.getByLabel("Message the orchestrator")).toHaveValue("");
  await expect
    .poll(() => readFileSync(join(state.root, "trace.jsonl"), "utf8").includes("plan the remaining tasks"), { timeout: 10_000 })
    .toBe(true);
  await page.screenshot({ path: join(shots, "orchestrator.png"), fullPage: true });
  await pane.getByRole("button", { name: "Stop" }).click();
  await expect(pane).toBeHidden();
});

test("defines a new project stage by stage: changes, an isolated prototype approved screen by screen, and the definition PR", async ({ page }) => {
  test.setTimeout(120_000);
  await login(page);
  await page.getByRole("link", { name: "Definition" }).click();
  await page.getByLabel("Repository path").fill(state.newApp);
  await page.getByLabel("The idea, in your words").fill("A link shortener for a small team: paste a URL, get a short link.");
  await page.getByRole("button", { name: "Start the definition" }).click();
  await expect(page.getByRole("heading", { name: "Definition" })).toBeVisible();

  const gate = page.getByRole("region", { name: "Gate" });
  const approve = async (stage: string) => {
    await expect(page.getByTestId(`stage-${stage}`)).toContainText("In review", { timeout: 20_000 });
    await gate.getByRole("button", { name: "Approve and continue" }).click();
    await expect(page.getByTestId(`stage-${stage}`)).not.toContainText("In review");
  };

  // Intake: ask for a change, and the relaunched session takes it into account.
  await expect(page.getByTestId("stage-intake")).toContainText("In review", { timeout: 20_000 });
  await expect(page.getByTestId("definition-document")).toContainText("A link shortener for a small team");
  await gate.getByRole("button", { name: "Request changes" }).click();
  await gate.getByLabel("What should change").fill("Say it is web only");
  await gate.getByRole("button", { name: "Send the changes" }).click();
  await expect(page.getByTestId("definition-document")).toContainText("Changed after review: Say it is web only", { timeout: 20_000 });
  await approve("intake");
  await expect(page.getByTestId("stage-intake")).toContainText("shortener · web");
  await expect(page.getByLabel(".factory files")).toContainText("✓ intake.md");

  for (const stage of ["requirements", "architecture", "test_strategy"]) await approve(stage);

  await expect(page.getByTestId("stage-design")).toContainText("In review", { timeout: 20_000 });
  await page.getByRole("tab", { name: "Prototype" }).click();
  const frame = page.frameLocator('iframe[title="Prototype index.html"]');
  await expect(frame.getByRole("heading", { name: "Shorten a link" })).toBeVisible();
  const iframe = page.locator('iframe[title="Prototype index.html"]');
  await expect(iframe).toHaveAttribute("sandbox", "allow-scripts");
  // Its scripts run, but in an opaque origin: it cannot reach the panel.
  const inner = page.frames().find((f) => f.url().includes("/prototype/index.html"));
  if (!inner) throw new Error("prototype frame not found");
  // Expressions as strings: they run inside the frame, and the e2e tsconfig has no DOM types.
  expect(await inner.evaluate("document.title")).toBe("prototype ran");
  expect(await inner.evaluate("(() => { try { return window.parent.document.title; } catch { return 'blocked'; } })()")).toBe("blocked");
  await page.screenshot({ path: join(shots, "definition.png"), fullPage: true });

  // Asking for a change reloads the open prototype by itself once the new session rewrites it.
  await expect(frame.getByText("Design attempt 1")).toBeVisible();
  await gate.getByRole("button", { name: "Request changes" }).click();
  await gate.getByLabel("What should change").fill("Make the form wider");
  await gate.getByRole("button", { name: "Send the changes" }).click();
  await expect(page.getByTestId("stage-design")).toContainText("In review", { timeout: 20_000 });
  await expect(page.frameLocator('iframe[title="Prototype index.html"]').getByText("Design attempt 2")).toBeVisible({ timeout: 20_000 });

  await gate.getByRole("button", { name: "Approve and continue" }).click();
  await expect(gate.getByRole("alert")).toContainText("Approve every screen first: index.html, stats.html");
  await page.getByRole("button", { name: "Approve screen index.html" }).click();
  await page.getByRole("button", { name: "Approve screen stats.html" }).click();
  await approve("design");
  await expect(page.getByTestId("stage-backlog")).toContainText("In review", { timeout: 20_000 });
  // Tabs follow the order the stages wrote them.
  const tabs = await page.getByRole("tab").allTextContents();
  expect(tabs.slice(-2)).toEqual(["Prototype", "backlog"]);
  await approve("backlog");
  await expect(page.getByRole("link", { name: "Definition PR" })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("Definition approved.")).toBeVisible();

  // The person merges the PR on GitHub; Forge notices, pulls main into the clone and says so.
  const prNumber = (await page.getByRole("link", { name: "Definition PR" }).getAttribute("href"))!.split("/").at(-1)!;
  execFileSync("git", ["-C", `${state.newApp}-origin.git`, "update-ref", "refs/heads/main", "refs/heads/forge/definition"]);
  const gh = JSON.parse(readFileSync(state.ghState, "utf8")) as { prs: Record<string, { state: string }> };
  gh.prs[prNumber]!.state = "MERGED";
  writeFileSync(state.ghState, JSON.stringify(gh));
  await expect(page.getByText("Definition merged.")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("link", { name: "Plan the backlog in Execution" })).toBeVisible();
});
