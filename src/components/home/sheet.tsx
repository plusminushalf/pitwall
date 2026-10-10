// Home's Circuits, Drivers and Teams tabs as timing sheets, the way the Continue list and the timing tower read: a row
// per circuit, driver or team under 11px column headers, divided by hairlines, each row opening its page. Columns
// come and go with the sheet's width (a container query), as session rows' do (./SessionRow.tsx).

import type { ReactNode } from "react";
import { FOCUS, LABEL } from "./common";

/** Columns that only show once the sheet is this wide. */
export const AT_40 = "hidden @[40rem]:block";
export const AT_52 = "hidden @[52rem]:block";
export const AT_66 = "hidden @[66rem]:block";

/** A sheet: its column headers (`grid`, the rows' columns too) over its rows. */
export function Sheet({
  label,
  grid,
  columns,
  children,
  className = "",
}: {
  label: string;
  grid: string;
  columns: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`@container ${className}`}>
      <div className={`${grid} ${LABEL} items-end whitespace-nowrap border-b border-zinc-800 px-3 pb-2`} aria-hidden>
        {columns}
      </div>
      <ul aria-label={label}>{children}</ul>
    </div>
  );
}

/** A row: the whole of it opens the page. `raised`: the one to look at now (the next weekend). */
export function SheetRow({
  grid,
  onOpen,
  title,
  raised = false,
  children,
}: {
  grid: string;
  onOpen: () => void;
  title: string;
  raised?: boolean;
  children: ReactNode;
}) {
  return (
    <li data-shot="" className="border-b border-zinc-800/70">
      <button
        onClick={(e) => {
          e.currentTarget.blur();
          onOpen();
        }}
        title={title}
        className={`${grid} min-h-11 w-full items-center px-3 py-1.5 text-left text-sm transition-colors focus-visible:-outline-offset-2 ${FOCUS} ${raised ? "bg-zinc-900" : "hover:bg-zinc-900"}`}
      >
        {children}
      </button>
    </li>
  );
}

/** A short figure that a screen reader says in full instead ("3" read as "Round 3"). */
export function Spoken({ text, children }: { text: string; children: ReactNode }) {
  return (
    <>
      <span aria-hidden>{children}</span>
      <span className="sr-only">{text}</span>
    </>
  );
}

/** A count in a figure column: bright when there's any, readable grey at zero. */
export function Figure({ n, className = "" }: { n: number; className?: string }) {
  return <span className={`text-right tabular-nums ${n > 0 ? "text-zinc-100" : "text-zinc-400"} ${className}`}>{n}</span>;
}

/** The championship's points and the gap to the leader, as the last two columns. */
export function PointsCells({ points, leader, quiet = false }: { points: number; leader: number; quiet?: boolean }) {
  const gap = Math.round((leader - points) * 100) / 100;
  return (
    <>
      <span className={`text-right font-semibold tabular-nums ${quiet ? "text-zinc-300" : "text-zinc-50"}`}>{points.toLocaleString()}</span>
      <span className={`${AT_40} text-right tabular-nums text-zinc-400`}>{gap > 0 ? `−${gap.toLocaleString()}` : "–"}</span>
    </>
  );
}

/**
 * Pos · Driver · Team · Wins · Podiums · Poles · Points · Gap. Narrowest, the team goes under the name and only the
 * points stay beside it; the gap and team join, then the season's results.
 */
export const STANDINGS_GRID =
  "grid grid-cols-[2rem_minmax(0,1fr)_auto] gap-x-3 @[40rem]:grid-cols-[2.5rem_minmax(0,1.4fr)_minmax(0,1fr)_4.5rem_4rem] @[52rem]:grid-cols-[2.5rem_minmax(0,1.4fr)_minmax(0,1fr)_3.5rem_4rem_3.5rem_4.5rem_4rem]";

/** The standings' columns, the teams' too (`who`, `with`: its second and third column). */
export function StandingsColumns({ who, with: by }: { who: string; with: string }) {
  return (
    <>
      <span title="Championship position">Pos</span>
      <span>{who}</span>
      <span className={AT_40}>{by}</span>
      <span className={`${AT_52} text-right`}>Wins</span>
      <span className={`${AT_52} text-right`}>Podiums</span>
      <span className={`${AT_52} text-right`}>Poles</span>
      <span className="text-right" title="Championship points, sprints included">
        Points
      </span>
      <span className={`${AT_40} text-right`} title="Points behind the leader">
        Gap
      </span>
    </>
  );
}

/** A sheet's own subsection, under the tab heading: a title, not a label. */
export function SheetTitle({ children }: { children: ReactNode }) {
  return <h3 className="mb-2 mt-10 px-3 text-sm font-semibold text-zinc-100">{children}</h3>;
}
