// A team's page (/team/<F1DB constructor id>, ../../url.ts), read top down as a driver's is: what it is and who drives
// for it; its season (the one under way, or its last): its figures, its drivers' shares, race by race; its history:
// its figures, firsts and lasts, runs, its most successful drivers, best circuits; then every season. From F1DB
// (../../history/careers.ts). Reached from Home's Teams tab and from team names on driver pages.

import { useEffect, useMemo } from "react";
import { fetchTeamHistory, sumTotals } from "../../history/careers";
import { driverSplit, summarize, tally, teamOutings } from "../../history/careerStats";
import type { TeamHistory, TeamRace, TeamTotals } from "../../history/types";
import { currentYear } from "../../library";
import { useShareHeading } from "../../share/ShareCard";
import { Flag } from "../Flag";
import { LABEL } from "../controls";
import { BestCircuits, Milestones, Runs, Tally } from "./Highlights";
import { SeasonStrip } from "./SeasonStrip";
import { Block, CareerPage, NameLink, points, Section, Stat, StatRow, tenth, useHistoryFile } from "./common";

const NONE: TeamTotals = {
  starts: 0,
  wins: 0,
  podiums: 0,
  oneTwos: 0,
  poles: 0,
  fastestLaps: 0,
  points: 0,
  titles: 0,
};

const TH = `px-2 py-2 sm:px-3 font-[inherit] ${LABEL}`;
const NUM = "px-2 py-2 sm:px-3 text-right tabular-nums";

