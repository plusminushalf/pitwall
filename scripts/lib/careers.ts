// What the driver and team history builds share (driverHistory.ts, teamHistory.ts): the Grands Prix run, every car
// that started them, the season under way, and the names a file's races mention.

import type { CarResult, HistoryNames, RaceRef } from "../../src/history/types";
import type { F1db, F1dbRace, F1dbRaceResult } from "./f1dbTypes";

/** Entries that never started: not a race of the driver's or the team's. */
const NOT_STARTED = new Set(["DNQ", "DNPQ", "DNS", "DNP"]);

export interface Careers {
  /** Grands Prix with results, by id. */
  races: Map<number, F1dbRace>;
  /** The cars that started each, in result order. */
  cars: Map<number, F1dbRaceResult[]>;
  /** The latest season with a race run, and its latest round run (F1DB lists the season ahead too). */
  year: number;
  latest: F1dbRace | undefined;
  country: Map<string, { name: string; alpha2Code: string }>;
  team: (id: string) => string;
  ref: (race: F1dbRace) => RaceRef;
  car: (r: F1dbRaceResult) => CarResult;
  /** The names `races` and their cars mention. */
  names: (races: readonly { gp: string; circuit: string }[], cars: readonly CarResult[]) => HistoryNames;
}

export function careers(db: F1db): Careers {
  const country = new Map(db.countries.map((c) => [c.id, c]));
  const constructorName = new Map(db.constructors.map((c) => [c.id, c.name]));
  const team = (id: string) => constructorName.get(id) ?? id;
  const gp = new Map(db.grandsPrix.map((g) => [g.id, g]));
  const circuit = new Map(db.circuits.map((c) => [c.id, c.name]));
  const driver = new Map(db.drivers.map((d) => [d.id, d]));

  const cars = new Map<number, F1dbRaceResult[]>();
  for (const r of db.raceResults) {
    if (NOT_STARTED.has(r.positionText)) continue;
    const list = cars.get(r.raceId) ?? [];
    list.push(r);
    cars.set(r.raceId, list);
  }
  for (const list of cars.values()) list.sort((a, b) => a.positionDisplayOrder - b.positionDisplayOrder);
  const races = new Map(db.races.filter((r) => cars.has(r.id)).map((r) => [r.id, r]));
  const run = [...races.values()];
  const year = Math.max(...run.map((r) => r.year));
  const latest = run.filter((r) => r.year === year).sort((a, b) => b.round - a.round)[0];

  const car = (r: F1dbRaceResult): CarResult => {
    const out: CarResult = { driverId: r.driverId, constructorId: r.constructorId, text: r.positionText, order: r.positionDisplayOrder };
    if (r.driverNumber != null) out.number = r.driverNumber;
    if (r.qualificationPositionNumber != null) out.quali = r.qualificationPositionNumber;
    if (r.gridPositionNumber != null) out.grid = r.gridPositionNumber;
    if (r.positionNumber != null) out.pos = r.positionNumber;
    // Floating-point halves (2.5 + 0.5 …), kept to what a points table prints.
    if (r.points) out.points = Math.round(r.points * 100) / 100;
    if (r.polePosition) out.pole = true;
    if (r.fastestLap) out.fastestLap = true;
    if (r.reasonRetired) out.reason = r.reasonRetired;
    return out;
  };

  const ref = (r: F1dbRace): RaceRef => ({ raceId: r.id, year: r.year, round: r.round, date: r.date, gp: r.grandPrixId, circuit: r.circuitId });

  const names = (rs: readonly { gp: string; circuit: string }[], cs: readonly CarResult[]): HistoryNames => {
    const out: HistoryNames = { gps: {}, circuits: {}, teams: {}, drivers: {} };
    for (const r of rs) {
      const g = gp.get(r.gp);
      out.gps[r.gp] = { name: g?.fullName ?? r.gp, short: g?.shortName ?? r.gp, code: (g?.countryId && country.get(g.countryId)?.alpha2Code) || "" };
      out.circuits[r.circuit] = circuit.get(r.circuit) ?? r.circuit;
    }
    for (const c of cs) {
      out.teams[c.constructorId] = team(c.constructorId);
      const d = driver.get(c.driverId);
      out.drivers[c.driverId] = { name: d?.name ?? c.driverId, lastName: d?.lastName ?? c.driverId };
    }
    return out;
  };

  return { races, cars, year, latest, country, team, ref, car, names };
}

/** Grands Prix by date. */
export const byDate = (a: { date: string; round: number }, b: { date: string; round: number }) => a.date.localeCompare(b.date) || a.round - b.round;
