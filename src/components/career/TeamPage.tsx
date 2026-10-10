// A team's page (/team/<F1DB constructor id>, ../../url.ts): what it is and its history in figures; its season (the one
// under way, or its last): figures, its drivers' shares, race by race; its history's highlights (firsts and lasts,
// runs, its drivers, best circuits); and every season. From F1DB (../../history/careers.ts). The season under way
// counts only once shown (./common.tsx). Reached from Home's Teams tab and from team names on driver pages.

import { useEffect, useMemo } from "react";
import { fetchTeamHistory, sumTotals } from "../../history/careers";
import { driverSplit, summarize, tally, teamOutings } from "../../history/careerStats";
import type { TeamHistory, TeamRace, TeamSeason, TeamTotals } from "../../history/types";
import { currentYear } from "../../library";
import { useShareHeading } from "../../share/ShareCard";
import { Flag } from "../Flag";
import { LABEL } from "../controls";
import { BestCircuits, Milestones, Runs, Tally } from "./Highlights";
import { SeasonStrip } from "./SeasonStrip";
import { CareerPage, F1dbCredit, Fact, HiddenSeason, NameLink, points, SeasonNote, Section, tenth, useCounts, useHistoryFile } from "./common";

const NONE: TeamTotals = { starts: 0, wins: 0, podiums: 0, oneTwos: 0, poles: 0, fastestLaps: 0, points: 0, titles: 0 };

