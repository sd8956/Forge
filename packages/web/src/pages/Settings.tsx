import { useEffect, useState } from "react";
import { api, type ForgeSettings, type Project, type ProjectSettings, type TemplateSync } from "../api.js";

function useMessage() {
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const run = <T,>(call: Promise<T>, done: (value: T) => void, ok: string) =>
    void call.then(
      (value) => {
        done(value);
        setMessage({ text: ok, error: false });
      },
      (e: unknown) => setMessage({ text: e instanceof Error ? e.message : String(e), error: true }),
    );
  return { message, run };
}

function Message({ message }: { message: { text: string; error: boolean } | null }) {
  if (!message) return null;
  return (
    <p role={message.error ? "alert" : "status"} className="small" style={message.error ? { color: "var(--st-failed-fg)" } : undefined}>
      {message.text}
    </p>
  );
}

function Limits({ settings, onSaved }: { settings: ForgeSettings; onSaved: (s: ForgeSettings) => void }) {
  const [max, setMax] = useState(String(settings.maxConcurrency));
  const [usage, setUsage] = useState(String(settings.usagePausePercent));
  const { message, run } = useMessage();
  return (
    <section className="card panel settings-section" aria-label="Sessions and usage">
      <h2>Sessions and usage</h2>
      <p className="muted small">How many Claude Code sessions run at once across projects, and the 5-hour usage at which new tasks stop starting.</p>
      <form
        className="settings-grid"
        onSubmit={(e) => {
          e.preventDefault();
          run(api.updateSettings({ maxConcurrency: Number(max), usagePausePercent: Number(usage) }), onSaved, "Saved.");
        }}
      >
        <label htmlFor="max-sessions">Max sessions</label>
        <input id="max-sessions" className="field" type="number" min={1} max={10} value={max} onChange={(e) => setMax(e.target.value)} />
        <label htmlFor="usage-pause">Pause new tasks at (%)</label>
        <input id="usage-pause" className="field" type="number" min={1} max={100} value={usage} onChange={(e) => setUsage(e.target.value)} />
        <span />
        <button type="submit" className="btn primary">Save</button>
      </form>
      <Message message={message} />
    </section>
  );
}

function Authentication({ settings, onSaved }: { settings: ForgeSettings; onSaved: (s: ForgeSettings) => void }) {
  const [key, setKey] = useState("");
  const { message, run } = useMessage();
  return (
    <section className="card panel settings-section" aria-label="Claude authentication">
      <h2>Claude authentication</h2>
      <p className="muted small">
        Sessions use your Claude subscription login by default. An Anthropic API key is the fallback if automation outside normal subscription use is not
        allowed. The key is stored only in a private file in Forge's home; sessions read it through Claude Code's apiKeyHelper, never from their environment.
      </p>
      <fieldset className="auth-choice">
        <legend className="sr-only">Authentication</legend>
        <label>
          <input type="radio" name="auth" checked={settings.auth === "subscription"} onChange={() => run(api.updateSettings({ auth: "subscription" }), onSaved, "Sessions use your subscription.")} />
          Subscription
        </label>
        <label>
          <input type="radio" name="auth" checked={settings.auth === "api_key"} onChange={() => run(api.updateSettings({ auth: "api_key" }), onSaved, "Sessions use the API key.")} />
          API key
        </label>
      </fieldset>
      <p className="small" data-testid="api-key-status">{settings.apiKey.configured ? `Key ending in ${settings.apiKey.last4 ?? ""}` : "No API key saved."}</p>
      <form
        className="settings-grid"
        onSubmit={(e) => {
          e.preventDefault();
          run(api.saveApiKey(key.trim()), (s) => { setKey(""); onSaved(s); }, "API key saved.");
        }}
      >
        <label htmlFor="api-key">Anthropic API key</label>
        <input id="api-key" className="field mono" type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} placeholder="sk-ant-…" />
        <span />
        <div className="actions">
          <button type="submit" className="btn primary" disabled={!key.trim()}>Save key</button>
          {settings.apiKey.configured ? <button type="button" className="btn" onClick={() => run(api.removeApiKey(), onSaved, "API key removed.")}>Remove key</button> : null}
        </div>
      </form>
      <Message message={message} />
    </section>
  );
}

function templateText(t: TemplateSync): string {
  const changed = (t.updated?.length ?? 0) + (t.added?.length ?? 0);
  const kept = t.customized?.length ? ` · ${t.customized.length} changed in this project, left alone` : "";
  switch (t.status) {
    case "never_checked":
      return "Not checked yet";
    case "up_to_date":
      return `Up to date${kept}`;
    case "pr_opened":
    case "pr_updated":
    case "pr_open":
      return `${changed} file${changed === 1 ? "" : "s"} to update, in a pull request${kept}`;
    case "skipped":
      return `Not checked: ${t.reason ?? ""}`;
    default:
      return `Check failed: ${t.reason ?? ""}`;
  }
}

