// F1DB tables → one TeamHistory per constructor, and the season's teams for Home (src/history/types.ts). Pure:
// scripts/circuit-history.ts downloads the release and writes the files.

import {
  DRIVER_HISTORY_FORMAT,
  type HistorySource,
  type SeasonTeam,
  type TeamHistory,
  type TeamIndex,
  type TeamRace,
  type TeamSeason,
  type TeamTotals,
} from "../../src/history/types";
import { byDate, careers, type Careers } from "./careers";
import type { F1db, F1dbSeasonConstructor } from "./f1dbTypes";

const NONE: TeamTotals = { starts: 0, wins: 0, podiums: 0, oneTwos: 0, poles: 0, fastestLaps: 0, points: 0, titles: 0 };

const totals = (s: F1dbSeasonConstructor, champion: boolean): TeamTotals => ({
  starts: s.totalRaceStarts,
  wins: s.totalRaceWins,
  podiums: s.totalPodiums,
  oneTwos: s.total1And2Finishes,
  poles: s.totalPolePositions,
  fastestLaps: s.totalFastestLaps,
  points: Math.round(s.totalPoints * 100) / 100,
  titles: champion ? 1 : 0,
});

const add = (a: TeamTotals, b: TeamTotals): TeamTotals => ({
  starts: a.starts + b.starts,
  wins: a.wins + b.wins,
  podiums: a.podiums + b.podiums,
  oneTwos: a.oneTwos + b.oneTwos,
  poles: a.poles + b.poles,
  fastestLaps: a.fastestLaps + b.fastestLaps,
  points: Math.round((a.points + b.points) * 100) / 100,
  titles: a.titles + b.titles,
});

/** Every team's seasons and races, and the latest season's teams. */
export function buildTeamHistories(db: F1db, source: HistorySource, c: Careers = careers(db)): { histories: TeamHistory[]; index: TeamIndex } {
  const key = (year: number, id: string) => `${year}:${id}`;
  const champion = new Set(db.seasonsConstructorStandings.filter((s) => s.championshipWon).map((s) => key(s.year, s.constructorId)));
  const engine = new Map(db.engineManufacturers.map((e) => [e.id, e.name]));

  // Each team's cars in every Grand Prix, oldest first.
  const racesOf = new Map<string, TeamRace[]>();
  for (const race of [...c.races.values()].sort(byDate)) {
    const byTeam = new Map<string, TeamRace>();
    for (const r of c.cars.get(race.id)!) {
      let tr = byTeam.get(r.constructorId);
      if (!tr) byTeam.set(r.constructorId, (tr = { ...c.ref(race), cars: [] }));
      tr.cars.push(c.car(r));
    }
    for (const [id, tr] of byTeam) {
      const list = racesOf.get(id);
      if (list) list.push(tr);
      else racesOf.set(id, [tr]);
    }
  }

  // The drivers' champion each year, and the team of their last race that year.
  const driverChampion = new Map<number, string>();
  for (const s of db.seasonsDriverStandings) if (s.championshipWon) driverChampion.set(s.year, s.driverId);
  const lastTeam = new Map<string, string>();
  for (const race of [...c.races.values()].sort(byDate)) for (const r of c.cars.get(race.id)!) lastTeam.set(key(race.year, r.driverId), r.constructorId);

  // A season row per year: before ~1985 F1DB may classify a team once per engine, so rows are summed.
  const seasonsOf = new Map<string, Map<number, TeamSeason>>();
  for (const s of [...db.seasonsConstructors].sort((a, b) => a.year - b.year)) {
    const byYear = seasonsOf.get(s.constructorId) ?? new Map<number, TeamSeason>();
    const t = totals(s, champion.has(key(s.year, s.constructorId)));
    const had = byYear.get(s.year);
    const races = (racesOf.get(s.constructorId) ?? []).filter((r) => r.year === s.year);
    const count = new Map<string, number>();
    for (const r of races) for (const car of r.cars) count.set(car.driverId, (count.get(car.driverId) ?? 0) + 1);
    const winner = driverChampion.get(s.year);
    byYear.set(s.year, {
      year: s.year,
      ...(had ? add(had, { ...t, titles: 0 }) : t),
      titles: had?.titles || t.titles,
      position: had?.position != null && s.positionNumber != null ? Math.min(had.position, s.positionNumber) : (had?.position ?? s.positionNumber),
      drivers: [...count].sort((a, b) => b[1] - a[1]).map(([id]) => id),
      driversTitle: winner && lastTeam.get(key(s.year, winner)) === s.constructorId ? winner : null,
    });
    seasonsOf.set(s.constructorId, byYear);
  }

  const engineOf = (id: string, year: number) => {
    const names = db.seasonsEntrantsConstructors.filter((e) => e.constructorId === id && e.year === year).map((e) => engine.get(e.engineManufacturerId) ?? e.engineManufacturerId);
    return names.length ? [...new Set(names)].join(", ") : null;
  };

  const histories: TeamHistory[] = [];
  for (const t of db.constructors) {
    const seasons = [...(seasonsOf.get(t.id)?.values() ?? [])].filter((s) => s.starts > 0);
    if (seasons.length === 0) continue;
    const races = racesOf.get(t.id) ?? [];
    const nationality = c.country.get(t.countryId);
    histories.push({
      format: DRIVER_HISTORY_FORMAT,
      source,
      team: {
        id: t.id,
        name: t.name,
        fullName: t.fullName,
        nationality: nationality?.name ?? t.countryId,
        nationalityCode: nationality?.alpha2Code ?? "",
        engine: engineOf(t.id, seasons.at(-1)!.year),
      },
      seasons,
      races,
      names: c.names(
        races,
        races.flatMap((r) => r.cars),
      ),
    });
  }

  const { year, latest } = c;
  const teams: SeasonTeam[] = [];
  for (const h of histories) {
    const now = h.seasons.find((s) => s.year === year);
    if (!now) continue;
    const races = h.races.filter((r) => r.year === year);
    const last = races.at(-1);
    const current = new Set(last && latest && last.raceId === latest.id ? last.cars.map((x) => x.driverId) : []);
    const number = new Map(races.flatMap((r) => r.cars.map((x) => [x.driverId, Number(x.number ?? 999)] as const)));
    const drivers = [...new Set(races.flatMap((r) => r.cars.map((x) => x.driverId)))]
      .map((id) => ({ id, lastName: h.names.drivers[id]?.lastName ?? id, current: current.has(id) }))
      .sort((a, b) => Number(b.current) - Number(a.current) || number.get(a.id)! - number.get(b.id)!);
    const { year: _, drivers: __, driversTitle: ___, ...season } = now;
    teams.push({
      id: h.team.id,
      name: h.team.name,
      nationality: h.team.nationality,
      nationalityCode: h.team.nationalityCode,
      engine: h.team.engine,
      drivers,
      before: h.seasons.filter((s) => s.year < year).reduce(add, NONE),
      season,
    });
  }
  teams.sort((a, b) => a.name.localeCompare(b.name));

  const gp = latest ? db.grandsPrix.find((g) => g.id === latest.grandPrixId) : undefined;
  return {
    histories,
    index: { format: DRIVER_HISTORY_FORMAT, source, year, throughRound: latest?.round ?? null, throughGrandPrix: latest ? (gp?.fullName ?? latest.grandPrixId) : null, teams },
  };
}
