// Home's teams: the constructors' championship as a timing sheet, from F1DB's index (built at deploy,
// ../../history/careers.ts), with the drivers' sheet's columns (./Drivers.tsx). A row opens the team's page
// (../career/TeamPage.tsx): its season and history. Each reads position, flag and name, its drivers, the season's
// wins, podiums and poles, points and the gap to the leader.

import type { ReactNode } from "react";
import { byStanding, fetchTeamIndex } from "../../history/careers";
import type { SeasonTeam } from "../../history/types";
import { useReplay } from "../../store";
import { Flag } from "../Flag";
import { SeasonNote, useHistoryFile } from "../career/common";
import { AT_40, AT_52, Figure, PointsCells, Sheet, SheetRow, STANDINGS_GRID, StandingsColumns } from "./sheet";

const loadIndex = (_: string, signal: AbortSignal) => fetchTeamIndex(signal);

function Row({ t, leader }: { t: SeasonTeam; leader: number }) {
  const openTeam = useReplay((s) => s.openTeam);
  const current = t.drivers.filter((d) => d.current);
  const drivers = (current.length ? current : t.drivers).map((d) => d.lastName).join(" · ");
  const s = t.season;
  return (
    <SheetRow grid={STANDINGS_GRID} onOpen={() => openTeam(t.id)} title={`${t.name}: its season and history`}>
      <span className="font-bold tabular-nums text-zinc-50" aria-label={s.position != null ? `P${s.position} in the championship` : undefined}>
        {s.position ?? "–"}
      </span>
      <span className="min-w-0">
        <span className="flex items-center gap-2">
          <Flag country={t.nationalityCode} code className="h-3 shrink-0" />
          <span className="min-w-0 truncate font-semibold text-zinc-50">{t.name}</span>
        </span>
        {/* Narrowest: the drivers under the name. */}
        <span className="block truncate text-xs text-zinc-300 @[40rem]:hidden">{drivers}</span>
      </span>
      <span className={`${AT_40} truncate text-zinc-200`}>{drivers}</span>
      <Figure n={s.wins} className={AT_52} />
      <Figure n={s.podiums} className={AT_52} />
      <Figure n={s.poles} className={AT_52} />
      <PointsCells points={s.points} leader={leader} />
    </SheetRow>
  );
}

export function Teams({ heading }: { heading: ReactNode }) {
  const index = useHistoryFile("index", loadIndex);

  let body;
  if (index == null) body = <p className="border-y border-zinc-800 px-3 py-4 text-sm text-zinc-400">Loading the teams…</p>;
  else if (index === "none") body = <p className="border-y border-zinc-800 px-3 py-4 text-sm text-zinc-400">No team history in this build of the site.</p>;
  else {
    const leader = Math.max(0, ...index.teams.map((t) => t.season.points));
    const through = index.throughRound != null ? `round ${index.throughRound}, the ${index.throughGrandPrix}` : null;
    body = (
      <>
        <SeasonNote through={through} source={index.source} className="mb-3 px-3" />
        <Sheet label={`${index.year} constructors' championship`} grid={STANDINGS_GRID} columns={<StandingsColumns who="Team" with="Drivers" />}>
          {byStanding(index.teams).map((t) => (
            <Row key={t.id} t={t} leader={leader} />
          ))}
        </Sheet>
      </>
    );
  }

  return (
    <section data-shot="" aria-label="Teams" className="mt-12">
      <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-2">{heading}</div>
      {body}
    </section>
  );
}