/** Forge keeps a project's agents, skills and step settings current through a PR; this shows where it stands. */
function TemplateRow({ project }: { project: Project }) {
  const [sync, setSync] = useState<TemplateSync | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void api.templateStatus(project.id).then(setSync, () => setSync(null));
  }, [project.id]);
  return (
    <>
      <dt>Forge files</dt>
      <dd className="template-row">
        <span data-testid="template-status">{sync ? templateText(sync) : "…"}</span>
        {sync?.prUrl ? <a href={sync.prUrl} target="_blank" rel="noreferrer">Open the PR</a> : null}
        <button
          type="button"
          className="btn"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void api.syncTemplate(project.id).then(setSync, () => undefined).finally(() => setBusy(false));
          }}
        >
          {busy ? "Checking…" : "Check now"}
        </button>
      </dd>
    </>
  );
}

function Apps({ settings, onSaved }: { settings: ForgeSettings; onSaved: (s: ForgeSettings) => void }) {
  const [editor, setEditor] = useState(settings.editorCommand);
  const [files, setFiles] = useState(settings.fileManagerCommand);
  const { message, run } = useMessage();
  return (
    <section className="card panel settings-section" aria-label="Apps">
      <h2>Apps</h2>
      <p className="muted small">The programs "Open in editor" and "Open folder" start with the project's folder: a program name or a path, such as code, codium or thunar.</p>
      <form
        className="settings-grid"
        onSubmit={(e) => {
          e.preventDefault();
          run(api.updateSettings({ editorCommand: editor.trim(), fileManagerCommand: files.trim() }), onSaved, "Saved.");
        }}
      >
        <label htmlFor="editor-command">Editor command</label>
        <input id="editor-command" className="field mono" value={editor} onChange={(e) => setEditor(e.target.value)} />
        <label htmlFor="files-command">File manager command</label>
        <input id="files-command" className="field mono" value={files} onChange={(e) => setFiles(e.target.value)} />
        <span />
        <button type="submit" className="btn primary">Save</button>
      </form>
      <Message message={message} />
    </section>
  );
}

function ProjectSection({ project }: { project: Project }) {
  const [settings, setSettings] = useState<ProjectSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void api.projectSettings(project.id).then(setSettings, (e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [project.id]);
  return (
    <section className="card panel settings-section" aria-label="Project settings">
      <h2>Project · {project.name}</h2>
      {error ? <p role="alert">{error}</p> : null}
      {settings ? (
        <>
          <p className="muted small">These come from <span className="mono path">{settings.file}</span>, the project's source of truth. Edit them there and commit.</p>
          {/* Literal values in mono; defaults that come from Forge in plain muted text. */}
          <dl className="settings-list">
            <dt>Permission mode</dt>
            <dd className="mono">{settings.permissionMode}</dd>
            <dt>Max sessions for this project</dt>
            <dd>{settings.maxConcurrency !== null ? <span className="mono">{settings.maxConcurrency}</span> : <span className="muted">Forge's limit</span>}</dd>
            <dt>Extra review authors</dt>
            <dd>{settings.allowedAuthors.length ? <span className="mono">{settings.allowedAuthors.join(", ")}</span> : <span className="muted">None: write collaborators only</span>}</dd>
            <dt>PR poll interval</dt>
            <dd>{settings.pollIntervalSeconds ? <span className="mono">{settings.pollIntervalSeconds} s</span> : <span className="muted">Forge's default</span>}</dd>
            <TemplateRow project={project} />
            <dt>Commands</dt>
            <dd>
              <table className="commands" aria-label="Commands">
                <tbody>
                  {Object.entries(settings.commands).map(([name, command]) => (
                    <tr key={name}>
                      <td className="muted">{name}</td>
                      <td className="mono">{command}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </dd>
          </dl>
        </>
      ) : null}
    </section>
  );
}

export function SettingsPage({ project }: { project: Project | null }) {
  const [settings, setSettings] = useState<ForgeSettings | null>(null);
  useEffect(() => {
    void api.settings().then(setSettings);
  }, []);
  return (
    <>
      <div className="page-header">
        <div>
          <h1>Settings</h1>
          <div className="muted">Forge-wide settings, and the selected project's</div>
        </div>
      </div>
      {settings ? (
        <>
          <Limits settings={settings} onSaved={setSettings} />
          <Authentication settings={settings} onSaved={setSettings} />
          <Apps settings={settings} onSaved={setSettings} />
        </>
      ) : (
        <p className="muted">Loading…</p>
      )}
      {project ? <ProjectSection project={project} /> : null}
    </>
  );
}
