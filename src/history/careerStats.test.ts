import { describe, expect, test } from "bun:test";
import { bestCircuits, driverOutings, driverSplit, headToHeads, milestones, summarize, tally, teamOutings, winStreak } from "./careerStats";
import type { CarResult, DriverRace, TeamRace } from "./types";

const car = (driverId: string, pos: number | null, extra: Partial<CarResult> = {}): CarResult => ({
  driverId,
  constructorId: "red-bull",
  text: pos == null ? "DNF" : String(pos),
  order: pos ?? 20,
  ...(pos != null ? { pos } : {}),
  ...extra,
});

const ref = (raceId: number, year = 2025, circuit = "monza") => ({ raceId, year, round: raceId, date: `${year}-01-${String(raceId).padStart(2, "0")}`, gp: "italy", circuit });

// Max against Checo: ahead, ahead, behind (retired), ahead.
const races: DriverRace[] = [
  { ...ref(1, 2024), car: car("max", 5, { quali: 3, grid: 3, points: 10 }), mates: [car("checo", 8, { quali: 6, grid: 6, points: 4 })] },
  { ...ref(2, 2025, "zandvoort"), car: car("max", 1, { quali: 1, grid: 1, points: 25, pole: true }), mates: [car("checo", 2, { quali: 2, grid: 2, points: 18 })] },
  { ...ref(3, 2025, "zandvoort"), car: car("max", null, { quali: 4, grid: 4, reason: "Engine" }), mates: [car("checo", 3, { quali: 2, grid: 2, points: 15 })] },
  { ...ref(4, 2025), car: car("max", 1, { quali: 2, grid: 2, points: 25 }), mates: [car("checo", 4, { quali: 5, grid: 5, points: 12 })] },
];

describe("a driver's races", () => {
  const outings = driverOutings(races);

  test("a season summed up: averages over starts and over classified finishes", () => {
    const s = summarize(outings.filter((o) => o.race.year === 2025));
    expect(s).toMatchObject({ races: 3, wins: 2, podiums: 2, poles: 1, points: 50, retirements: 1, pointsFinishes: 2, avgFinish: 1 });
    expect(s.avgGrid).toBeCloseTo(7 / 3);
    expect(s.best?.pos).toBe(1);
  });

  test("head-to-head with a teammate: qualifying, race (a retirement loses), points, years", () => {
    expect(headToHeads(races)).toEqual([{ mateId: "checo", races: 4, quali: [3, 1], race: [3, 1], points: [60, 49], years: [2024, 2025] }]);
  });

  test("firsts and latests; a latest the same race as the first is left out", () => {
    expect(milestones(outings).map((m) => [m.label, m.race.raceId])).toEqual([
      ["Debut", 1],
      ["First points", 1],
      ["First podium", 2],
      ["First pole", 2],
      ["First win", 2],
      ["Latest win", 4],
    ]);
  });

  test("streaks and circuits", () => {
    expect(winStreak(outings)).toMatchObject({ length: 1 });
    expect(bestCircuits(outings)).toEqual([
      { circuit: "zandvoort", races: 2, wins: 1, poles: 1, podiums: 1 },
      { circuit: "monza", races: 2, wins: 1, poles: 0, podiums: 1 },
    ]);
  });
});

describe("a team's races", () => {
  const team: TeamRace[] = races.map(({ car: c, mates, ...r }) => ({ ...r, cars: [c, ...mates] }));
  const outings = teamOutings(team);

  test("1-2s, a team's firsts, its drivers", () => {
    expect(summarize(outings).oneTwos).toBe(1);
    expect(milestones(outings, true).find((m) => m.label === "First 1-2")?.race.raceId).toBe(2);
    expect(driverSplit(outings).map((d) => [d.driverId, d.points, d.best])).toEqual([
      ["max", 60, 1],
      ["checo", 49, 2],
    ]);
    expect(tally(outings, "driver").map((d) => [d.id, d.wins, d.starts])).toEqual([
      ["max", 2, 4],
      ["checo", 0, 4],
    ]);
  });
});
