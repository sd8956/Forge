#!/usr/bin/env node
// Fake `gh` for integration tests. State lives in the JSON file FAKE_GH_STATE, which tests edit:
// { login, prs: { "<n>": { state, headRefOid, statusCheckRollup, comments, issueComments, reviews, body } },
//   logs: { "<actions run id>": "log" } }
// Only commands that change something write the state back, so a test editing the file while the
// watcher reads it never loses its edit. Every call is appended to FAKE_GH_STATE.calls (JSONL).
// It implements exactly the gh commands Forge and the fake claude use.
import { appendFileSync, readFileSync, renameSync, writeFileSync } from "node:fs";

const file = process.env.FAKE_GH_STATE;
if (!file) {
  process.stderr.write("FAKE_GH_STATE is not set\n");
  process.exit(2);
}
const state = JSON.parse(readFileSync(file, "utf8"));
const args = process.argv.slice(2);
appendFileSync(`${file}.calls`, `${JSON.stringify(args)}\n`);

let changed = false;
const save = () => {
  if (!changed) return;
  writeFileSync(`${file}.tmp`, JSON.stringify(state, null, 2));
  renameSync(`${file}.tmp`, file);
};
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const field = (name) => {
  const raw = args.find((a, i) => args[i - 1] === "-f" && a.startsWith(`${name}=`))?.slice(name.length + 1);
  if (raw !== undefined) return raw;
  // -F name=@file reads the value from a file, like gh does.
  const typed = args.find((a, i) => args[i - 1] === "-F" && a.startsWith(`${name}=`))?.slice(name.length + 1);
  return typed?.startsWith("@") ? readFileSync(typed.slice(1), "utf8") : typed;
};
const pr = (n) => {
  const found = state.prs?.[String(n)];
  if (!found) {
    process.stderr.write(`no pull request found for ${n}\n`);
    save();
    process.exit(1);
  }
  return found;
};
const nextId = () => (state.nextId = (state.nextId ?? 1000) + 1);
const lines = (items) => process.stdout.write(items.map((i) => JSON.stringify(i)).join("\n") + (items.length ? "\n" : ""));

const [cmd, sub] = args;
if (cmd === "pr" && sub === "view") {
  const p = pr(args[2]);
  const out = {};
  for (const key of (flag("--json") ?? "").split(",")) out[key] = p[key];
  process.stdout.write(JSON.stringify(out));
} else if (cmd === "pr" && sub === "list") {
  // Only what Forge asks: the URL of the open PR for a head branch, or nothing.
  const head = flag("--head");
  const found = Object.entries(state.prs ?? {}).find(([, p]) => p.headRefName === head && p.state === "OPEN");
  process.stdout.write(found ? `https://github.com/example/repo/pull/${found[0]}\n` : "\n");
} else if (cmd === "pr" && sub === "create") {
  const number = Object.keys(state.prs ?? {}).length + 100;
  state.prs = { ...state.prs, [number]: { state: "OPEN", headRefOid: "def0000", headRefName: flag("--head"), baseRefName: flag("--base"), title: flag("--title"), body: flag("--body"), statusCheckRollup: [], comments: [], issueComments: [], reviews: [] } };
  changed = true;
  process.stdout.write(`https://github.com/example/repo/pull/${number}\n`);
} else if (cmd === "pr" && sub === "edit") {
  pr(args[2]).body = readFileSync(flag("--body-file"), "utf8");
  changed = true;
} else if (cmd === "run" && sub === "view") {
  process.stdout.write(state.logs?.[args[2]] ?? "");
} else if (cmd === "api") {
  const path = args.find((a, i) => i > 0 && a.startsWith("repos/"));
  const post = flag("-X") === "POST";
  let m;
  if (post && (m = /pulls\/(\d+)\/comments\/(\d+)\/replies$/.exec(path))) {
    const p = pr(m[1]);
    const parent = p.comments.find((c) => c.id === Number(m[2]));
    const reply = { id: nextId(), login: state.login, body: field("body"), path: parent?.path ?? null, line: parent?.line ?? null, url: `https://github.com/r/pull/${m[1]}#discussion_r${state.nextId}` };
    p.comments.push(reply);
    changed = true;
    process.stdout.write(JSON.stringify({ id: reply.id }));
  } else if (post && (m = /issues\/(\d+)\/comments$/.exec(path))) {
    const p = pr(m[1]);
    const comment = { id: nextId(), login: state.login, body: field("body"), url: `https://github.com/r/pull/${m[1]}#issuecomment-${state.nextId}` };
    p.issueComments.push(comment);
    changed = true;
    process.stdout.write(JSON.stringify({ id: comment.id }));
  } else if ((m = /pulls\/(\d+)\/comments$/.exec(path))) {
    lines(pr(m[1]).comments.map(({ id, login, body, path: p, line, url }) => ({ id, login, body, path: p, line, url })));
  } else if ((m = /issues\/(\d+)\/comments$/.exec(path))) {
    lines(pr(m[1]).issueComments.map(({ id, login, body, url }) => ({ id, login, body, url })));
  } else if (/\/collaborators$/.test(path)) {
    lines((state.collaborators ?? []).map(({ login, push }) => ({ login, push })));
  } else if ((m = /pulls\/(\d+)\/reviews$/.exec(path))) {
    lines(pr(m[1]).reviews.map(({ id, login, body, state: s, url }) => ({ id, login, body, state: s, url })));
  } else {
    process.stderr.write(`fake gh: unsupported api call ${args.join(" ")}\n`);
    save();
    process.exit(1);
  }
} else {
  process.stderr.write(`fake gh: unsupported command ${args.join(" ")}\n`);
  save();
  process.exit(1);
}
save();
