import { execFileSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startBackend, type Backend } from "../src/app.js";
import { Tmux } from "../src/runner/tmux.js";
import { Api, disposeTmux, FAKE_GH, FIXTURE, makeProject, REPO_ROOT, scratch, StubMemory, testConfig, removeScratch } from "./helpers.js";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const SKILL = ".claude/skills/pr-thread-reply/SKILL.md";
const CUSTOM = ".claude/skills/security-scan/SKILL.md";

/** The first version of a template file in Forge's own history: what an old project still has. */
function oldestTemplateVersion(rel: string): string {
  const path = `fixtures/demo-project/${rel}`;
  const first = execFileSync("git", ["-C", REPO_ROOT, "log", "--format=%H", "--reverse", "--", path], { encoding: "utf8" }).split("\n")[0]!;
  return execFileSync("git", ["-C", REPO_ROOT, "show", `${first}:${path}`], { encoding: "utf8" });
}

async function setup() {
  const root = scratch();
  const project = makeProject(root);
  const origin = join(root, "origin.git");
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], { encoding: "utf8" });
  writeFileSync(join(project, SKILL), oldestTemplateVersion(SKILL));
  writeFileSync(join(project, CUSTOM), `${readFileSync(join(FIXTURE, CUSTOM), "utf8")}\nProject rule: also run our own scanner.\n`);
  git(project, "commit", "-qam", "an older Forge template, and our own security note");
  // A GitHub-looking remote that really is a local bare repository.
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  git(project, "remote", "add", "origin", "git@github.com:example/demo-project.git");
  git(project, "config", `url.${origin}.insteadOf`, "git@github.com:example/demo-project.git");
  git(project, "push", "-q", "-u", "origin", "main");
  const ghState = join(root, "gh.json");
  writeFileSync(ghState, JSON.stringify({ login: "sd8956", prs: {}, logs: {} }));
  process.env.FAKE_GH_STATE = ghState;
  const config = testConfig(root, { ghBin: FAKE_GH, extraEnv: { FAKE_GH_STATE: ghState } });
  const tmux = new Tmux(config.tmuxSocket);
  const backend: Backend = await startBackend(config, { memory: new StubMemory() });
  cleanups.push(() => removeScratch(root));
  cleanups.push(() => disposeTmux(tmux, config.tmuxSocket));
  cleanups.push(() => backend.close());
  const api = new Api(backend.url, backend.token);
  const { id } = (await api.request("POST", "/projects", { path: project })).body as { id: string };
  const gh = () => JSON.parse(readFileSync(ghState, "utf8")) as { prs: Record<string, { headRefName: string; title: string; body: string; state: string }> };
  return { root, project, origin, git, api, id, gh };
}

describe("template sync", () => {
  it("opens one PR that updates untouched Forge files, adds new ones and lists the project's own changes, leaving the checkout alone", async () => {
    const ctx = await setup();
    // The project keeps the configured GitHub URL even though git rewrites it to a local path (insteadOf).
    expect(((await ctx.api.request("GET", "/projects")).body as { remote: string }[])[0]?.remote).toBe("git@github.com:example/demo-project.git");
    const first = (await ctx.api.request("POST", `/projects/${ctx.id}/template/sync`)).body as { status: string; prUrl: string; updated: string[]; added: string[]; customized: string[] };
    expect(first).toMatchObject({ status: "pr_opened", prUrl: expect.stringMatching(/\/pull\/\d+$/) as string, customized: [CUSTOM] });
    expect(first.updated).toContain(SKILL);

    const prs = Object.values(ctx.gh().prs);
    expect(prs).toEqual([expect.objectContaining({ headRefName: "forge/template-update", title: "chore: update Forge files", state: "OPEN" })]);
    expect(prs[0]?.body).toContain(SKILL);
    expect(prs[0]?.body).toContain(CUSTOM);

    // The branch on the remote has the current template, and the project's own change is untouched.
    const show = (rel: string) => execFileSync("git", ["-C", ctx.origin, "show", `forge/template-update:${rel}`], { encoding: "utf8" });
    expect(show(SKILL)).toBe(readFileSync(join(FIXTURE, SKILL), "utf8"));
    expect(show(CUSTOM)).toContain("Project rule: also run our own scanner.");
    // The person's checkout did not change.
    expect(ctx.git(ctx.project, "status", "--porcelain")).toBe("");
    expect(readFileSync(join(ctx.project, SKILL), "utf8")).toBe(oldestTemplateVersion(SKILL));
    expect(ctx.git(ctx.project, "worktree", "list")).not.toContain("forge-template");

    // Checking again finds the open PR and opens no second one.
    const again = (await ctx.api.request("POST", `/projects/${ctx.id}/template/sync`)).body as { status: string; prUrl: string };
    expect(again).toMatchObject({ status: "pr_open", prUrl: first.prUrl });
    expect(Object.keys(ctx.gh().prs)).toHaveLength(1);
    expect(((await ctx.api.request("GET", `/projects/${ctx.id}/template`)).body as { status: string }).status).toBe("pr_open");

    // main moves on (another task merged): the branch is rebuilt on it and the open PR gets a new commit.
    writeFileSync(join(ctx.project, "NOTES.md"), "merged meanwhile\n");
    ctx.git(ctx.project, "add", "NOTES.md");
    ctx.git(ctx.project, "commit", "-qm", "another task");
    ctx.git(ctx.project, "push", "-q", "origin", "main");
    const updated = (await ctx.api.request("POST", `/projects/${ctx.id}/template/sync`)).body as { status: string; prUrl: string };
    expect(updated).toMatchObject({ status: "pr_updated", prUrl: first.prUrl });
    expect(execFileSync("git", ["-C", ctx.origin, "show", "forge/template-update:NOTES.md"], { encoding: "utf8" })).toBe("merged meanwhile\n");
    expect(Object.keys(ctx.gh().prs)).toHaveLength(1);
  }, 120_000);

  it("reports up to date once the update is merged", async () => {
    const ctx = await setup();
    await ctx.api.request("POST", `/projects/${ctx.id}/template/sync`);
    // The person merges the PR on GitHub.
    execFileSync("git", ["-C", ctx.origin, "update-ref", "refs/heads/main", "refs/heads/forge/template-update"]);
    const state = ctx.gh();
    for (const pr of Object.values(state.prs)) pr.state = "MERGED";
    writeFileSync(join(ctx.root, "gh.json"), JSON.stringify(state));
    const after = (await ctx.api.request("POST", `/projects/${ctx.id}/template/sync`)).body as { status: string; customized: string[] };
    expect(after).toMatchObject({ status: "up_to_date", customized: [CUSTOM] });
    expect(Object.keys(ctx.gh().prs)).toHaveLength(1);
  }, 120_000);

  it("skips a project without a GitHub remote", async () => {
    const root = scratch();
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const project = makeProject(root);
    const config = testConfig(root);
    const backend = await startBackend(config, { memory: new StubMemory() });
    cleanups.push(() => backend.close());
    const api = new Api(backend.url, backend.token);
    const { id } = (await api.request("POST", "/projects", { path: project })).body as { id: string };
    expect((await api.request("POST", `/projects/${id}/template/sync`)).body).toMatchObject({ status: "skipped", reason: "The project has no GitHub remote" });
  });
});
