// Home's drivers: a board of the season's grid, by team, from F1DB's index (built at deploy, ../../history/careers.ts).
// A cell opens the driver's page (../career/DriverPage.tsx): their season and career. Each says the car number,
// flag, name and team, and the career in figures: to the end of last season unless this one counts
// (../career/common.tsx), and then the championship position too. Drivers who raced this season but not the latest
// round (stand-ins, drivers replaced) follow, quieter.

import type { ReactNode } from "react";
import { fetchDriverIndex, sumTotals } from "../../history/careers";
import type { SeasonDriver } from "../../history/types";
import { useReplay } from "../../store";
import { Flag } from "../Flag";
import { count, SeasonNote, useCounts, useHistoryFile } from "../career/common";
import { FOCUS, LABEL } from "./common";

const loadIndex = (_: string, signal: AbortSignal) => fetchDriverIndex(signal);

/** "1–3, 15–16": the rounds raced, as ranges. */
function rounds(list: number[]): string {
  const out: string[] = [];
  for (let i = 0; i < list.length; ) {
    let j = i;
    while (j + 1 < list.length && list[j + 1] === list[j] + 1) j++;
    out.push(i === j ? `${list[i]}` : `${list[i]}–${list[j]}`);
    i = j + 1;
  }
  return out.join(", ");
}

/** A driver's cell, as a circuit's on the Circuits board: the number as its figure, then who, and the career. */
function Cell({ d, counts, quiet }: { d: SeasonDriver; counts: boolean; quiet: boolean }) {
  const openDriver = useReplay((s) => s.openDriver);
  const career = counts ? sumTotals(d.before, d.season) : d.before;
  const facts =
    career.starts === 0
      ? "First season"
      : [career.titles > 0 ? count(career.titles, "title") : null, count(career.wins, "win"), count(career.podiums, "podium"), count(career.starts, "start")]
          .filter(Boolean)
          .join(" · ");
  return (
    <li data-shot="" className="border-b border-r border-zinc-800">
      <button
        onClick={(e) => {
          e.currentTarget.blur();
          openDriver(d.id);
        }}
        className={`flex h-full w-full items-start gap-3 px-3 py-3 text-left transition-colors hover:bg-zinc-900 focus-visible:-outline-offset-2 sm:gap-4 sm:px-4 ${FOCUS}`}
        title={`${d.name}: career, season by season`}
      >
        <span
          className={`w-7 shrink-0 text-lg font-black tabular-nums leading-6 tracking-tight sm:w-9 sm:text-xl ${quiet ? "text-zinc-400" : "text-zinc-300"}`}
          aria-label={d.number ? `Car ${d.number}` : undefined}
        >
          {d.number ?? "–"}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex h-6 items-center gap-2">
            <Flag country={d.nationalityCode} code className={`h-3.5 ${quiet ? "opacity-45 grayscale-[60%]" : ""}`} />
            <span className={`min-w-0 truncate text-[15px] font-semibold ${quiet ? "text-zinc-400" : "text-zinc-50"}`}>{d.name}</span>
            <span className="flex-1" />
            {counts && d.season.position != null && (
              <span className="shrink-0 text-xs tabular-nums text-zinc-300" title={`${d.season.points} points this season`}>
                P{d.season.position}
              </span>
            )}
          </span>
          <span className={`block truncate text-xs ${quiet ? "text-zinc-400" : "text-zinc-300"}`}>
            {d.team}
            {quiet && <span className="text-zinc-500"> · R{rounds(d.rounds)}</span>}
          </span>
          <span className="mt-1.5 hidden truncate text-xs tabular-nums text-zinc-400 sm:block">{facts}</span>
        </span>
      </button>
    </li>
  );
}

/** The board: cells framed and divided by hairlines, as the Circuits board is. */
const BOARD = "grid grid-cols-1 border-l border-t border-zinc-800 min-[420px]:grid-cols-2 lg:grid-cols-3";

export function Drivers({ heading }: { heading: ReactNode }) {
  const index = useHistoryFile("index", loadIndex);
  const year = index && index !== "none" ? index.year : 0;
  const counts = useCounts(year);

  let body;
  if (index == null) body = <p className="border-y border-zinc-800 px-3 py-4 text-sm text-zinc-400">Loading the drivers…</p>;
  else if (index === "none") body = <p className="border-y border-zinc-800 px-3 py-4 text-sm text-zinc-400">No driver history in this build of the site.</p>;
  else {
    const grid = index.drivers.filter((d) => d.current);
    const others = index.drivers.filter((d) => !d.current);
    const through = index.throughRound != null ? `round ${index.throughRound}, the ${index.throughGrandPrix}` : null;
    body = (
      <>
        <SeasonNote year={index.year} through={through} source={index.source} className="mb-3" />
        <ul aria-label={`${index.year} drivers`} className={BOARD}>
          {grid.map((d) => (
            <Cell key={d.id} d={d} counts={counts} quiet={false} />
          ))}
        </ul>
        {others.length > 0 && (
          <>
            <h3 className={`${LABEL} mb-2 mt-8`}>Also raced in {index.year}</h3>
            <ul aria-label={`Other ${index.year} drivers`} className={BOARD}>
              {others.map((d) => (
                <Cell key={d.id} d={d} counts={counts} quiet />
              ))}
            </ul>
          </>
        )}
      </>
    );
  }

  return (
    <section data-shot="" aria-label="Drivers" className="mt-12">
      <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-2">{heading}</div>
      {body}
    </section>
  );
}
