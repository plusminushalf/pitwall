// A driver's page (/driver/<F1DB id>, ../../url.ts), read top down in the order a visitor wants it during a weekend:
// who they are; their season (the one under way, or their last): its figures, race by race, against their teammate;
// their career: its figures, firsts and lasts, runs, teammates, best circuits, teams; then every season. From F1DB
// (../../history/careers.ts). Reached from Home's Drivers tab and from names on team pages; its back button goes
// back to where it was opened from.

import { useEffect, useMemo } from "react";
import { fetchDriverHistory, sumTotals } from "../../history/careers";
import { driverOutings, headToHeads, summarize, tally } from "../../history/careerStats";
import type { DriverHistory, DriverRace, DriverSeason, DriverTotals } from "../../history/types";
import { currentYear } from "../../library";
import { useShareHeading } from "../../share/ShareCard";
import { Flag } from "../Flag";
import { LABEL } from "../controls";
import { BestCircuits, Milestones, Runs, Tally, Teammates } from "./Highlights";
import { SeasonStrip } from "./SeasonStrip";
import { Block, CareerPage, NameLink, points, Section, Stat, StatRow, tenth, useHistoryFile } from "./common";

const NONE: DriverTotals = {
  starts: 0,
  wins: 0,
  podiums: 0,
  poles: 0,
  fastestLaps: 0,
  points: 0,
  titles: 0,
};

const longDate = (iso: string) =>
  new Date(`${iso}T12:00:00Z`).toLocaleDateString(undefined, {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });

/** Whole years from `from` to `to` (ISO dates). */
function age(from: string, to: string): number {
  const [fy, fm, fd] = from.split("-").map(Number);
  const [ty, tm, td] = to.split("-").map(Number);
  return ty - fy - (tm < fm || (tm === fm && td < fd) ? 1 : 0);
}

/** "29%": a share of starts, or nothing with none. */
const share = (n: number, of: number) => (of > 0 && n > 0 ? `${Math.round((n / of) * 100)}%` : null);

const TH = `px-2 py-2 sm:px-3 font-[inherit] ${LABEL}`;
const NUM = "px-2 py-2 sm:px-3 text-right tabular-nums";

