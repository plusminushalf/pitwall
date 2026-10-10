// Home's teams: the constructors' championship as a board, from F1DB's index (built at deploy,
// ../../history/careers.ts). A cell opens the team's page (../career/TeamPage.tsx): its season and history. Each leads
// with the position, then the flag, name and drivers, the season's results, and ends on the points and the gap.

import type { ReactNode } from "react";
import { byStanding, fetchTeamIndex } from "../../history/careers";
import type { SeasonTeam } from "../../history/types";
import { useReplay } from "../../store";
import { Flag } from "../Flag";
import { count, SeasonNote, StandingPoints, useHistoryFile } from "../career/common";
import { FOCUS } from "./common";

const loadIndex = (_: string, signal: AbortSignal) => fetchTeamIndex(signal);

/** A team's cell, as a driver's: position, flag and name, its drivers, the season's results, its points. */
function Cell({ t, leader }: { t: SeasonTeam; leader: number }) {
  const openTeam = useReplay((s) => s.openTeam);
  const drivers = t.drivers.filter((d) => d.current);
  const s = t.season;
  const facts = [count(s.wins, "win"), count(s.podiums, "podium"), count(s.poles, "pole"), s.oneTwos > 0 ? count(s.oneTwos, "1-2", "1-2s") : null]
    .filter(Boolean)
    .join(" · ");
  return (
    <li data-shot="" className="border-b border-r border-zinc-800">
      <button
        onClick={(e) => {
          e.currentTarget.blur();
          openTeam(t.id);
        }}
        className={`flex h-full w-full items-start gap-3 px-3 py-3 text-left transition-colors hover:bg-zinc-900 focus-visible:-outline-offset-2 sm:gap-4 sm:px-4 ${FOCUS}`}
        title={`${t.name}: its season and history`}
      >
        <span
          className="w-7 shrink-0 text-xl font-black tabular-nums leading-6 tracking-tight text-zinc-50 sm:w-9"
          aria-label={s.position != null ? `P${s.position} in the championship` : undefined}
        >
          {s.position ?? "–"}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex h-6 items-center gap-2">
            <Flag country={t.nationalityCode} code className="h-3.5" />
            <span className="min-w-0 truncate text-[15px] font-semibold text-zinc-50">{t.name}</span>
          </span>
          <span className="block truncate text-xs text-zinc-300">{(drivers.length ? drivers : t.drivers).map((d) => d.lastName).join(" · ")}</span>
          <span className="mt-1.5 block truncate text-xs tabular-nums text-zinc-400">{facts}</span>
        </span>
        <StandingPoints points={s.points} leader={leader} />
      </button>
    </li>
  );
}

const BOARD = "grid grid-cols-1 border-l border-t border-zinc-800 min-[420px]:grid-cols-2 lg:grid-cols-3";

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
        <SeasonNote through={through} source={index.source} className="mb-3" />
        <ul aria-label={`${index.year} teams`} className={BOARD}>
          {byStanding(index.teams).map((t) => (
            <Cell key={t.id} t={t} leader={leader} />
          ))}
        </ul>
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
