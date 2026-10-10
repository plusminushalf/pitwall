// Home's drivers: the season's championship as a board, from F1DB's index (built at deploy, ../../history/careers.ts).
// A cell opens the driver's page (../career/DriverPage.tsx): their season and career. Each leads with the position,
// then the flag, name, car number and team, the season's wins, podiums and poles, and ends on the points and the gap
// to the leader. Drivers who raced this season but not the latest round (stand-ins, drivers replaced) follow, quieter.

import type { ReactNode } from "react";
import { byStanding, fetchDriverIndex } from "../../history/careers";
import type { SeasonDriver } from "../../history/types";
import { useReplay } from "../../store";
import { Flag } from "../Flag";
import { count, SeasonNote, StandingPoints, useHistoryFile } from "../career/common";
import { FOCUS, LABEL } from "./common";

const loadIndex = (_: string, signal: AbortSignal) => fetchDriverIndex(signal);

/** "1–3, 15–16": the rounds raced, as ranges. */
function rounds(list: number[]): string {
  const out: string[] = [];
  for (let i = 0; i < list.length;) {
    let j = i;
    while (j + 1 < list.length && list[j + 1] === list[j] + 1) j++;
    out.push(i === j ? `${list[i]}` : `${list[i]}–${list[j]}`);
    i = j + 1;
  }
  return out.join(", ");
}

/**
 * A driver's cell, as a standings row on the Circuits board's grid: the championship position as its figure, then
 * who (flag, name, car number) and for whom, the season's wins, podiums and poles, and the points at the end.
 */
function Cell({ d, leader, quiet }: { d: SeasonDriver; leader: number; quiet: boolean }) {
  const openDriver = useReplay((s) => s.openDriver);
  const titles = d.before.titles + d.season.titles;
  const facts = [count(d.season.wins, "win"), count(d.season.podiums, "podium"), count(d.season.poles, "pole")].join(" · ");
  return (
    <li data-shot="" className="border-b border-r border-zinc-800">
      <button
        onClick={(e) => {
          e.currentTarget.blur();
          openDriver(d.id);
        }}
        className={`flex h-full w-full items-start gap-3 px-3 py-3 text-left transition-colors hover:bg-zinc-900 focus-visible:-outline-offset-2 sm:gap-4 sm:px-4 ${FOCUS}`}
        title={`${d.name}: the season and the career`}
      >
        <span
          className={`w-7 shrink-0 text-xl font-black tabular-nums leading-6 tracking-tight sm:w-9 ${quiet ? "text-zinc-400" : "text-zinc-50"}`}
          aria-label={d.season.position != null ? `P${d.season.position} in the championship` : undefined}
        >
          {d.season.position ?? "–"}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex h-6 items-center gap-2">
            <Flag country={d.nationalityCode} code className={`h-3.5 ${quiet ? "opacity-45 grayscale-[60%]" : ""}`} />
            <span className={`min-w-0 truncate text-[15px] font-semibold ${quiet ? "text-zinc-300" : "text-zinc-50"}`}>{d.name}</span>
            {d.number && <span className="shrink-0 text-xs font-semibold tabular-nums text-zinc-400">{d.number}</span>}
          </span>
          <span className="block truncate text-xs text-zinc-300">
            {d.team}
            {titles > 0 && <span className="text-zinc-400"> · {titles}× champion</span>}
            {quiet && <span className="text-zinc-400"> · raced R{rounds(d.rounds)}</span>}
          </span>
          <span className="mt-1.5 block truncate text-xs tabular-nums text-zinc-400">{facts}</span>
        </span>
        <StandingPoints points={d.season.points} leader={leader} quiet={quiet} />
      </button>
    </li>
  );
}

/** The board: cells framed and divided by hairlines, as the Circuits board is. */
const BOARD = "grid grid-cols-1 border-l border-t border-zinc-800 min-[420px]:grid-cols-2 lg:grid-cols-3";

export function Drivers({ heading }: { heading: ReactNode }) {
  const index = useHistoryFile("index", loadIndex);

  let body;
  if (index == null) body = <p className="border-y border-zinc-800 px-3 py-4 text-sm text-zinc-400">Loading the drivers…</p>;
  else if (index === "none") body = <p className="border-y border-zinc-800 px-3 py-4 text-sm text-zinc-400">No driver history in this build of the site.</p>;
  else {
    const grid = byStanding(index.drivers.filter((d) => d.current));
    const leader = Math.max(0, ...index.drivers.map((d) => d.season.points));
    const others = byStanding(index.drivers.filter((d) => !d.current));
    const through = index.throughRound != null ? `round ${index.throughRound}, the ${index.throughGrandPrix}` : null;
    body = (
      <>
        <SeasonNote through={through} source={index.source} className="mb-3" />
        <ul aria-label={`${index.year} drivers`} className={BOARD}>
          {grid.map((d) => (
            <Cell key={d.id} d={d} leader={leader} quiet={false} />
          ))}
        </ul>
        {others.length > 0 && (
          <>
            <h3 className={`${LABEL} mb-2 mt-8`}>Also raced in {index.year}</h3>
            <ul aria-label={`Other ${index.year} drivers`} className={BOARD}>
              {others.map((d) => (
                <Cell key={d.id} d={d} leader={leader} quiet />
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
