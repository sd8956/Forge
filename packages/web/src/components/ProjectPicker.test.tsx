import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Project } from "../api.js";
import { ProjectPicker } from "./ProjectPicker.js";

const projects: Project[] = [
  { id: "p1", name: "demo-project", repoPath: "/a", remote: null, defaultBranch: "main" },
  { id: "p2", name: "daily-tasks", repoPath: "/b", remote: null, defaultBranch: "main" },
];

afterEach(cleanup);

describe("ProjectPicker", () => {
  it("shows the current project and picks another with the mouse", () => {
    const onChange = vi.fn();
    render(<ProjectPicker projects={projects} value="p1" onChange={onChange} />);
    const button = screen.getByRole("button", { name: /Project.*demo-project/ });
    expect(button.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(button);
    expect(screen.getByRole("listbox", { name: "Projects" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "demo-project" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.click(screen.getByRole("option", { name: "daily-tasks" }));
    expect(onChange).toHaveBeenCalledWith("p2");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("works with the keyboard and closes with Escape", () => {
    const onChange = vi.fn();
    render(<ProjectPicker projects={projects} value="p1" onChange={onChange} />);
    const button = screen.getByRole("button", { name: /Project/ });
    fireEvent.keyDown(button, { key: "ArrowDown" });
    const list = screen.getByRole("listbox");
    fireEvent.keyDown(list, { key: "ArrowDown" });
    fireEvent.keyDown(list, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith("p2");
    fireEvent.keyDown(button, { key: "Enter" });
    fireEvent.keyDown(screen.getByRole("listbox"), { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("closes when clicking outside", () => {
    render(<ProjectPicker projects={projects} value="p1" onChange={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: /Project/ }));
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("listbox")).toBeNull();
  });
});
