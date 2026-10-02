// The replay screen's icons (DESIGN.md): 16-unit paths in currentColor, a 1.5 stroke with round ends, and the
// playback controls solid. `play` and `check` are drawn as on Home. No Unicode stand-ins (⏮ ⏸ ✓ ⇄ 🏁): some
// systems turn them into colour emoji.

import type { ReactNode } from "react";

const STROKE = { fill: "none", stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round", strokeLinejoin: "round" } as const;
const SOLID = { fill: "currentColor" } as const;

const PATHS = {
  play: <path {...SOLID} d="M5 3v10l8-5z" />,
  pause: (
    <>
      <rect {...SOLID} x="4" y="3" width="3" height="10" rx=".75" />
      <rect {...SOLID} x="9" y="3" width="3" height="10" rx=".75" />
    </>
  ),
  stop: <rect {...SOLID} x="4" y="4" width="8" height="8" rx="1" />,
  previous: <path {...SOLID} d="M3 3.5h2v9H3zM13 3.5v9L6 8z" />,
  next: <path {...SOLID} d="M11 3.5h2v9h-2zM3 3.5v9L10 8z" />,
  check: <path {...STROKE} d="M3 8.5l3.2 3L13 4.5" />,
  close: <path {...STROKE} d="M4 4l8 8M12 4l-8 8" />,
  "chevron-left": <path {...STROKE} d="M10 3.5 5.5 8l4.5 4.5" />,
  /** Two ways: switches between two readings of the same thing (gap to the leader, or to the car ahead). */
  swap: <path {...STROKE} d="M2.5 5.5h10M10 3l2.5 2.5L10 8M13.5 10.5h-10M6 8l-2.5 2.5L6 13" />,
  gear: (
    <>
      <circle {...STROKE} cx="8" cy="8" r="2" />
      <circle {...STROKE} cx="8" cy="8" r="4.6" />
      {Array.from({ length: 8 }, (_, i) => {
        const a = (i * Math.PI) / 4;
        return <line key={i} stroke="currentColor" strokeWidth="2.2" x1={8 + Math.cos(a) * 4.6} y1={8 + Math.sin(a) * 4.6} x2={8 + Math.cos(a) * 6.6} y2={8 + Math.sin(a) * 6.6} />;
      })}
    </>
  ),
  /** A flag on its pole (the red flag on the timeline). */
  flag: (
    <>
      <path {...STROKE} d="M3.5 14.5V2" />
      <path {...SOLID} d="M3.5 2.5H13L10.5 5.75 13 9H3.5z" />
    </>
  ),
  /** The chequered flag: the finish. */
  chequered: (
    <>
      <path {...STROKE} d="M3 14.5V2" />
      <rect x="3.5" y="2.5" width="10" height="7" fill="none" stroke="currentColor" strokeWidth="1" />
      <path {...SOLID} fillRule="evenodd" d="M3.5 2.5h10v7h-10zM6 2.5v2.33h2.5V2.5zm5 0v2.33h2.5V2.5zM3.5 4.83v2.34H6V4.83zm5 0v2.34H11V4.83zM6 7.17V9.5h2.5V7.17zm5 0V9.5h2.5V7.17z" />
    </>
  ),
  rain: (
    <>
      <path {...STROKE} d="M4.5 9.5a2.75 2.75 0 0 1-.2-5.5 3.75 3.75 0 0 1 7.2 1 2.25 2.25 0 0 1 0 4.5z" />
      <path {...STROKE} d="M5.5 12l-.75 1.5M8.5 12l-.75 1.5M11.5 12l-.75 1.5" />
    </>
  ),
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof PATHS;

/**
 * One of the app's icons, `size` CSS px square. Decorative (hidden from screen readers) unless it has a
 * `label`; an icon-only button names itself instead (aria-label).
 */
export function Icon({ name, size = 16, label, className = "" }: { name: IconName; size?: number; label?: string; className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      className={`shrink-0 ${className}`}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      {label && <title>{label}</title>}
      {PATHS[name]}
    </svg>
  );
}
