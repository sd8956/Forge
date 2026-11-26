import { useState, type ReactNode } from "react";

export const PAGE_SIZE = 10;

/**
 * Shows `items` a page at a time, with previous/next buttons and the range shown.
 * The page is clamped when the list shrinks, so it never lands past the end.
 */
export function Paged<T>({ items, render, pageSize = PAGE_SIZE }: { items: T[]; render: (item: T) => ReactNode; pageSize?: number }) {
  const [wanted, setPage] = useState(0);
  const pages = Math.max(1, Math.ceil(items.length / pageSize));
  const page = Math.min(wanted, pages - 1);
  const start = page * pageSize;
  const shown = items.slice(start, start + pageSize);
  return (
    <>
      {shown.map(render)}
      {pages > 1 ? (
        <div className="pager">
          <button type="button" className="btn" aria-label="Previous page" disabled={page === 0} onClick={() => setPage(page - 1)}>‹</button>
          <span className="muted small">{start + 1}–{start + shown.length} of {items.length}</span>
          <button type="button" className="btn" aria-label="Next page" disabled={page >= pages - 1} onClick={() => setPage(page + 1)}>›</button>
        </div>
      ) : null}
    </>
  );
}