/** Newest first. */
function Seasons({ seasons }: { seasons: DriverSeason[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-y border-zinc-800">
            <th className={`${TH} w-16`}>Year</th>
            <th className={TH}>Team</th>
            <th className={`${TH} text-right`} title="Championship position">
              Pos
            </th>
            <th className={`${TH} text-right`}>Points</th>
            <th className={`${TH} text-right`}>Wins</th>
            <th className={`${TH} hidden text-right sm:table-cell`}>Podiums</th>
            <th className={`${TH} hidden text-right sm:table-cell`}>Poles</th>
            <th className={`${TH} hidden text-right md:table-cell`} title="Grands Prix started">
              Starts
            </th>
          </tr>
        </thead>
        <tbody>
          {[...seasons].reverse().map((s) => (
            <tr key={s.year} className="border-b border-zinc-800/70 hover:bg-zinc-900">
              <td className="px-2 py-2 sm:px-3 tabular-nums text-zinc-400">{s.year}</td>
              <td className="px-2 py-2 sm:px-3 text-zinc-100">{s.teams.join(", ") || "—"}</td>
              <td className={`${NUM} ${s.titles ? "font-bold text-zinc-50" : "text-zinc-200"}`} title={s.titles ? "Champion" : undefined}>
                {s.titles > 0 && <span className="mr-2 hidden text-[11px] font-semibold uppercase tracking-wider text-zinc-300 sm:inline">Champion</span>}
                {s.position ?? "—"}
              </td>
              <td className={`${NUM} text-zinc-200`}>{points(s.points)}</td>
              <td className={`${NUM} ${s.wins ? "font-semibold text-zinc-50" : "text-zinc-400"}`}>{s.wins}</td>
              <td className={`${NUM} hidden sm:table-cell ${s.podiums ? "text-zinc-200" : "text-zinc-400"}`}>{s.podiums}</td>
              <td className={`${NUM} hidden sm:table-cell ${s.poles ? "text-zinc-200" : "text-zinc-400"}`}>{s.poles}</td>
              <td className={`${NUM} hidden text-zinc-400 md:table-cell`}>{s.starts}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The driver's season: its figures, race by race with the teammates' results under theirs, and against them. */
function Season({ h, year, races }: { h: DriverHistory; year: number; races: DriverRace[] }) {
  const s = summarize(driverOutings(races));
  const standing = h.seasons.find((x) => x.year === year);
  const mates = headToHeads(races);
  const last = races.at(-1);
  const now = year === currentYear();
  return (
    <Section
      title={now ? `${year} season` : `Last season, ${year}`}
      aside={now && last ? `through round ${last.round}, ${h.names.gps[last.gp]?.short ?? last.gp}` : null}
    >
      <StatRow>
        <Stat label="Championship" title={standing?.titles ? "Champion" : undefined}>
          {standing?.position != null ? `P${standing.position}` : "—"}
        </Stat>
        <Stat label="Points" title="Championship points, sprints included">
          {points(standing?.points ?? s.points)}
        </Stat>
        <Stat label="Wins">{s.wins}</Stat>
        <Stat label="Podiums">{s.podiums}</Stat>
        <Stat label="Poles">{s.poles}</Stat>
        <Stat label="Avg grid" title="Average starting position">
          {tenth(s.avgGrid)}
        </Stat>
        <Stat label="Avg finish" title="Average finishing position, when classified">
          {tenth(s.avgFinish)}
        </Stat>
        <Stat label="Retired" title="Races not classified at the finish">
          {s.retirements}
        </Stat>
      </StatRow>
      <Block title="Race by race" aside="finish, and the grid under it">
        <SeasonStrip
          races={races}
          rows={[
            {
              key: h.driver.id,
              label: h.driver.lastName,
              results: new Map(races.map((r) => [r.raceId, r.car])),
            },
            ...mates.map((m) => ({
              key: m.mateId,
              label: (
                <NameLink kind="driver" id={m.mateId} className="font-normal text-zinc-400">
                  {h.names.drivers[m.mateId]?.lastName ?? m.mateId}
                </NameLink>
              ),
              results: new Map(races.flatMap((r) => r.mates.filter((x) => x.driverId === m.mateId).map((x) => [r.raceId, x] as const))),
            })),
          ]}
          names={h.names}
        />
      </Block>
      {mates.length > 0 && (
        <Block title="Against teammates" aside="qualified and finished ahead – behind">
          <Teammates list={mates} names={h.names} />
        </Block>
      )}
    </Section>
  );
}

function Career({ h }: { h: DriverHistory }) {
  const outings = useMemo(() => driverOutings(h.races), [h]);
  const t = h.seasons.reduce<DriverTotals>(sumTotals, NONE);
  const first = h.seasons[0]?.year;
  const last = h.seasons.at(-1)?.year;
  const mates = useMemo(() => headToHeads(h.races).slice(0, 8), [h]);
  const teams = useMemo(() => tally(outings, "team"), [outings]);
  const span = first === last ? `${first}` : `${first}–${last}`;

  return (
    <Section title="Career" aside={`${span}, ${h.seasons.length} ${h.seasons.length === 1 ? "season" : "seasons"}`}>
      <StatRow>
        <Stat label="Titles">{t.titles}</Stat>
        <Stat label="Grands Prix">{t.starts}</Stat>
        <Stat label="Wins" note={share(t.wins, t.starts)}>
          {t.wins}
        </Stat>
        <Stat label="Podiums" note={share(t.podiums, t.starts)}>
          {t.podiums}
        </Stat>
        <Stat label="Poles">{t.poles}</Stat>
        <Stat label="Fastest laps">{t.fastestLaps}</Stat>
        <Stat label="Points">{points(t.points)}</Stat>
      </StatRow>
      {outings.length > 0 && (
        <div className="grid grid-cols-1 gap-x-10 lg:grid-cols-2">
          <Block title="Milestones">
            <Milestones outings={outings} names={h.names} />
          </Block>
          <Block title="Longest runs">
            <Runs outings={outings} names={h.names} />
          </Block>
        </div>
      )}
      {mates.length > 0 && (
        <Block title="Against teammates" aside="every season: qualified and finished ahead – behind">
          <Teammates list={mates} names={h.names} />
        </Block>
      )}
      <div className="grid grid-cols-1 gap-x-10 lg:grid-cols-2">
        <Block title="Best circuits" aside="most wins, then poles">
          <BestCircuits outings={outings} names={h.names} />
        </Block>
        {teams.length > 0 && (
          <Block title="Teams">
            <Tally rows={teams} kind="team" names={h.names} />
          </Block>
        )}
      </div>
    </Section>
  );
}

export function DriverPage({ id }: { id: string }) {
  const h = useHistoryFile(id, fetchDriverHistory);
  const d = h && h !== "none" ? h.driver : null;
  const last = h && h !== "none" ? h.races.at(-1) : undefined;
  const teamId = last?.year === currentYear() ? last.car.constructorId : null;
  const teamName = teamId && h && h !== "none" ? (h.names.teams[teamId] ?? teamId) : null;
  const today = new Date().toISOString().slice(0, 10);
  const name = d?.name ?? id;
  const detail = d ? [d.number ? `#${d.number}` : null, teamName, d.nationality].filter(Boolean).join(" · ") : "";
  useEffect(() => {
    useShareHeading.setState({
      heading: { title: name, detail, country: d?.nationality },
    });
    return () => useShareHeading.setState({ heading: null });
  }, [name, detail, d?.nationality]);

  return (
    <CareerPage source={h && h !== "none" ? h.source : undefined}>
      {h == null ? (
        <p className="px-3 text-sm text-zinc-400">Loading…</p>
      ) : h === "none" ? (
        <p className="px-3 text-sm text-zinc-400">No driver “{id}” in this build's history.</p>
      ) : (
        <>
          <header data-shot="title" className="px-3">
            <h1 className="flex flex-wrap items-center gap-x-3 text-3xl font-bold tracking-tight text-zinc-50">
              <Flag country={h.driver.nationalityCode} code className="h-6" />
              {h.driver.name}
              {h.driver.number && <span className="font-black tabular-nums text-zinc-400">{h.driver.number}</span>}
            </h1>
            <p className="mt-2 text-base text-zinc-200">
              {teamId ? (
                <NameLink kind="team" id={teamId} inline className="font-semibold">
                  {teamName}
                </NameLink>
              ) : (
                <span>Last raced in {last?.year}</span>
              )}
              <span className="text-zinc-500"> · </span>
              {h.driver.nationality}
            </p>
            <p className="mt-1 text-sm text-zinc-400">
              Born {longDate(h.driver.dateOfBirth)} in {h.driver.placeOfBirth}, {h.driver.countryOfBirth}
              {h.driver.dateOfDeath
                ? ` · died ${longDate(h.driver.dateOfDeath)}, aged ${age(h.driver.dateOfBirth, h.driver.dateOfDeath)}`
                : ` · age ${age(h.driver.dateOfBirth, today)}`}
            </p>
          </header>
          {last && <Season h={h} year={last.year} races={h.races.filter((r) => r.year === last.year)} />}
          <Career h={h} />
          <Section title="Seasons">
            <Seasons seasons={h.seasons} />
          </Section>
        </>
      )}
    </CareerPage>
  );
}
