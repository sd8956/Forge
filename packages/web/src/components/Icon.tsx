/** Inline stroke icons (design rule: never emoji). */
const PATHS: Record<string, string> = {
  board: "M4 5h4v14H4zM10 5h4v8h-4zM16 5h4v11h-4z",
  check: "M5 12l4 4 10-10",
  alert: "M12 7v6M12 17h.01",
  terminal: "M4 6l5 5-5 5M11 18h9",
  play: "M8 5l11 7-11 7z",
  stop: "M6 6h12v12H6z",
  external: "M14 4h6v6M20 4l-9 9M18 14v5H5V6h5",
  pencil: "M4 20h4L19 9l-4-4L4 16zM13 7l4 4",
};

export function Icon({ name, size = 16, label }: { name: keyof typeof PATHS; size?: number; label?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" role={label ? "img" : undefined} aria-hidden={label ? undefined : true} aria-label={label}>
      <path d={PATHS[name]} />
    </svg>
  );
}
