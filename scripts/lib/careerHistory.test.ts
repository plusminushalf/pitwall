import { describe, expect, test } from "bun:test";
import { historySource } from "./circuitHistory";
import { buildDriverHistories } from "./driverHistory";
import { buildTeamHistories } from "./teamHistory";
import type { F1db, F1dbRaceResult, F1dbSeasonDriver } from "./f1dbTypes";

const driver = (id: string, nationalityCountryId = "netherlands") => ({
  id,
  name: `Driver ${id}`,
  firstName: "Driver",
  lastName: id,
  abbreviation: id.slice(0, 3).toUpperCase(),
  permanentNumber: id === "max" ? "3" : null,
  dateOfBirth: "1997-09-30",
  dateOfDeath: null,
  placeOfBirth: "Hasselt",
  countryOfBirthCountryId: "belgium",
  nationalityCountryId,
});

const season = (year: number, driverId: string, wins: number, position: number | null = 1): F1dbSeasonDriver => ({
  year,
  driverId,
  positionNumber: position,
  totalRaceStarts: 2,
  totalRaceWins: wins,
  totalPodiums: wins + 1,
  totalPoints: 0.1 + 0.2 + wins * 25,
  totalPolePositions: wins,
  totalFastestLaps: 0,
});

const result = (raceId: number, driverId: string, constructorId: string, driverNumber: string, position: number | null = 1, extra: Partial<F1dbRaceResult> = {}): F1dbRaceResult => ({
  raceId,
  positionDisplayOrder: position ?? 20,
  positionNumber: position,
  positionText: position == null ? "DNF" : String(position),
  driverNumber,
  driverId,
  constructorId,
  qualificationPositionNumber: position,
  points: position === 1 ? 25 : position === 2 ? 18 : null,
  reasonRetired: position == null ? "Engine" : null,
  laps: 50,
  time: null,
  gap: null,
  gridPositionNumber: position,
  polePosition: position === 1,
  fastestLap: false,
  ...extra,
});

const race = (id: number, year: number, round: number) => ({
  id,
  year,
  round,
  date: `${year}-0${round}-01`,
  grandPrixId: round === 2 ? "bahrain" : "australia",
  circuitId: "x",
  circuitLayoutId: "x",
  laps: 50,
  distance: 300,
  sprintRaceDate: null,
  driversChampionshipDecider: null,
  constructorsChampionshipDecider: null,
});

const db: F1db = {
  circuits: [],
  circuitLayouts: [],
  countries: [
    { id: "netherlands", alpha2Code: "NL", name: "Netherlands" },
    { id: "belgium", alpha2Code: "BE", name: "Belgium" },
    { id: "japan", alpha2Code: "JP", name: "Japan" },
    { id: "bahrain", alpha2Code: "BH", name: "Bahrain" },
  ],
  grandsPrix: [
    { id: "bahrain", name: "Bahrain", fullName: "Bahrain Grand Prix", shortName: "Bahrain GP", countryId: "bahrain" },
    { id: "australia", name: "Australia", fullName: "Australian Grand Prix", shortName: "Australian GP", countryId: null },
  ],
  drivers: [driver("max"), driver("yuki", "japan"), driver("liam"), driver("never")],
  constructors: [
    { id: "red-bull", name: "Red Bull", fullName: "Red Bull Racing", countryId: "netherlands" },
    { id: "racing-bulls", name: "Racing Bulls", fullName: "Racing Bulls", countryId: "japan" },
  ],
  // 2026's round 3 is on the calendar, not run yet.
  races: [race(1, 2025, 1), race(2, 2026, 1), race(3, 2026, 2), race(4, 2026, 3)],
  raceResults: [
    result(1, "max", "red-bull", "1"),
    result(2, "max", "red-bull", "3", null),
    result(2, "yuki", "racing-bulls", "22", 2),
    result(3, "max", "red-bull", "3"),
    result(3, "liam", "racing-bulls", "30", 2),
    // Didn't qualify: not a race of his.
    result(3, "yuki", "racing-bulls", "22", null, { positionText: "DNQ" }),
  ],
  qualifyingResults: [],
  fastestLaps: [],
  driverOfTheDay: [],
  seasonsDrivers: [
    season(2025, "max", 1),
    season(2024, "max", 2),
    { ...season(2023, "max", 0, null), totalRaceStarts: 0, totalPodiums: 0, totalPoints: 0 },
    season(2026, "max", 1, 2),
    season(2026, "yuki", 0, 9),
    season(2026, "liam", 0, 5),
  ],
  seasonsDriverStandings: [
    { year: 2024, driverId: "max", championshipWon: true },
    { year: 2025, driverId: "max", championshipWon: false },
  ],
  seasonsConstructors: [2025, 2026].flatMap((year) =>
    ["red-bull", "racing-bulls"].map((constructorId) => ({
      year,
      constructorId,
      positionNumber: constructorId === "red-bull" ? 1 : 2,
      totalRaceStarts: year === 2025 && constructorId === "racing-bulls" ? 0 : 2,
      totalRaceWins: constructorId === "red-bull" ? 1 : 0,
      total1And2Finishes: 0,
      totalPodiums: 1,
      totalPoints: 25,
      totalPolePositions: 1,
      totalFastestLaps: 0,
    })),
  ),
  seasonsConstructorStandings: [{ year: 2025, constructorId: "red-bull", championshipWon: true }],
  seasonsEntrantsConstructors: [
    { year: 2026, constructorId: "red-bull", engineManufacturerId: "rbpt" },
    { year: 2026, constructorId: "racing-bulls", engineManufacturerId: "rbpt" },
  ],
  engineManufacturers: [{ id: "rbpt", name: "Red Bull Ford" }],
  seasonsEntrantsDrivers: [
    { year: 2024, constructorId: "red-bull", driverId: "max", rounds: [1], testDriver: false },
    { year: 2025, constructorId: "red-bull", driverId: "max", rounds: [1], testDriver: false },
    { year: 2026, constructorId: "red-bull", driverId: "max", rounds: [1, 2], testDriver: false },
    { year: 2026, constructorId: "racing-bulls", driverId: "yuki", rounds: [1], testDriver: false },
    { year: 2026, constructorId: "racing-bulls", driverId: "liam", rounds: [2], testDriver: false },
    { year: 2026, constructorId: "red-bull", driverId: "never", rounds: [], testDriver: true },
  ],
};