/** The season: figures, each driver's share, race by race. */
function Season({ h, year, races }: { h: TeamHistory; year: number; races: TeamRace[] }) {
  const outings = teamOutings(races);
  const s = summarize(outings);
  const standing = h.seasons.find((x) => x.year === year);
  const split = driverSplit(outings);
  const name = (id: string) => h.names.drivers[id]?.lastName ?? id;
  const NUM = "px-3 py-2 text-right tabular-nums";
  return (
    <>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-5 border-y border-zinc-800 px-3 py-4 sm:grid-cols-4 lg:grid-cols-8">
        <Fact label="Championship" title={standing?.titles ? "Constructors' champion" : undefined}>
          {standing?.position != null ? `P${standing.position}` : "—"}
        </Fact>
        <Fact label="Points" title="Championship points, sprints included">
          {points(standing?.points ?? s.points)}
        </Fact>
        <Fact label="Wins">{s.wins}</Fact>
        <Fact label="Podiums">{s.podiums}</Fact>
        <Fact label="1-2s">{s.oneTwos}</Fact>
        <Fact label="Poles">{s.poles}</Fact>
        <Fact label="Points finishes" note={s.cars ? `of ${s.cars}` : null}>
          {s.pointsFinishes}
        </Fact>
        <Fact label="Retired" title="Cars not classified at the finish">
          {s.retirements}
        </Fact>
      </dl>
      <table className="mt-6 w-full text-left text-sm">
        <caption className={`${LABEL} px-3 pb-2 text-left`}>Drivers in {year}</caption>
        <thead>
          <tr className={`${LABEL} border-b border-zinc-800`}>
            <th className="px-3 py-2 font-[inherit]">Driver</th>
            <th className={`${NUM} font-[inherit]`}>Races</th>
            <th className={`${NUM} font-[inherit]`} title="Points from Grands Prix (sprints aren't counted here)">
              GP points
            </th>
            <th className={`${NUM} hidden font-[inherit] sm:table-cell`} title="Share of the team's Grand Prix points">
              Share
            </th>
            <th className={`${NUM} font-[inherit]`}>Wins</th>
            <th className={`${NUM} hidden font-[inherit] sm:table-cell`}>Podiums</th>
            <th className={`${NUM} font-[inherit]`}>Best</th>
          </tr>
        </thead>
        <tbody>
          {split.map((d) => (
            <tr key={d.driverId} className="border-b border-zinc-800/70">
              <td className="px-3 py-2 text-zinc-100">
                <NameLink kind="driver" id={d.driverId}>
                  {h.names.drivers[d.driverId]?.name ?? d.driverId}
                </NameLink>
              </td>
              <td className={`${NUM} text-zinc-400`}>{d.races}</td>
              <td className={`${NUM} text-zinc-100`}>{points(d.points)}</td>
              <td className={`${NUM} hidden text-zinc-400 sm:table-cell`}>{s.points > 0 ? `${Math.round((d.points / s.points) * 100)}%` : "—"}</td>
              <td className={`${NUM} ${d.wins ? "font-semibold text-zinc-50" : "text-zinc-500"}`}>{d.wins}</td>
              <td className={`${NUM} hidden sm:table-cell ${d.podiums ? "text-zinc-200" : "text-zinc-500"}`}>{d.podiums}</td>
              <td className={`${NUM} text-zinc-300`}>{d.best != null ? `P${d.best}` : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="mt-6">
        <SeasonStrip
          races={races}
          rows={split.map((d) => ({
            key: d.driverId,
            label: (
              <NameLink kind="driver" id={d.driverId}>
                {name(d.driverId)}
              </NameLink>
            ),
            results: new Map(races.flatMap((r) => r.cars.filter((c) => c.driverId === d.driverId).map((c) => [r.raceId, c] as const))),
          }))}
          names={h.names}
        />
      </div>
      <p className="mt-2 px-3 text-xs text-zinc-500">Average grid {tenth(s.avgGrid)}, average finish {tenth(s.avgFinish)}, over both cars.</p>
    </>
  );
}

/** Newest first; the season under way hidden until it counts. */
function Seasons({ h, counts }: { h: TeamHistory; counts: boolean }) {
  const cell = "px-3 py-2 text-right tabular-nums";
  return (
    <table className="w-full text-left text-sm">
      <thead>
        <tr className={`${LABEL} border-b border-zinc-800`}>
          <th className="w-16 px-3 py-2 font-[inherit]">Year</th>
          <th className={`${cell} font-[inherit]`} title="Constructors' championship position">
            Pos
          </th>
          <th className={`${cell} font-[inherit]`}>Points</th>
          <th className={`${cell} font-[inherit]`}>Wins</th>
          <th className={`${cell} hidden font-[inherit] sm:table-cell`}>Podiums</th>
          <th className={`${cell} hidden font-[inherit] sm:table-cell`}>Poles</th>
          <th className="hidden px-3 py-2 font-[inherit] md:table-cell">Drivers</th>
        </tr>
      </thead>
      <tbody>
        {[...h.seasons].reverse().map((s: TeamSeason) => {
          const hidden = s.year === currentYear() && !counts;
          return (
            <tr key={s.year} className="border-b border-zinc-800/70">
              <td className="px-3 py-2 tabular-nums text-zinc-400">{s.year}</td>
              {hidden ? (
                <td colSpan={5} className="px-3 py-2 text-right text-xs text-zinc-500">
                  Hidden: spoilers
                </td>
              ) : (
                <>
                  <td className={`${cell} ${s.titles ? "font-bold text-zinc-50" : "text-zinc-200"}`} title={s.titles ? "Constructors' champion" : undefined}>
                    {s.position ?? "—"}
                    {s.titles > 0 && <span className="ml-1 text-[11px] font-semibold uppercase tracking-wider text-zinc-300">Champion</span>}
                  </td>
                  <td className={`${cell} text-zinc-200`}>{points(s.points)}</td>
                  <td className={`${cell} ${s.wins ? "text-zinc-50" : "text-zinc-500"}`}>{s.wins}</td>
                  <td className={`${cell} hidden sm:table-cell ${s.podiums ? "text-zinc-200" : "text-zinc-500"}`}>{s.podiums}</td>
                  <td className={`${cell} hidden sm:table-cell ${s.poles ? "text-zinc-200" : "text-zinc-500"}`}>{s.poles}</td>
                </>
              )}
              <td className="hidden px-3 py-2 text-zinc-300 md:table-cell">
                {s.drivers.slice(0, 4).map((id, i) => (
                  <span key={id}>
                    {i > 0 && ", "}
                    <NameLink kind="driver" id={id}>
                      {h.names.drivers[id]?.lastName ?? id}
                    </NameLink>
                    {!hidden && s.driversTitle === id && <span className="ml-1 text-[11px] font-semibold uppercase tracking-wider text-zinc-400">Champion</span>}
                  </span>
                ))}
                {s.drivers.length > 4 && <span className="text-zinc-500"> +{s.drivers.length - 4}</span>}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function History({ h }: { h: TeamHistory }) {
  const year = currentYear();
  const counts = useCounts(year);
  const countedSeasons = h.seasons.filter((s) => s.year !== year || counts);
  const t = countedSeasons.reduce<TeamTotals>(sumTotals, NONE);
  const driversTitles = countedSeasons.filter((s) => s.driversTitle).length;
  const counted = useMemo(() => h.races.filter((r) => r.year !== year || counts), [h, year, counts]);
  const outings = useMemo(() => teamOutings(counted), [counted]);
  const drivers = useMemo(() => tally(outings, "driver").slice(0, 10), [outings]);
  const first = h.seasons[0]?.year;
  const last = h.seasons.at(-1)?.year;
  const underWay = last === year;
  const seasonYear = h.races.at(-1)?.year;
  const seasonRaces = useMemo(() => h.races.filter((r) => r.year === seasonYear), [h, seasonYear]);

  return (
    <>
      <dl data-shot="" className="mt-8 grid grid-cols-2 gap-x-6 gap-y-5 border-y border-zinc-800 px-3 py-4 sm:grid-cols-4 lg:grid-cols-8">
        <Fact label="Constructors'" title="Constructors' championships">
          {t.titles}
        </Fact>
        <Fact label="Drivers'" title="Drivers' championships won in its cars">
          {driversTitles}
        </Fact>
        <Fact label="Grands Prix">{t.starts}</Fact>
        <Fact label="Wins">{t.wins}</Fact>
        <Fact label="1-2s">{t.oneTwos}</Fact>
        <Fact label="Podiums">{t.podiums}</Fact>
        <Fact label="Poles">{t.poles}</Fact>
        <Fact label="Points">{points(t.points)}</Fact>
      </dl>
      {underWay ? (
        <SeasonNote year={year} through={counts ? "the latest race weekend F1DB has" : null} source={h.source} className="mt-3 px-3" />
      ) : (
        <p data-shot-credit={`History: F1DB (${h.source.license})`} className="mt-3 px-3 text-xs text-zinc-400">
          {first === last ? `${first}` : `${first}–${last}`}, {h.seasons.length} {h.seasons.length === 1 ? "season" : "seasons"}. <F1dbCredit source={h.source} />.
        </p>
      )}

      {seasonYear != null && (
        <Section title={seasonYear === year ? `${year} so far` : `Last season, ${seasonYear}`}>
          {seasonYear === year && !counts ? <HiddenSeason year={year} /> : <Season h={h} year={seasonYear} races={seasonRaces} />}
        </Section>
      )}

      {outings.length > 0 && (
        <Section title="History" aside={underWay && !counts ? <span className="text-xs text-zinc-400">to the end of {year - 1}</span> : null}>
          <Milestones outings={outings} names={h.names} team />
          <Runs outings={outings} names={h.names} />
          <div className="mt-8 grid grid-cols-1 gap-x-8 gap-y-8 lg:grid-cols-2">
            <Tally rows={drivers} kind="driver" names={h.names} caption="Its most successful drivers" />
            <BestCircuits outings={outings} names={h.names} />
          </div>
        </Section>
      )}

      <Section title="Seasons">
        <Seasons h={h} counts={counts} />
      </Section>
    </>
  );
}

export function TeamPage({ id }: { id: string }) {
  const h = useHistoryFile(id, fetchTeamHistory);
  const team = h && h !== "none" ? h.team : null;
  const lastRace = h && h !== "none" ? h.races.at(-1) : undefined;
  const racing = lastRace?.year === currentYear();
  // Its drivers now: the cars of its latest race this season.
  const now = racing ? (lastRace?.cars.map((c) => c.driverId) ?? []) : [];
  const first = h && h !== "none" ? h.seasons[0]?.year : undefined;
  const lastYear = h && h !== "none" ? h.seasons.at(-1)?.year : undefined;
  const span = first != null && lastYear != null ? (racing ? `since ${first}` : first === lastYear ? `${first}` : `${first}–${lastYear}`) : null;
  const detail = team ? [team.fullName !== team.name ? team.fullName : null, team.nationality, team.engine ? `${team.engine} engine` : null, span].filter(Boolean).join(" · ") : "";
  const name = team?.name ?? id;
  useEffect(() => {
    useShareHeading.setState({ heading: { title: name, detail, country: team?.nationality } });
    return () => useShareHeading.setState({ heading: null });
  }, [name, detail, team?.nationality]);

  return (
    <CareerPage>
      {h == null ? (
        <p className="px-3 text-sm text-zinc-400">Loading…</p>
      ) : h === "none" ? (
        <p className="px-3 text-sm text-zinc-400">No team “{id}” in this build's history.</p>
      ) : (
        <>
          <div data-shot="title" className="px-3">
            <h1 className="flex items-center gap-3 text-3xl font-bold tracking-tight text-zinc-50">
              <Flag country={h.team.nationalityCode} code className="h-6" />
              {h.team.name}
            </h1>
            <p className="mt-1 text-sm text-zinc-300">{detail}</p>
            {now.length > 0 && (
              <p className="mt-0.5 text-sm text-zinc-400">
                Drivers:{" "}
                {now.map((d, i) => (
                  <span key={d}>
                    {i > 0 && ", "}
                    <NameLink kind="driver" id={d} className="text-zinc-200">
                      {h.names.drivers[d]?.name ?? d}
                    </NameLink>
                  </span>
                ))}
              </p>
            )}
          </div>
          <History h={h} />
        </>
      )}
    </CareerPage>
  );
}
