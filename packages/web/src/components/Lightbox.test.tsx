import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Lightbox, type LightboxImage } from "./Lightbox.js";

const images: LightboxImage[] = [
  { src: "/a1.png", caseId: "TC-01", name: "01-open.png", step: 1, steps: 2, result: "passed" },
  { src: "/a2.png", caseId: "TC-01", name: "02-add.png", step: 2, steps: 2, result: "passed" },
  { src: "/b1.png", caseId: "TC-02", name: "01-empty.png", step: 1, steps: 1, result: "failed" },
];

afterEach(cleanup);

describe("Lightbox", () => {
  it("shows the chosen screenshot with its case and step, and moves through all of them with the arrows", () => {
    render(<Lightbox images={images} start={1} onClose={() => undefined} />);
    const dialog = screen.getByRole("dialog", { name: "Evidence" });
    expect(screen.getByRole("img").getAttribute("src")).toBe("/a2.png");
    expect(dialog.textContent).toContain("TC-01 · step 2 of 2 · 02-add.png");
    fireEvent.keyDown(dialog, { key: "ArrowRight" });
    expect(screen.getByRole("img").getAttribute("src")).toBe("/b1.png");
    expect(dialog.textContent).toContain("TC-02 · step 1 of 1");
    // The last one stays put; the buttons do the same as the keys.
    fireEvent.keyDown(dialog, { key: "ArrowRight" });
    expect(screen.getByRole("img").getAttribute("src")).toBe("/b1.png");
    fireEvent.click(screen.getByRole("button", { name: "Previous screenshot" }));
    expect(screen.getByRole("img").getAttribute("src")).toBe("/a2.png");
    expect(screen.getByRole("link", { name: "Open the original" }).getAttribute("href")).toBe("/a2.png");
  });

  it("toggles between fitting the screen and the actual size", () => {
    render(<Lightbox images={images} start={0} onClose={() => undefined} />);
    const img = screen.getByRole("img");
    expect(img.className).toContain("fit");
    fireEvent.click(img);
    expect(img.className).not.toContain("fit");
  });

  it("closes with Escape, the close button or a click on the backdrop", () => {
    const onClose = vi.fn();
    render(<Lightbox images={images} start={0} onClose={onClose} />);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.click(screen.getByTestId("lightbox-backdrop"));
    expect(onClose).toHaveBeenCalledTimes(3);
  });
});
