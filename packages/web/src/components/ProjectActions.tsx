import { useState } from "react";
import { api, type Project } from "../api.js";
import { Icon } from "./Icon.js";

/** Opens the selected project in the person's editor or file manager (the commands are set in Settings). */
export function ProjectActions({ project }: { project: Project }) {
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const open = (target: "editor" | "files") =>
    void api.openProject(project.id, target).then(
      () => setMessage({ text: target === "editor" ? "Opened in the editor." : "Opened the folder.", error: false }),
      (e: unknown) => setMessage({ text: e instanceof Error ? e.message : String(e), error: true }),
    );
  return (
    <div className="project-actions">
      <div className="actions">
        <button type="button" className="btn small-btn" aria-label="Open in editor" title={`Open ${project.repoPath} in the editor`} onClick={() => open("editor")}>
          <Icon name="code" /> Editor
        </button>
        <button type="button" className="btn small-btn" aria-label="Open folder" title={`Open ${project.repoPath} in the file manager`} onClick={() => open("files")}>
          <Icon name="folder" /> Folder
        </button>
      </div>
      {message ? (
        <p role={message.error ? "alert" : "status"} className="small" style={message.error ? { color: "var(--st-failed-fg)" } : { color: "var(--text-muted)" }}>
          {message.text}
        </p>
      ) : null}
    </div>
  );
}
