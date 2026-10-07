import { describe, expect, test } from "bun:test";
import { buildCircuitHistories, historySource } from "./circuitHistory";
import type { F1db, F1dbFastestLap, F1dbQualifyingResult, F1dbRace, F1dbRaceResult } from "./f1dbTypes";

const race = (id: number, year: number, layout: string, extra: Partial<F1dbRace> = {}): F1dbRace => ({
  id,
  year,
  round: 14,
  date: `${year}-09-07`,
  grandPrixId: "italy",
  circuitId: "monza",
  circuitLayoutId: layout,
  laps: 53,
  distance: 306.72,
  sprintRaceDate: null,
  driversChampionshipDecider: false,
  constructorsChampionshipDecider: false,
  ...extra,
});

const row = (raceId: number, position: number | null, driverId: string, order = position ?? 99) => ({
  raceId,
  positionDisplayOrder: order,
  positionNumber: position,
  positionText: position == null ? "DNF" : String(position),
  driverNumber: "1",
  driverId,
  constructorId: `${driverId}-team`,
});

const result = (raceId: number, position: number | null, driverId: string, extra: Partial<F1dbRaceResult> = {}): F1dbRaceResult => ({
  ...row(raceId, position, driverId),
  laps: 53,
  time: position === 1 ? "1:13:24.325" : null,
  gap: position != null && position > 1 ? `+${position}.000` : null,
  gridPositionNumber: position,
  polePosition: false,
  fastestLap: false,
  ...extra,
});

const quali = (raceId: number, driverId: string, times: Partial<F1dbQualifyingResult>): F1dbQualifyingResult => ({
  ...row(raceId, 1, driverId),
  time: null,
  timeMillis: null,
  q1: null,
  q1Millis: null,
  q2: null,
  q2Millis: null,
  q3: null,
  q3Millis: null,
  ...times,
});

const fastest = (raceId: number, driverId: string, ms: number): F1dbFastestLap => ({ ...row(raceId, 1, driverId), lap: 40, time: `${ms}`, timeMillis: ms });

const db: F1db = {
  circuits: [
    { id: "monza", name: "Monza", fullName: "Autodromo Nazionale Monza", previousNames: null, type: "RACE", direction: "CLOCKWISE", placeName: "Monza", countryId: "italy", latitude: 45.6, longitude: 9.3, length: 5.793, turns: 11, totalRacesHeld: 3 },
    { id: "never", name: "Never", fullName: "Never Raced", previousNames: null, type: "STREET", direction: "CLOCKWISE", placeName: "Nowhere", countryId: "italy", latitude: 0, longitude: 0, length: 5, turns: 20, totalRacesHeld: 0 },
  ],
  circuitLayouts: [
    { id: "monza-6", circuitId: "monza", effective: false, length: 5.8, turns: 10 },
    { id: "monza-7", circuitId: "monza", effective: true, length: 5.793, turns: 11 },
    { id: "monza-0", circuitId: "monza", effective: false, length: 10, turns: 20 },
  ],
  countries: [{ id: "italy", name: "Italy" }],
  grandsPrix: [{ id: "italy", fullName: "Italian Grand Prix" }],
  drivers: ["schumacher", "norris", "leclerc", "piastri"].map((id) => ({ id, name: `Driver ${id}`, lastName: id, abbreviation: id.slice(0, 3).toUpperCase(), nationalityCountryId: "italy" })),
  constructors: ["schumacher", "norris", "leclerc", "piastri"].map((id) => ({ id: `${id}-team`, name: `Team ${id}` })),
  // Out of date order, and with next year's race, which hasn't been run.
  races: [race(3, 2025, "monza-7", { sprintRaceDate: "2025-09-06", driversChampionshipDecider: true }), race(1, 1999, "monza-6"), race(2, 2024, "monza-7"), race(4, 2027, "monza-7")],
  raceResults: [
    result(1, 1, "schumacher"),
    result(2, null, "piastri", { positionText: "DNF", positionDisplayOrder: 20 }),
    result(2, 2, "norris", { polePosition: true }),
    result(2, 1, "leclerc", { gridPositionNumber: 4 }),
    result(2, 3, "piastri", { driverId: "schumacher", constructorId: "schumacher-team" }),
    result(3, 1, "norris"),
  ],
  qualifyingResults: [quali(1, "schumacher", { time: "1:22.432", timeMillis: 82432 }), quali(3, "norris", { q1: "1:20.0", q1Millis: 80000, q3: "1:18.792", q3Millis: 78792 })],
  fastestLaps: [fastest(1, "schumacher", 85000), fastest(2, "norris", 81432), fastest(3, "leclerc", 82000)],
  driverOfTheDay: [row(3, 1, "leclerc"), row(3, 2, "norris")],
};

