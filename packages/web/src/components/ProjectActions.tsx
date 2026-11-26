import { useState } from "react";
import { api, type Project } from "../api.js";
import { Icon } from "./Icon.js";

/** Opens the selected project in the person's editor or file manager (the commands are set in Settings). */
export function ProjectActions({ project }: { project: Project }) {
  // Success shows as the editor or folder opening; only a failure needs words.
  const [error, setError] = useState<string | null>(null);
  const open = (target: "editor" | "files") =>
    void api.openProject(project.id, target).then(
      () => setError(null),
      (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
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
      {error ? (
        <p role="alert" className="small" style={{ color: "var(--st-failed-fg)" }}>
          {error}
        </p>
      ) : null}
    </div>
  );
}
