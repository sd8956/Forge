import { useEffect, useRef, useState } from "react";
import type { Project } from "../api.js";

/**
 * The sidebar's project switcher. A native select can't be styled once open, so this is a button and a listbox
 * (the ARIA listbox pattern): arrows move, Enter or a click picks, Escape or a click outside closes.
 */
export function ProjectPicker({ projects, value, onChange }: { projects: Project[]; value: string | null; onChange: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const current = projects.find((p) => p.id === value) ?? projects[0];

  useEffect(() => {
    if (!open) return;
    setActive(Math.max(0, projects.findIndex((p) => p.id === current?.id)));
    list.current?.focus();
    const outside = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", outside);
    return () => document.removeEventListener("mousedown", outside);
  }, [open, projects, current?.id]);

  const pick = (id: string) => {
    setOpen(false);
    if (id !== current?.id) onChange(id);
  };

  return (
    <div className="project-picker" ref={root}>
      <button
        type="button"
        className="project-select"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setOpen(true);
          }
        }}
      >
        <span className="muted small">Project</span>
        <span className="project-name">
          {current?.name ?? "No project"}
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <path d="M6 9l6 6 6-6" />
          </svg>
        </span>
      </button>
      {open ? (
        <ul
          ref={list}
          className="project-options"
          role="listbox"
          aria-label="Projects"
          tabIndex={-1}
          aria-activedescendant={projects[active] ? `project-option-${projects[active].id}` : undefined}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") setActive((i) => Math.min(projects.length - 1, i + 1));
            else if (e.key === "ArrowUp") setActive((i) => Math.max(0, i - 1));
            else if (e.key === "Enter" && projects[active]) pick(projects[active].id);
            else if (e.key === "Escape" || e.key === "Tab") setOpen(false);
            else return;
            e.preventDefault();
          }}
        >
          {projects.map((p, i) => (
            <li
              key={p.id}
              id={`project-option-${p.id}`}
              role="option"
              aria-label={p.name}
              aria-selected={p.id === current?.id}
              className={i === active ? "active" : ""}
              onMouseEnter={() => setActive(i)}
              onClick={() => pick(p.id)}
            >
              <span>{p.name}</span>
              <span className="mono small muted">{p.repoPath.split("/").slice(-2).join("/")}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