describe("buildCircuitHistories", () => {
  const { histories, index } = buildCircuitHistories(db, historySource("v2026.16.0", "2026-10-07T00:00:00Z"));
  const monza = histories[0];

  test("a file for each circuit that's held a race, its races in date order, races not run yet left out", () => {
    expect(histories.map((h) => h.circuit.id)).toEqual(["monza"]);
    expect(monza.races.map((r) => r.year)).toEqual([1999, 2024, 2025]);
    expect(monza.circuit.racesHeld).toBe(3);
    expect(monza.circuit.country).toBe("Italy");
    expect(index.circuits).toEqual([{ id: "monza", name: "Monza", place: "Monza", country: "Italy", racesHeld: 3, firstYear: 1999, lastYear: 2025 }]);
    expect(monza.source.release).toBe("v2026.16.0");
  });

  test("only layouts raced on, oldest first, with their years", () => {
    expect(monza.layouts).toEqual([
      { id: "monza-6", current: false, lengthKm: 5.8, turns: 10, firstYear: 1999, lastYear: 1999 },
      { id: "monza-7", current: true, lengthKm: 5.793, turns: 11, firstYear: 2024, lastYear: 2025 },
    ]);
  });

  test("pole is qualifying's fastest with the time that took it, or the race's pole flag without one", () => {
    const [r1999, r2024, r2025] = monza.races;
    expect(r1999.pole).toMatchObject({ driverId: "schumacher", time: "1:22.432", ms: 82432 });
    expect(r2025.pole).toMatchObject({ driverId: "norris", time: "1:18.792", ms: 78792 });
    expect(r2024.pole).toEqual({ driverId: "norris", constructorId: "norris-team", number: "1", time: null, ms: null });
  });

  test("the podium in finishing order, the winner with the race time and the others with their gaps", () => {
    const r2024 = monza.races[1];
    expect(r2024.podium.map((p) => [p.position, p.driverId, p.grid, p.time])).toEqual([
      [1, "leclerc", 4, "1:13:24.325"],
      [2, "norris", 2, "+2.000"],
      [3, "schumacher", 3, "+3.000"],
    ]);
  });

  test("fastest lap, driver of the day, sprint weekends and title deciders", () => {
    const r2025 = monza.races[2];
    expect(r2025.fastestLap).toMatchObject({ driverId: "leclerc", ms: 82000, lap: 40 });
    expect(r2025.driverOfTheDay?.driverId).toBe("leclerc");
    expect(r2025.sprint).toBe(true);
    expect(r2025.decider).toEqual({ drivers: true, constructors: false });
    expect(monza.races[0].driverOfTheDay).toBeNull();
  });

  test("names for every driver and team the races mention, and no others", () => {
    expect(Object.keys(monza.drivers).sort()).toEqual(["leclerc", "norris", "schumacher"]);
    expect(monza.drivers.norris).toEqual({ name: "Driver norris", lastName: "norris", abbreviation: "NOR", nationalityId: "italy" });
    expect(monza.constructors["leclerc-team"]).toEqual({ name: "Team leclerc" });
  });
});
