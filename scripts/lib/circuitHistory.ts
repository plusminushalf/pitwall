// F1DB tables → one CircuitHistory per circuit (src/history/types.ts). Pure: scripts/circuit-history.ts downloads
// the release and writes the files.

import {
  CIRCUIT_HISTORY_FORMAT,
  type CircuitHistory,
  type CircuitHistoryIndex,
  type FastestLap,
  type Finisher,
  type HistoryConstructor,
  type HistoryDriver,
  type HistoryEntry,
  type HistoryLayout,
  type HistoryRace,
  type HistorySource,
  type Timed,
} from "../../src/history/types";
import type { F1db, F1dbQualifyingResult, F1dbRace } from "./f1dbTypes";

export const historySource = (release: string, generatedAt: string): HistorySource => ({
  name: "F1DB",
  release,
  url: "https://github.com/f1db/f1db",
  license: "CC BY 4.0",
  licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
  generatedAt,
});

function groupBy<T, K>(rows: readonly T[], key: (row: T) => K): Map<K, T[]> {
  const out = new Map<K, T[]>();
  for (const row of rows) {
    const k = key(row);
    const list = out.get(k);
    if (list) list.push(row);
    else out.set(k, [row]);
  }
  return out;
}

const entry = (r: { driverId: string; constructorId: string; driverNumber: string | null }): HistoryEntry => ({
  driverId: r.driverId,
  constructorId: r.constructorId,
  number: r.driverNumber,
});

/** The time that took pole: the single session's, or in knockout qualifying the last part the driver ran in. */
const poleTime = (q: F1dbQualifyingResult): Pick<Timed, "time" | "ms"> =>
  q.time != null ? { time: q.time, ms: q.timeMillis }
  : q.q3 != null ? { time: q.q3, ms: q.q3Millis }
  : q.q2 != null ? { time: q.q2, ms: q.q2Millis }
  : { time: q.q1, ms: q.q1Millis };

/** Every circuit's history, and the index of them. Races not run yet (F1DB lists the season ahead) are left out. */
export function buildCircuitHistories(db: F1db, source: HistorySource): { histories: CircuitHistory[]; index: CircuitHistoryIndex } {
  const results = groupBy(db.raceResults, (r) => r.raceId);
  const qualifying = groupBy(db.qualifyingResults, (r) => r.raceId);
  const fastest = groupBy(db.fastestLaps, (r) => r.raceId);
  const dotd = groupBy(db.driverOfTheDay, (r) => r.raceId);
  const held = db.races.filter((r) => results.has(r.id));
  const racesAt = groupBy(held, (r) => r.circuitId);
  const grandPrix = new Map(db.grandsPrix.map((g) => [g.id, g.fullName]));
  const country = new Map(db.countries.map((c) => [c.id, c.name]));
  const drivers = new Map(db.drivers.map((d) => [d.id, d]));
  const constructors = new Map(db.constructors.map((c) => [c.id, c]));
  const layoutsOf = groupBy(db.circuitLayouts, (l) => l.circuitId);

  function race(r: F1dbRace): HistoryRace {
    const res = [...(results.get(r.id) ?? [])].sort((a, b) => a.positionDisplayOrder - b.positionDisplayOrder);
    const p1 = qualifying.get(r.id)?.find((q) => q.positionNumber === 1);
    const flagged = res.find((x) => x.polePosition);
    const pole: Timed | null = p1 ? { ...entry(p1), ...poleTime(p1) } : flagged ? { ...entry(flagged), time: null, ms: null } : null;
    const podium = res
      .filter((x) => x.positionNumber != null && x.positionNumber <= 3)
      .map((x): Finisher => ({ ...entry(x), position: x.positionNumber!, grid: x.gridPositionNumber, time: x.positionNumber === 1 ? x.time : x.gap, laps: x.laps }));
    const fl = fastest.get(r.id)?.find((x) => x.positionNumber === 1);
    const fastestLap: FastestLap | null = fl ? { ...entry(fl), time: fl.time, ms: fl.timeMillis, lap: fl.lap } : null;
    const vote = dotd.get(r.id)?.find((x) => x.positionNumber === 1);
    return {
      raceId: r.id,
      year: r.year,
      round: r.round,
      date: r.date,
      grandPrixId: r.grandPrixId,
      grandPrix: grandPrix.get(r.grandPrixId) ?? r.grandPrixId,
      layoutId: r.circuitLayoutId,
      laps: r.laps,
      distanceKm: r.distance,
      sprint: r.sprintRaceDate != null,
      pole,
      podium,
      fastestLap,
      driverOfTheDay: vote ? entry(vote) : null,
      decider: { drivers: r.driversChampionshipDecider === true, constructors: r.constructorsChampionshipDecider === true },
    };
  }

  const histories: CircuitHistory[] = [];
  for (const c of db.circuits) {
    const runs = [...(racesAt.get(c.id) ?? [])].sort((a, b) => a.date.localeCompare(b.date));
    if (runs.length === 0) continue;
    const races = runs.map(race);

    const years = groupBy(runs, (r) => r.circuitLayoutId);
    const layouts = (layoutsOf.get(c.id) ?? [])
      .filter((l) => years.has(l.id))
      .map((l): HistoryLayout => {
        const ys = years.get(l.id)!.map((r) => r.year);
        return { id: l.id, current: l.effective, lengthKm: l.length, turns: l.turns, firstYear: Math.min(...ys), lastYear: Math.max(...ys) };
      })
      .sort((a, b) => a.firstYear - b.firstYear || a.lastYear - b.lastYear);

    const people: HistoryEntry[] = races.flatMap((r) => [r.pole, ...r.podium, r.fastestLap, r.driverOfTheDay].filter((e) => e != null));
    const driverMap: Record<string, HistoryDriver> = {};
    const constructorMap: Record<string, HistoryConstructor> = {};
    for (const p of people) {
      const d = drivers.get(p.driverId);
      if (d) driverMap[p.driverId] = { name: d.name, lastName: d.lastName, abbreviation: d.abbreviation, nationalityId: d.nationalityCountryId };
      const t = constructors.get(p.constructorId);
      if (t) constructorMap[p.constructorId] = { name: t.name };
    }

    histories.push({
      format: CIRCUIT_HISTORY_FORMAT,
      source,
      circuit: {
        id: c.id,
        name: c.name,
        fullName: c.fullName,
        previousNames: c.previousNames ?? [],
        type: c.type,
        direction: c.direction,
        place: c.placeName,
        country: country.get(c.countryId) ?? c.countryId,
        countryId: c.countryId,
        lat: c.latitude,
        lng: c.longitude,
        lengthKm: c.length,
        turns: c.turns,
        racesHeld: races.length,
      },
      layouts,
      races,
      drivers: driverMap,
      constructors: constructorMap,
    });
  }

  const index: CircuitHistoryIndex = {
    format: CIRCUIT_HISTORY_FORMAT,
    source,
    circuits: histories.map((h) => ({
      id: h.circuit.id,
      name: h.circuit.name,
      place: h.circuit.place,
      country: h.circuit.country,
      racesHeld: h.circuit.racesHeld,
      firstYear: h.races[0].year,
      lastYear: h.races.at(-1)!.year,
    })),
  };
  return { histories, index };
}
