// Home's teams: a board of the season's teams, from F1DB's index (built at deploy, ../../history/careers.ts). A cell
// opens the team's page (../career/TeamPage.tsx): its season and history. Each says the flag, name, engine and
// drivers, and its history in figures: to the end of last season unless this one counts (../career/common.tsx), and
// then the championship position too.

import type { ReactNode } from "react";
import { fetchTeamIndex, sumTotals } from "../../history/careers";
import type { SeasonTeam } from "../../history/types";
import { useReplay } from "../../store";
import { Flag } from "../Flag";
import { count, SeasonNote, useCounts, useHistoryFile } from "../career/common";
import { FOCUS } from "./common";

const loadIndex = (_: string, signal: AbortSignal) => fetchTeamIndex(signal);

function Cell({ t, counts }: { t: SeasonTeam; counts: boolean }) {
  const openTeam = useReplay((s) => s.openTeam);
  const { position, ...season } = t.season;
  const history = counts ? sumTotals(t.before, season) : t.before;
  const facts =
    history.starts === 0
      ? "First season"
      : [history.titles > 0 ? count(history.titles, "title") : null, count(history.wins, "win"), count(history.starts, "Grand Prix", "Grands Prix")].filter(Boolean).join(" · ");
  const drivers = t.drivers.filter((d) => d.current);
  return (
    <li data-shot="" className="border-b border-r border-zinc-800">
      <button
        onClick={(e) => {
          e.currentTarget.blur();
          openTeam(t.id);
        }}
        className={`flex h-full w-full items-start gap-3 px-3 py-3 text-left transition-colors hover:bg-zinc-900 focus-visible:-outline-offset-2 sm:px-4 ${FOCUS}`}
        title={`${t.name}: its season and history`}
      >
        <span className="min-w-0 flex-1">
          <span className="flex h-6 items-center gap-2">
            <Flag country={t.nationalityCode} code className="h-3.5" />
            <span className="min-w-0 truncate text-[15px] font-semibold text-zinc-50">{t.name}</span>
            <span className="flex-1" />
            {counts && position != null && (
              <span className="shrink-0 text-xs tabular-nums text-zinc-300" title={`${t.season.points} points this season`}>
                P{position}
              </span>
            )}
          </span>
          <span className="block truncate text-xs text-zinc-300">
            {(drivers.length ? drivers : t.drivers).map((d) => d.lastName).join(" · ")}
            {t.engine && <span className="text-zinc-500"> · {t.engine}</span>}
          </span>
          <span className="mt-1.5 hidden truncate text-xs tabular-nums text-zinc-400 sm:block">{facts}</span>
        </span>
      </button>
    </li>
  );
}

const BOARD = "grid grid-cols-1 border-l border-t border-zinc-800 min-[420px]:grid-cols-2 lg:grid-cols-3";

export function Teams({ heading }: { heading: ReactNode }) {
  const index = useHistoryFile("index", loadIndex);
  const year = index && index !== "none" ? index.year : 0;
  const counts = useCounts(year);

  let body;
  if (index == null) body = <p className="border-y border-zinc-800 px-3 py-4 text-sm text-zinc-400">Loading the teams…</p>;
  else if (index === "none") body = <p className="border-y border-zinc-800 px-3 py-4 text-sm text-zinc-400">No team history in this build of the site.</p>;
  else {
    const through = index.throughRound != null ? `round ${index.throughRound}, the ${index.throughGrandPrix}` : null;
    body = (
      <>
        <SeasonNote year={index.year} through={through} source={index.source} className="mb-3" />
        <ul aria-label={`${index.year} teams`} className={BOARD}>
          {index.teams.map((t) => (
            <Cell key={t.id} t={t} counts={counts} />
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
