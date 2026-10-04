import type { CSSProperties } from "react";

const paths: Record<string, string[]> = {
  folder: ["M3 7h6l2 2h10v10H3z", "M3 7V5h6l2 2"],
  plus: ["M12 5v14", "M5 12h14"],
  arrow: ["M12 19V5", "m5 12 7-7 7 7"],
  chevron: ["m9 5 7 7-7 7"],
  chevronDown: ["m5 9 7 7 7-7"],
  branch: ["M6 3v12a3 3 0 0 0 3 3h6", "M18 9V6", "M6 6h0", "M18 18h0"],
  settings: [
    "M9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1z",
    "M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0",
  ],
  search: ["M17 17l4 4", "M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0"],
  check: ["m5 12 4 4L19 6"],
  close: ["m6 6 12 12", "M18 6 6 18"],
  file: ["M5 3h9l5 5v13H5z", "M14 3v6h5", "M8 13h8", "M8 17h5"],
  terminal: ["m5 7 5 5-5 5", "M12 17h7"],
  clock: ["M12 7v5l3 2", "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0"],
  shield: ["m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6z", "m8 12 3 3 5-6"],
  edit: ["m4 15 12-12 5 5L9 20l-6 1z", "m13 6 5 5"],
  refresh: ["M20 7a9 9 0 1 0 1 8", "M20 2v6h-6"],
  stop: ["M6 6h12v12H6z"],
  code: ["m8 5-6 7 6 7", "m16 5 6 7-6 7", "m14 3-4 18"],
  spark: ["m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5z"],
  undo: ["M3 5v6h6", "M3 11a8 8 0 1 1 2 7"],
};
export function Icon({
  name,
  size = 16,
  className,
  style,
}: {
  name: string;
  size?: number;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <svg
      className={className}
      style={style}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.65"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {(paths[name] ?? paths.file!).map((d, i) => (
        <path key={i} d={d} />
      ))}
    </svg>
  );
}
