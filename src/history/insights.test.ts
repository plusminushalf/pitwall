import { describe, expect, test } from "bun:test";
import { currentLayout, lastPodiums, lastPoles, leaders, poleLapRecord, poleToWin, raceLapRecord } from "./insights";
import type { CircuitHistory, Finisher, HistoryRace } from "./types";

const at = (driverId: string) => ({ driverId, constructorId: `${driverId}-team`, number: null });
const finisher = (position: number, driverId: string): Finisher => ({ ...at(driverId), position, grid: position, time: null, laps: 53 });

const race = (year: number, layoutId: string, pole: [string, number | null] | null, podium: string[], fastestLapMs: number | null = null): HistoryRace => ({
  raceId: year,
  year,
  round: 1,
  date: `${year}-09-07`,
  grandPrixId: "italy",
  grandPrix: "Italian Grand Prix",
  layoutId,
  laps: 53,
  distanceKm: 306.72,
  sprint: false,
  pole: pole && { ...at(pole[0]), time: null, ms: pole[1] },
  podium: podium.map((d, i) => finisher(i + 1, d)),
  fastestLap: fastestLapMs == null ? null : { ...at(podium[0]), time: null, ms: fastestLapMs, lap: 30 },
  driverOfTheDay: null,
  decider: { drivers: false, constructors: false },
});

const history: CircuitHistory = {
  format: 1,
  source: { name: "F1DB", release: "v1", url: "", license: "CC BY 4.0", licenseUrl: "", generatedAt: "" },
  circuit: { id: "monza", name: "Monza", fullName: "", previousNames: [], type: "RACE", direction: "CLOCKWISE", place: "Monza", country: "Italy", countryId: "italy", lat: 0, lng: 0, lengthKm: 5.793, turns: 11, racesHeld: 7 },
  layouts: [
    { id: "old", current: false, lengthKm: 5.8, turns: 10, firstYear: 1990, lastYear: 1990 },
    { id: "new", current: true, lengthKm: 5.793, turns: 11, firstYear: 2020, lastYear: 2025 },
  ],
  races: [
    race(1990, "old", ["senna", 70000], ["senna", "prost", "berger"], 60000), // faster, but on the old layout
    race(2020, "new", ["hamilton", 79000], ["gasly", "sainz", "stroll"], 82000),
    race(2021, "new", ["bottas", 80000], ["ricciardo", "norris", "bottas"], 81000),
    race(2022, "new", ["leclerc", 79500], ["verstappen", "leclerc", "russell"], 81000),
    race(2023, "new", ["sainz", 80300], ["verstappen", "perez", "sainz"], 82500),
    race(2024, "new", ["norris", 79300], ["leclerc", "piastri", "norris"], 81432),
    race(2025, "new", null, []), // results not known
  ],
  drivers: {},
  constructors: {},
};

describe("circuit insights", () => {
  test("the current layout", () => {
    expect(currentLayout(history)?.id).toBe("new");
    expect(currentLayout({ ...history, layouts: history.layouts.map((l) => ({ ...l, current: false })) })?.id).toBe("new");
  });

  test("the last poles and podiums, newest first, skipping races without them", () => {
    expect(lastPoles(history).map((p) => [p.race.year, p.pole.driverId])).toEqual([
      [2024, "norris"],
      [2023, "sainz"],
      [2022, "leclerc"],
      [2021, "bottas"],
      [2020, "hamilton"],
    ]);
    expect(lastPodiums(history, 2).map((r) => r.podium.map((p) => p.driverId))).toEqual([
      ["leclerc", "piastri", "norris"],
      ["verstappen", "perez", "sainz"],
    ]);
  });

  test("lap records are on the current layout unless asked, the first to set a time keeping it", () => {
    expect(raceLapRecord(history)).toMatchObject({ race: { year: 2021 }, lap: { ms: 81000 } });
    expect(raceLapRecord(history, "old")).toMatchObject({ race: { year: 1990 }, lap: { ms: 60000 } });
    expect(poleLapRecord(history)).toMatchObject({ race: { year: 2020 }, lap: { driverId: "hamilton", ms: 79000 } });
    expect(raceLapRecord(history, "gone")).toBeNull();
  });

  test("most wins, poles and podiums, ties going to the more recent", () => {
    expect(leaders(history, "wins").slice(0, 2)).toEqual([
      { id: "verstappen", count: 2, lastYear: 2023 },
      { id: "leclerc", count: 1, lastYear: 2024 },
    ]);
    expect(leaders(history, "podiums").slice(0, 3).map((l) => [l.id, l.count])).toEqual([
      ["leclerc", 2],
      ["norris", 2],
      ["sainz", 2],
    ]);
    expect(leaders(history, "poles", "constructor")[0]).toEqual({ id: "norris-team", count: 1, lastYear: 2024 });
  });

  test("pole to win, over races with both known", () => {
    expect(poleToWin(history)).toEqual({ races: 6, wins: 1 });
    expect(poleToWin(history, 2020)).toEqual({ races: 5, wins: 0 });
  });
});
