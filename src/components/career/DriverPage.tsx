// A driver's page (/driver/<F1DB id>, ../../url.ts): who they are and their career in figures; their season (the one
// under way, or their last): figures, against their teammate, race by race; their career's highlights (firsts and
// lasts, runs, teammates, teams, best circuits); and every season. From F1DB (../../history/careers.ts).
// Reached from Home's Drivers tab and from names on team pages; its back button goes back to where it was opened from.

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
import { CareerPage, F1dbCredit, Fact, NameLink, points, SeasonNote, Section, tenth, useHistoryFile } from "./common";

const NONE: DriverTotals = { starts: 0, wins: 0, podiums: 0, poles: 0, fastestLaps: 0, points: 0, titles: 0 };

const longDate = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

/** Whole years from `from` to `to` (ISO dates). */
function age(from: string, to: string): number {
  const [fy, fm, fd] = from.split("-").map(Number);
  const [ty, tm, td] = to.split("-").map(Number);
  return ty - fy - (tm < fm || (tm === fm && td < fd) ? 1 : 0);
}

/** "29%": a share of starts, or nothing with none. */
const share = (n: number, of: number) => (of > 0 && n > 0 ? `${Math.round((n / of) * 100)}%` : null);

/** Newest first. */
function Seasons({ seasons }: { seasons: DriverSeason[] }) {
  const cell = "px-3 py-2 text-right tabular-nums";
  return (
    <table className="w-full text-left text-sm">
      <thead>
        <tr className={`${LABEL} border-b border-zinc-800`}>
          <th className="w-16 px-3 py-2 font-[inherit]">Year</th>
          <th className="px-3 py-2 font-[inherit]">Team</th>
          <th className={`${cell} font-[inherit]`} title="Championship position">
            Pos
          </th>
          <th className={`${cell} font-[inherit]`}>Points</th>
          <th className={`${cell} font-[inherit]`}>Wins</th>
          <th className={`${cell} hidden font-[inherit] sm:table-cell`}>Podiums</th>
          <th className={`${cell} hidden font-[inherit] sm:table-cell`}>Poles</th>
          <th className={`${cell} hidden font-[inherit] md:table-cell`} title="Grands Prix started">
            Starts
          </th>
        </tr>
      </thead>
      <tbody>
        {[...seasons].reverse().map((s) => {
          return (
            <tr key={s.year} className="border-b border-zinc-800/70">
              <td className="px-3 py-2 tabular-nums text-zinc-400">{s.year}</td>
              <td className="px-3 py-2 text-zinc-100">{s.teams.join(", ") || "—"}</td>
              <>
                  <td className={`${cell} ${s.titles ? "font-bold text-zinc-50" : "text-zinc-200"}`} title={s.titles ? "Champion" : undefined}>
                    {s.position ?? "—"}
                    {s.titles > 0 && <span className="ml-1 text-[11px] font-semibold uppercase tracking-wider text-zinc-300">Champion</span>}
                  </td>
                  <td className={`${cell} text-zinc-200`}>{points(s.points)}</td>
                  <td className={`${cell} ${s.wins ? "text-zinc-50" : "text-zinc-500"}`}>{s.wins}</td>
                  <td className={`${cell} hidden sm:table-cell ${s.podiums ? "text-zinc-200" : "text-zinc-500"}`}>{s.podiums}</td>
                  <td className={`${cell} hidden sm:table-cell ${s.poles ? "text-zinc-200" : "text-zinc-500"}`}>{s.poles}</td>
                  <td className={`${cell} hidden text-zinc-400 md:table-cell`}>{s.starts}</td>
                </>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/** The driver's season: figures, against the teammate(s), and race by race. */
function Season({ h, year, races }: { h: DriverHistory; year: number; races: DriverRace[] }) {
  const s = summarize(driverOutings(races));
  const standing = h.seasons.find((x) => x.year === year);
  const mates = headToHeads(races);
  const team = races.at(-1)?.car.constructorId;
  return (
    <>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-5 border-y border-zinc-800 px-3 py-4 sm:grid-cols-4 lg:grid-cols-8">
        <Fact label="Championship" title={standing?.titles ? "Champion" : undefined}>
          {standing?.position != null ? `P${standing.position}` : "—"}
        </Fact>
        <Fact label="Points" title="Championship points, sprints included">
          {points(standing?.points ?? s.points)}
        </Fact>
        <Fact label="Wins">{s.wins}</Fact>
        <Fact label="Podiums">{s.podiums}</Fact>
        <Fact label="Poles">{s.poles}</Fact>
        <Fact label="Avg grid" title="Average starting position">
          {tenth(s.avgGrid)}
        </Fact>
        <Fact label="Avg finish" title="Average finishing position, when classified">
          {tenth(s.avgFinish)}
        </Fact>
        <Fact label="Retired" title="Races not classified at the finish">
          {s.retirements}
        </Fact>
      </dl>
      <div className="mt-6">
        <SeasonStrip
          races={races}
          rows={[{ key: h.driver.id, label: h.driver.lastName, results: new Map(races.map((r) => [r.raceId, r.car])) }, ...mates.map((m) => ({
            key: m.mateId,
            label: (
              <NameLink kind="driver" id={m.mateId} className="font-normal text-zinc-400">
                {h.names.drivers[m.mateId]?.lastName ?? m.mateId}
              </NameLink>
            ),
            results: new Map(races.flatMap((r) => r.mates.filter((x) => x.driverId === m.mateId).map((x) => [r.raceId, x] as const))),
          }))]}
          names={h.names}
        />
      </div>
      {mates.length > 0 && (
        <div className="mt-6">
          <Teammates list={mates} names={h.names} caption={`Against ${team ? `${h.names.teams[team] ?? team} teammates` : "teammates"} in ${year}`} />
        </div>
      )}
    </>
  );
}

function Career({ h }: { h: DriverHistory }) {
  const year = currentYear();
  const outings = useMemo(() => driverOutings(h.races), [h]);
  const t = h.seasons.reduce<DriverTotals>(sumTotals, NONE);
  const first = h.seasons[0]?.year;
  const last = h.seasons.at(-1)?.year;
  const underWay = last === year;
  const seasonYear = h.races.at(-1)?.year;
  const seasonRaces = useMemo(() => h.races.filter((r) => r.year === seasonYear), [h, seasonYear]);
  const mates = useMemo(() => headToHeads(h.races).slice(0, 8), [h]);
  const teams = useMemo(() => tally(outings, "team"), [outings]);

  return (
    <>
      <dl data-shot="" className="mt-8 grid grid-cols-2 gap-x-6 gap-y-5 border-y border-zinc-800 px-3 py-4 sm:grid-cols-4 lg:grid-cols-7">
        <Fact label="Titles">{t.titles}</Fact>
        <Fact label="Grands Prix">{t.starts}</Fact>
        <Fact label="Wins" note={share(t.wins, t.starts)}>
          {t.wins}
        </Fact>
        <Fact label="Podiums" note={share(t.podiums, t.starts)}>
          {t.podiums}
        </Fact>
        <Fact label="Poles">{t.poles}</Fact>
        <Fact label="Fastest laps">{t.fastestLaps}</Fact>
        <Fact label="Points">{points(t.points)}</Fact>
      </dl>
      {underWay ? (
        <SeasonNote through="the latest race weekend F1DB has" source={h.source} className="mt-3 px-3" />
      ) : (
        <p data-shot-credit={`History: F1DB (${h.source.license})`} className="mt-3 px-3 text-xs text-zinc-400">
          {first === last ? `${first}` : `${first}–${last}`}, {h.seasons.length} {h.seasons.length === 1 ? "season" : "seasons"}. <F1dbCredit source={h.source} />.
        </p>
      )}

      {seasonYear != null && (
        <Section title={seasonYear === year ? `${year} so far` : `Last season, ${seasonYear}`}>
          <Season h={h} year={seasonYear} races={seasonRaces} />
        </Section>
      )}

      {outings.length > 0 && (
        <Section title="Career">
          <Milestones outings={outings} names={h.names} />
          <Runs outings={outings} names={h.names} />
          <div className="mt-8 grid grid-cols-1 gap-x-8 gap-y-8 lg:grid-cols-2">
            <Teammates list={mates} names={h.names} />
            <BestCircuits outings={outings} names={h.names} />
          </div>
          {teams.length > 1 && (
            <div className="mt-8">
              <Tally rows={teams} kind="team" names={h.names} caption="Teams" />
            </div>
          )}
        </Section>
      )}

      <Section title="Seasons">
        <Seasons seasons={h.seasons} />
      </Section>
    </>
  );
}

export function DriverPage({ id }: { id: string }) {
  const h = useHistoryFile(id, fetchDriverHistory);
  const d = h && h !== "none" ? h.driver : null;
  // The team now, for a driver racing this season; a career's span otherwise.
  const last = h && h !== "none" ? h.races.at(-1) : undefined;
  const first = h && h !== "none" ? h.seasons[0]?.year : undefined;
  const lastYear = h && h !== "none" ? h.seasons.at(-1)?.year : undefined;
  const teamId = last?.year === currentYear() ? last.car.constructorId : null;
  const today = new Date().toISOString().slice(0, 10);
  const born = d ? `Born ${longDate(d.dateOfBirth)} in ${d.placeOfBirth}, ${d.countryOfBirth}` : "";
  const lived = d ? (d.dateOfDeath ? ` · died ${longDate(d.dateOfDeath)}, aged ${age(d.dateOfBirth, d.dateOfDeath)}` : ` · age ${age(d.dateOfBirth, today)}`) : "";
  const span = first != null && lastYear != null && !teamId ? (first === lastYear ? `${first}` : `${first}–${lastYear}`) : null;
  const teamName = teamId && h && h !== "none" ? (h.names.teams[teamId] ?? teamId) : null;
  const detail = d ? [d.number ? `#${d.number}` : null, teamName, d.nationality, span].filter(Boolean).join(" · ") : "";
  const name = d?.name ?? id;
  useEffect(() => {
    useShareHeading.setState({ heading: { title: name, detail, country: d?.nationality } });
    return () => useShareHeading.setState({ heading: null });
  }, [name, detail, d?.nationality]);

  return (
    <CareerPage>
      {h == null ? (
        <p className="px-3 text-sm text-zinc-400">Loading…</p>
      ) : h === "none" ? (
        <p className="px-3 text-sm text-zinc-400">No driver “{id}” in this build's history.</p>
      ) : (
        <>
          <div data-shot="title" className="px-3">
            <h1 className="flex items-center gap-3 text-3xl font-bold tracking-tight text-zinc-50">
              <Flag country={h.driver.nationalityCode} code className="h-6" />
              {h.driver.name}
            </h1>
            <p className="mt-1 text-sm text-zinc-300">
              {d?.number && `#${d.number} · `}
              {teamId && (
                <>
                  <NameLink kind="team" id={teamId}>
                    {teamName}
                  </NameLink>
                  {" · "}
                </>
              )}
              {[h.driver.nationality, span].filter(Boolean).join(" · ")}
            </p>
            <p className="mt-0.5 text-sm text-zinc-400">
              {born}
              {lived}
            </p>
          </div>
          <Career h={h} />
        </>
      )}
    </CareerPage>
  );
}
