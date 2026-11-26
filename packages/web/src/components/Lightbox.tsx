import { useEffect, useRef, useState } from "react";
import { Badge } from "./Badge.js";

export interface LightboxImage {
  src: string;
  caseId: string;
  /** File name, such as 02-add-task.png. */
  name: string;
  /** 1-based position among the case's screenshots. */
  step: number;
  steps: number;
  result: string;
}

/**
 * A screenshot of the evidence at full size. Arrows (keys or buttons) move through every screenshot of every case;
 * a click on the image switches between fitting the screen and its actual size; Escape, the close button or a click
 * outside closes it.
 */
export function Lightbox({ images, start, onClose }: { images: LightboxImage[]; start: number; onClose: () => void }) {
  const [index, setIndex] = useState(start);
  const [fit, setFit] = useState(true);
  const dialog = useRef<HTMLDivElement>(null);
  const image = images[index];

  useEffect(() => {
    dialog.current?.focus();
  }, []);
  useEffect(() => setFit(true), [index]);

  if (!image) return null;
  const go = (delta: number) => setIndex((i) => Math.min(images.length - 1, Math.max(0, i + delta)));
  return (
    <div className="lightbox-backdrop" data-testid="lightbox-backdrop" onClick={onClose}>
      <div
        ref={dialog}
        className="lightbox"
        role="dialog"
        aria-modal="true"
        aria-label="Evidence"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
          else if (e.key === "ArrowRight") go(1);
          else if (e.key === "ArrowLeft") go(-1);
          else return;
          e.preventDefault();
        }}
      >
        <div className="lightbox-bar">
          <span className="mono small">
            {image.caseId} · step {image.step} of {image.steps} · {image.name}
          </span>
          <Badge tone={image.result === "passed" ? "done" : "failed"} label={image.result} />
          <span className="muted small">{index + 1} / {images.length}</span>
          <a className="small" href={image.src} target="_blank" rel="noreferrer" style={{ marginLeft: "auto" }}>Open the original</a>
          <button type="button" className="btn" onClick={onClose}>Close</button>
        </div>
        <div className={`lightbox-stage${fit ? "" : " actual"}`}>
          <button type="button" className="lightbox-nav prev" aria-label="Previous screenshot" disabled={index === 0} onClick={() => go(-1)}>‹</button>
          <img src={image.src} alt={`${image.caseId} step ${image.step}: ${image.name}`} className={fit ? "fit" : ""} onClick={() => setFit(!fit)} />
          <button type="button" className="lightbox-nav next" aria-label="Next screenshot" disabled={index === images.length - 1} onClick={() => go(1)}>›</button>
        </div>
        <p className="muted small lightbox-hint">← → to move · click the image for actual size · Esc to close</p>
      </div>
    </div>
  );
}