describe("buildDriverHistories", () => {
  const { histories, index } = buildDriverHistories(db, historySource("v2026.16.1", "2026-10-10T00:00:00Z"));
  const max = histories.find((h) => h.driver.id === "max")!;

  test("a file for every driver with a season, its seasons oldest first (Friday practice isn't one), titles from the standings", () => {
    expect(histories.map((h) => h.driver.id)).toEqual(["max", "yuki", "liam"]);
    expect(max.seasons.map((s) => [s.year, s.titles, s.teams])).toEqual([
      [2024, 1, ["Red Bull"]],
      [2025, 0, ["Red Bull"]],
      [2026, 0, ["Red Bull"]],
    ]);
    expect(max.driver).toMatchObject({ number: "3", nationality: "Netherlands", nationalityCode: "NL", countryOfBirth: "Belgium" });
    // Floating-point sums kept to what a table prints.
    expect(max.seasons[1].points).toBe(25.3);
  });

  test("the season is the latest with a race run, through its latest round run", () => {
    expect(index.year).toBe(2026);
    expect(index.throughRound).toBe(2);
    expect(index.throughGrandPrix).toBe("Bahrain Grand Prix");
  });

  test("the season's drivers: test drivers left out, by team, the grid of the latest round marked", () => {
    expect(index.drivers.map((d) => [d.id, d.team, d.number, d.current])).toEqual([
      ["yuki", "Racing Bulls", "22", false],
      ["liam", "Racing Bulls", "30", true],
      ["max", "Red Bull", "3", true],
    ]);
  });

  test("careers to the end of last season apart from this one's", () => {
    const d = index.drivers.find((x) => x.id === "max")!;
    expect(d.before).toMatchObject({ starts: 4, wins: 3, titles: 1, points: 75.6 });
    expect(d.season).toMatchObject({ starts: 2, wins: 1, titles: 0, position: 2 });
  });
});

describe("a driver's races", () => {
  const { histories } = buildDriverHistories(db, historySource("v2026.16.1", "2026-10-10T00:00:00Z"));
  const max = histories.find((h) => h.driver.id === "max")!;
  const yuki = histories.find((h) => h.driver.id === "yuki")!;

  test("every Grand Prix started, oldest first, with teammates; a non-start left out", () => {
    expect(max.races.map((r) => [r.raceId, r.car.text, r.mates.length])).toEqual([
      [1, "1", 0],
      [2, "DNF", 0],
      [3, "1", 0],
    ]);
    expect(max.races[1].car).toEqual({ driverId: "max", constructorId: "red-bull", number: "3", text: "DNF", order: 20, reason: "Engine" });
    expect(yuki.races.map((r) => r.raceId)).toEqual([2]);
  });

  test("the names its races mention", () => {
    expect(max.names.gps.bahrain).toEqual({ name: "Bahrain Grand Prix", short: "Bahrain GP", code: "BH" });
    expect(max.names.teams).toEqual({ "red-bull": "Red Bull" });
  });
});

describe("buildTeamHistories", () => {
  const { histories, index } = buildTeamHistories(db, historySource("v2026.16.1", "2026-10-10T00:00:00Z"));
  const rb = histories.find((h) => h.team.id === "red-bull")!;

  test("a file per team with a race, its seasons with drivers and titles, its races with every car", () => {
    expect(histories.map((h) => h.team.id)).toEqual(["red-bull", "racing-bulls"]);
    expect(rb.team).toMatchObject({ name: "Red Bull", nationalityCode: "NL", engine: "Red Bull Ford" });
    expect(rb.seasons.map((s) => [s.year, s.titles, s.drivers])).toEqual([
      [2025, 1, ["max"]],
      [2026, 0, ["max"]],
    ]);
    // A season with no start isn't one.
    expect(histories[1].seasons.map((s) => s.year)).toEqual([2026]);
    expect(rb.races.map((r) => r.cars.map((c) => c.driverId))).toEqual([["max"], ["max"], ["max"]]);
  });

  test("the season's teams: its drivers, the latest round's first; history apart from the season", () => {
    expect(index.teams.map((t) => [t.id, t.drivers.map((d) => [d.id, d.current])])).toEqual([
      [
        "racing-bulls",
        [
          ["liam", true],
          ["yuki", false],
        ],
      ],
      ["red-bull", [["max", true]]],
    ]);
    expect(index.teams[1].before).toMatchObject({ starts: 2, wins: 1, titles: 1 });
    expect(index.teams[1].season).toMatchObject({ starts: 2, position: 1 });
  });
});
