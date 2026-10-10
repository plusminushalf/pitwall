// F1DB tables → one DriverHistory per driver, and the season's drivers for Home (src/history/types.ts). Pure:
// scripts/circuit-history.ts downloads the release and writes the files.

import {
  DRIVER_HISTORY_FORMAT,
  type DriverHistory,
  type DriverIndex,
  type DriverSeason,
  type DriverTotals,
  type HistorySource,
  type SeasonDriver,
} from "../../src/history/types";
import type { F1db, F1dbSeasonDriver } from "./f1dbTypes";

const NONE: DriverTotals = { starts: 0, wins: 0, podiums: 0, poles: 0, fastestLaps: 0, points: 0, titles: 0 };

const totals = (s: F1dbSeasonDriver, champion: boolean): DriverTotals => ({
  starts: s.totalRaceStarts,
  wins: s.totalRaceWins,
  podiums: s.totalPodiums,
  poles: s.totalPolePositions,
  fastestLaps: s.totalFastestLaps,
  // F1DB sums halves and the like in floating point (2.5 + 0.5 …): kept to what a points table prints.
  points: Math.round(s.totalPoints * 100) / 100,
  titles: champion ? 1 : 0,
});

const add = (a: DriverTotals, b: DriverTotals): DriverTotals => ({
  starts: a.starts + b.starts,
  wins: a.wins + b.wins,
  podiums: a.podiums + b.podiums,
  poles: a.poles + b.poles,
  fastestLaps: a.fastestLaps + b.fastestLaps,
  points: Math.round((a.points + b.points) * 100) / 100,
  titles: a.titles + b.titles,
});

/** Every driver's seasons, and the latest season's drivers (the latest season with a race run). */
export function buildDriverHistories(db: F1db, source: HistorySource): { histories: DriverHistory[]; index: DriverIndex } {
  const country = new Map(db.countries.map((c) => [c.id, c]));
  const constructor = new Map(db.constructors.map((c) => [c.id, c.name]));
  const champion = new Set(db.seasonsDriverStandings.filter((s) => s.championshipWon).map((s) => `${s.year}:${s.driverId}`));
  const key = (year: number, driverId: string) => `${year}:${driverId}`;

  // The teams a driver raced for in a season, in the order raced for them (test drivers have no rounds).
  const entries = new Map<string, { team: string; first: number; rounds: number[] }[]>();
  for (const e of db.seasonsEntrantsDrivers) {
    if (e.testDriver || e.rounds.length === 0) continue;
    const k = key(e.year, e.driverId);
    const list = entries.get(k) ?? [];
    list.push({ team: e.constructorId, first: Math.min(...e.rounds), rounds: e.rounds });
    entries.set(k, list);
  }
  const teamsOf = (year: number, driverId: string) =>
    [...new Set((entries.get(key(year, driverId)) ?? []).sort((a, b) => a.first - b.first).map((e) => constructor.get(e.team) ?? e.team))];

  const seasonsOf = new Map<string, DriverSeason[]>();
  for (const s of [...db.seasonsDrivers].sort((a, b) => a.year - b.year)) {
    const teams = teamsOf(s.year, s.driverId);
    // Friday practice only (Verstappen's 2014): no race entered, not a season of the career.
    if (teams.length === 0 && s.totalRaceStarts === 0) continue;
    const list = seasonsOf.get(s.driverId) ?? [];
    list.push({ year: s.year, teams, position: s.positionNumber, ...totals(s, champion.has(key(s.year, s.driverId))) });
    seasonsOf.set(s.driverId, list);
  }

  const histories: DriverHistory[] = [];
  const bios = new Map<string, DriverHistory["driver"]>();
  for (const d of db.drivers) {
    const seasons = seasonsOf.get(d.id);
    if (!seasons) continue;
    const nationality = country.get(d.nationalityCountryId);
    const driver = {
      id: d.id,
      name: d.name,
      firstName: d.firstName,
      lastName: d.lastName,
      abbreviation: d.abbreviation,
      number: d.permanentNumber,
      dateOfBirth: d.dateOfBirth,
      dateOfDeath: d.dateOfDeath,
      placeOfBirth: d.placeOfBirth,
      countryOfBirth: country.get(d.countryOfBirthCountryId)?.name ?? d.countryOfBirthCountryId,
      nationality: nationality?.name ?? d.nationalityCountryId,
      nationalityCode: nationality?.alpha2Code ?? "",
    };
    bios.set(d.id, driver);
    histories.push({ format: DRIVER_HISTORY_FORMAT, source, driver, seasons });
  }

  // The season: the latest with a race run (F1DB lists a season's entrants before it starts).
  const held = new Set(db.raceResults.map((r) => r.raceId));
  const run = db.races.filter((r) => held.has(r.id));
  const year = Math.max(...run.map((r) => r.year));
  const latest = run.filter((r) => r.year === year).sort((a, b) => b.round - a.round)[0];
  const roundOf = new Map(run.filter((r) => r.year === year).map((r) => [r.id, r.round]));
  const results = db.raceResults.filter((r) => roundOf.has(r.raceId));

  const drivers: SeasonDriver[] = [];
  for (const [k, list] of entries) {
    const [y, driverId] = [Number(k.slice(0, k.indexOf(":"))), k.slice(k.indexOf(":") + 1)];
    const bio = bios.get(driverId);
    if (y !== year || !bio) continue;
    const rounds = [...new Set(list.flatMap((e) => e.rounds))].sort((a, b) => a - b);
    // The car and team of the driver's latest race this season.
    const last = results.filter((r) => r.driverId === driverId).sort((a, b) => roundOf.get(b.raceId)! - roundOf.get(a.raceId)!)[0];
    const seasons = seasonsOf.get(driverId) ?? [];
    const thisSeason = seasons.find((s) => s.year === year);
    drivers.push({
      id: driverId,
      name: bio.name,
      lastName: bio.lastName,
      abbreviation: bio.abbreviation,
      number: last?.driverNumber ?? bio.number,
      nationality: bio.nationality,
      nationalityCode: bio.nationalityCode,
      team: constructor.get(last?.constructorId ?? list.at(-1)!.team) ?? list.at(-1)!.team,
      rounds,
      current: latest != null && rounds.includes(latest.round),
      before: seasons.filter((s) => s.year < year).reduce(add, NONE),
      season: thisSeason ? totalsOf(thisSeason) : { ...NONE, position: null },
    });
  }
  drivers.sort((a, b) => a.team.localeCompare(b.team) || Number(a.number ?? 999) - Number(b.number ?? 999) || a.id.localeCompare(b.id));

  const grandPrix = new Map(db.grandsPrix.map((g) => [g.id, g.fullName]));
  return {
    histories,
    index: {
      format: DRIVER_HISTORY_FORMAT,
      source,
      year,
      throughRound: latest?.round ?? null,
      throughGrandPrix: latest ? (grandPrix.get(latest.grandPrixId) ?? latest.grandPrixId) : null,
      drivers,
    },
  };
}

/** A season's totals and position, without its year and teams. */
const totalsOf = ({ year: _, teams: __, ...rest }: DriverSeason): SeasonDriver["season"] => rest;
