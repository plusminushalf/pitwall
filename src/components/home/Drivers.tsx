// Home's drivers: the season's championship as a timing sheet, from F1DB's index (built at deploy,
// ../../history/careers.ts). A row opens the driver's page (../career/DriverPage.tsx): their season and career. Each
// reads position, the team's colour, name and car number, team, the season's wins, podiums and poles, points and the gap to the
// leader. Drivers who raced this season but not the latest round (stand-ins, drivers replaced) follow, quieter.

import type { ReactNode } from "react";
import { byStanding, fetchDriverIndex } from "../../history/careers";
import type { SeasonDriver } from "../../history/types";
import { useReplay } from "../../store";
import { SeasonNote, TeamStripe, useHistoryFile } from "../career/common";
import { AT_40, AT_52, Figure, PointsCells, Sheet, SheetRow, SheetTitle, STANDINGS_GRID, StandingsColumns } from "./sheet";

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

function Row({ d, leader, quiet }: { d: SeasonDriver; leader: number; quiet: boolean }) {
  const openDriver = useReplay((s) => s.openDriver);
  const team = (
    <>
      {d.team}
      {quiet && <span className="text-zinc-400"> · R{rounds(d.rounds)}</span>}
    </>
  );
  return (
    <SheetRow grid={STANDINGS_GRID} onOpen={() => openDriver(d.id)} title={`${d.name}: the season and the career`}>
      <span
        className={`font-bold tabular-nums ${quiet ? "text-zinc-400" : "text-zinc-50"}`}
        aria-label={d.season.position != null ? `P${d.season.position} in the championship` : undefined}
      >
        {d.season.position ?? "–"}
      </span>
      <span className="min-w-0">
        <span className="flex items-center gap-2">
          <TeamStripe team={d.teamId} hold className={quiet ? "h-4 opacity-50" : "h-4"} />
          <span className={`min-w-0 truncate font-semibold ${quiet ? "text-zinc-300" : "text-zinc-50"}`}>{d.name}</span>
          {d.number && <span className="shrink-0 text-xs tabular-nums text-zinc-400">{d.number}</span>}
        </span>
        {/* Narrowest: the team under the name. */}
        <span className="block truncate text-xs text-zinc-300 @[40rem]:hidden">{team}</span>
      </span>
      <span className={`${AT_40} truncate ${quiet ? "text-zinc-300" : "text-zinc-200"}`}>{team}</span>
      <Figure n={d.season.wins} className={AT_52} />
      <Figure n={d.season.podiums} className={AT_52} />
      <Figure n={d.season.poles} className={AT_52} />
      <PointsCells points={d.season.points} leader={leader} quiet={quiet} />
    </SheetRow>
  );
}

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
        <SeasonNote through={through} source={index.source} className="mb-3 px-3" />
        <Sheet label={`${index.year} drivers' championship`} grid={STANDINGS_GRID} columns={<StandingsColumns who="Driver" with="Team" />}>
          {grid.map((d) => (
            <Row key={d.id} d={d} leader={leader} quiet={false} />
          ))}
        </Sheet>
        {others.length > 0 && (
          <>
            <SheetTitle>Also raced in {index.year}</SheetTitle>
            <Sheet label={`Other ${index.year} drivers`} grid={STANDINGS_GRID} columns={<StandingsColumns who="Driver" with="Team · rounds" />}>
              {others.map((d) => (
                <Row key={d.id} d={d} leader={leader} quiet />
              ))}
            </Sheet>
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