/** The season: its figures, each driver's share, race by race. */
function Season({ h, year, races }: { h: TeamHistory; year: number; races: TeamRace[] }) {
  const outings = teamOutings(races);
  const s = summarize(outings);
  const standing = h.seasons.find((x) => x.year === year);
  const split = driverSplit(outings);
  const last = races.at(-1);
  const now = year === currentYear();
  return (
    <Section
      title={now ? `${year} season` : `Last season, ${year}`}
      aside={now && last ? `through round ${last.round}, ${h.names.gps[last.gp]?.short ?? last.gp}` : null}
    >
      <StatRow>
        <Stat label="Championship" title={standing?.titles ? "Constructors' champion" : undefined}>
          {standing?.position != null ? `P${standing.position}` : "—"}
        </Stat>
        <Stat label="Points" title="Championship points, sprints included">
          {points(standing?.points ?? s.points)}
        </Stat>
        <Stat label="Wins">{s.wins}</Stat>
        <Stat label="Podiums">{s.podiums}</Stat>
        <Stat label="1-2s">{s.oneTwos}</Stat>
        <Stat label="Poles">{s.poles}</Stat>
        <Stat label="In the points" note={s.cars ? `of ${s.cars}` : null} title="Cars that scored">
          {s.pointsFinishes}
        </Stat>
        <Stat label="Retired" title="Cars not classified at the finish">
          {s.retirements}
        </Stat>
      </StatRow>
      <Block title="Drivers" aside={`average grid ${tenth(s.avgGrid)}, average finish ${tenth(s.avgFinish)} over both cars`}>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-y border-zinc-800">
                <th className={TH}>Driver</th>
                <th className={`${TH} text-right`}>Races</th>
                <th className={`${TH} text-right`} title="Points from Grands Prix (sprints aren't counted here)">
                  GP points
                </th>
                <th className={`${TH} hidden text-right sm:table-cell`} title="Share of the team's Grand Prix points">
                  Share
                </th>
                <th className={`${TH} text-right`}>Wins</th>
                <th className={`${TH} hidden text-right sm:table-cell`}>Podiums</th>
                <th className={`${TH} text-right`}>Best</th>
              </tr>
            </thead>
            <tbody>
              {split.map((d) => (
                <tr key={d.driverId} className="border-b border-zinc-800/70 hover:bg-zinc-900">
                  <td className="px-2 py-2 sm:px-3 font-semibold text-zinc-50">
                    <NameLink kind="driver" id={d.driverId}>
                      {h.names.drivers[d.driverId]?.name ?? d.driverId}
                    </NameLink>
                  </td>
                  <td className={`${NUM} text-zinc-400`}>{d.races}</td>
                  <td className={`${NUM} font-semibold text-zinc-50`}>{points(d.points)}</td>
                  <td className={`${NUM} hidden text-zinc-300 sm:table-cell`}>{s.points > 0 ? `${Math.round((d.points / s.points) * 100)}%` : "—"}</td>
                  <td className={`${NUM} ${d.wins ? "font-semibold text-zinc-50" : "text-zinc-400"}`}>{d.wins}</td>
                  <td className={`${NUM} hidden sm:table-cell ${d.podiums ? "text-zinc-200" : "text-zinc-400"}`}>{d.podiums}</td>
                  <td className={`${NUM} text-zinc-200`}>{d.best != null ? `P${d.best}` : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Block>
      <Block title="Race by race" aside="finish, and the grid under it">
        <SeasonStrip
          races={races}
          rows={split.map((d) => ({
            key: d.driverId,
            label: (
              <NameLink kind="driver" id={d.driverId}>
                {h.names.drivers[d.driverId]?.lastName ?? d.driverId}
              </NameLink>
            ),
            results: new Map(races.flatMap((r) => r.cars.filter((c) => c.driverId === d.driverId).map((c) => [r.raceId, c] as const))),
          }))}
          names={h.names}
        />
      </Block>
    </Section>
  );
}

function History({ h }: { h: TeamHistory }) {
  const t = h.seasons.reduce<TeamTotals>(sumTotals, NONE);
  const driversTitles = h.seasons.filter((s) => s.driversTitle).length;
  const outings = useMemo(() => teamOutings(h.races), [h]);
  const drivers = useMemo(() => tally(outings, "driver").slice(0, 10), [outings]);
  const first = h.seasons[0]?.year;
  const last = h.seasons.at(-1)?.year;
  const span = first === last ? `${first}` : `${first}–${last}`;

  return (
    <Section title="History" aside={`${span}, ${h.seasons.length} ${h.seasons.length === 1 ? "season" : "seasons"}`}>
      <StatRow>
        <Stat label="Constructors' titles">{t.titles}</Stat>
        <Stat label="Drivers' titles" title="Drivers' championships won in its cars">
          {driversTitles}
        </Stat>
        <Stat label="Grands Prix">{t.starts}</Stat>
        <Stat label="Wins">{t.wins}</Stat>
        <Stat label="1-2s">{t.oneTwos}</Stat>
        <Stat label="Podiums">{t.podiums}</Stat>
        <Stat label="Poles">{t.poles}</Stat>
        <Stat label="Points">{points(t.points)}</Stat>
      </StatRow>
      {outings.length > 0 && (
        <div className="grid grid-cols-1 gap-x-10 lg:grid-cols-2">
          <Block title="Milestones">
            <Milestones outings={outings} names={h.names} team />
          </Block>
          <Block title="Longest runs" aside="by either car">
            <Runs outings={outings} names={h.names} />
          </Block>
        </div>
      )}
      <div className="grid grid-cols-1 gap-x-10 lg:grid-cols-2">
        {drivers.length > 0 && (
          <Block title="Most successful drivers">
            <Tally rows={drivers} kind="driver" names={h.names} />
          </Block>
        )}
        <Block title="Best circuits" aside="most wins, then poles">
          <BestCircuits outings={outings} names={h.names} />
        </Block>
      </div>
    </Section>
  );
}

/** Newest first. */
function Seasons({ h }: { h: TeamHistory }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-y border-zinc-800">
            <th className={`${TH} w-16`}>Year</th>
            <th className={`${TH} text-right`} title="Constructors' championship position">
              Pos
            </th>
            <th className={`${TH} text-right`}>Points</th>
            <th className={`${TH} text-right`}>Wins</th>
            <th className={`${TH} hidden text-right sm:table-cell`}>Podiums</th>
            <th className={`${TH} hidden text-right sm:table-cell`}>Poles</th>
            <th className={`${TH} hidden md:table-cell`}>Drivers</th>
          </tr>
        </thead>
        <tbody>
          {[...h.seasons].reverse().map((s) => (
            <tr key={s.year} className="border-b border-zinc-800/70 hover:bg-zinc-900">
              <td className="px-2 py-2 sm:px-3 tabular-nums text-zinc-400">{s.year}</td>
              <td className={`${NUM} ${s.titles ? "font-bold text-zinc-50" : "text-zinc-200"}`} title={s.titles ? "Constructors' champion" : undefined}>
                {s.titles > 0 && <span className="mr-2 hidden text-[11px] font-semibold uppercase tracking-wider text-zinc-300 sm:inline">Champion</span>}
                {s.position ?? "—"}
              </td>
              <td className={`${NUM} text-zinc-200`}>{points(s.points)}</td>
              <td className={`${NUM} ${s.wins ? "font-semibold text-zinc-50" : "text-zinc-400"}`}>{s.wins}</td>
              <td className={`${NUM} hidden sm:table-cell ${s.podiums ? "text-zinc-200" : "text-zinc-400"}`}>{s.podiums}</td>
              <td className={`${NUM} hidden sm:table-cell ${s.poles ? "text-zinc-200" : "text-zinc-400"}`}>{s.poles}</td>
              <td className="hidden px-2 py-2 sm:px-3 text-zinc-300 md:table-cell">
                {s.drivers.slice(0, 4).map((id, i) => (
                  <span key={id}>
                    {i > 0 && ", "}
                    <NameLink kind="driver" id={id}>
                      {h.names.drivers[id]?.lastName ?? id}
                    </NameLink>
                    {s.driversTitle === id && (
                      <span className="ml-1 text-[11px] font-semibold uppercase tracking-wider text-zinc-400" title="Drivers' champion">
                        Champion
                      </span>
                    )}
                  </span>
                ))}
                {s.drivers.length > 4 && <span className="text-zinc-400"> +{s.drivers.length - 4}</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
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
  const facts = team ? [team.nationality, team.engine ? `${team.engine} engine` : null, span].filter(Boolean).join(" · ") : "";
  const name = team?.name ?? id;
  useEffect(() => {
    useShareHeading.setState({
      heading: { title: name, detail: facts, country: team?.nationality },
    });
    return () => useShareHeading.setState({ heading: null });
  }, [name, facts, team?.nationality]);

  return (
    <CareerPage source={h && h !== "none" ? h.source : undefined}>
      {h == null ? (
        <p className="px-3 text-sm text-zinc-400">Loading…</p>
      ) : h === "none" ? (
        <p className="px-3 text-sm text-zinc-400">No team “{id}” in this build's history.</p>
      ) : (
        <>
          <header data-shot="title" className="px-3">
            <h1 className="flex items-center gap-3 text-3xl font-bold tracking-tight text-zinc-50">
              <Flag country={h.team.nationalityCode} code className="h-6" />
              {h.team.name}
            </h1>
            {now.length > 0 && (
              <p className="mt-2 text-base text-zinc-200">
                {now.map((d, i) => (
                  <span key={d}>
                    {i > 0 && <span className="text-zinc-500"> · </span>}
                    <NameLink kind="driver" id={d} inline className="font-semibold">
                      {h.names.drivers[d]?.name ?? d}
                    </NameLink>
                  </span>
                ))}
              </p>
            )}
            <p className="mt-1 text-sm text-zinc-400">
              {h.team.fullName !== h.team.name && <>{h.team.fullName} · </>}
              {facts}
            </p>
          </header>
          {lastRace && <Season h={h} year={lastRace.year} races={h.races.filter((r) => r.year === lastRace.year)} />}
          <History h={h} />
          <Section title="Seasons">
            <Seasons h={h} />
          </Section>
        </>
      )}
    </CareerPage>
  );
}
