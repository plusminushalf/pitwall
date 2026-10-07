import { describe, expect, test } from "bun:test";
import { neutralLaps, onTrackPasses, strategies, summarize, type RawRaceControl } from "./pastRaces";

const rc = (lap: number, category: string, message: string, flag: string | null = null): RawRaceControl => ({ lap_number: lap, category, flag, message });

describe("neutral laps from race control", () => {
  test("Singapore 2023: a safety car, then a VSC", () => {
    const messages = [
      rc(1, "SessionStatus", "SESSION STARTED"),
      rc(20, "SafetyCar", "SAFETY CAR DEPLOYED"),
      rc(22, "SafetyCar", "SAFETY CAR IN THIS LAP"),
      rc(44, "SafetyCar", "VIRTUAL SAFETY CAR DEPLOYED"),
      rc(45, "SafetyCar", "VIRTUAL SAFETY CAR ENDING"),
      rc(62, "Flag", "CHEQUERED FLAG", "CHEQUERED"),
    ];
    expect(neutralLaps(messages, 62)).toEqual([
      { kind: "SC", from: 20, to: 22 },
      { kind: "VSC", from: 44, to: 45 },
    ]);
  });

  test("Melbourne 2023: three red flags, standing restarts, the safety car before the first", () => {
    const messages = [
      rc(1, "SessionStatus", "SESSION STARTED"),
      rc(1, "SafetyCar", "SAFETY CAR DEPLOYED"),
      rc(3, "SafetyCar", "SAFETY CAR IN THIS LAP"),
      rc(7, "SafetyCar", "SAFETY CAR DEPLOYED"),
      rc(8, "Flag", "RED FLAG", "RED"),
      rc(8, "SessionStatus", "SESSION ABORTED"),
      rc(9, "Other", "RACE WILL RESUME AT 15:33 - STANDING START PROCEDURE"),
      rc(9, "SessionStatus", "SESSION STARTED"),
      rc(18, "SafetyCar", "VIRTUAL SAFETY CAR DEPLOYED"),
      rc(19, "SafetyCar", "VIRTUAL SAFETY CAR ENDING"),
      rc(54, "SafetyCar", "SAFETY CAR DEPLOYED"),
      rc(55, "Flag", "RED FLAG", "RED"),
      rc(56, "SessionStatus", "SESSION STARTED"),
      rc(57, "Flag", "RED FLAG", "RED"),
      rc(58, "SessionStatus", "SESSION STARTED"),
      rc(58, "Flag", "CHEQUERED FLAG", "CHEQUERED"),
      rc(58, "Flag", "RED FLAG", "RED"),
    ];
    expect(neutralLaps(messages, 58)).toEqual([
      { kind: "SC", from: 1, to: 3 },
      { kind: "SC", from: 7, to: 8 },
      { kind: "RED", from: 8, to: 8 },
      { kind: "VSC", from: 18, to: 19 },
      { kind: "SC", from: 54, to: 55 },
      { kind: "RED", from: 55, to: 55 },
      { kind: "RED", from: 57, to: 57 },
    ]);
  });

  test("2026's wording; a safety car called while stopped leads the restart; one still out at the end runs to it", () => {
    const messages = [
      rc(10, "SafetyCar", "VSC DEPLOYED"),
      rc(11, "SafetyCar", "VSC ENDING"),
      rc(30, "Other", "RED FLAG - RACE SUSPENDED"),
      rc(30, "SafetyCar", "SAFETY CAR DEPLOYED"),
      rc(31, "SessionStatus", "SESSION RESUMED"),
      rc(33, "SafetyCar", "SAFETY CAR IN THIS LAP"),
      rc(50, "SafetyCar", "SAFETY CAR DEPLOYED"),
    ];
    expect(neutralLaps(messages, 52)).toEqual([
      { kind: "VSC", from: 10, to: 11 },
      { kind: "RED", from: 30, to: 30 },
      { kind: "SC", from: 31, to: 33 },
      { kind: "SC", from: 50, to: 52 },
    ]);
  });

  test("a quiet race: none", () => {
    expect(neutralLaps([rc(1, "SessionStatus", "SESSION STARTED"), rc(62, "Flag", "CHEQUERED FLAG", "CHEQUERED")], 62)).toEqual([]);
  });
});

describe("summary", () => {
  const session = { sessionKey: 9165, year: 2023, meetingName: "Singapore Grand Prix", sessionName: "Race", dateStart: "2023-09-17T12:00:00+00:00" };
  const race = summarize(session, {
    drivers: [
      { driver_number: 55, name_acronym: "SAI", full_name: "Carlos SAINZ", team_name: "Ferrari", team_colour: "F91536" },
      { driver_number: 4, name_acronym: "NOR", full_name: "Lando NORRIS", team_name: "McLaren", team_colour: "F58020" },
      { driver_number: 63, name_acronym: "RUS", full_name: "George RUSSELL", team_name: "Mercedes", team_colour: "6CD3BF" },
    ],
    raceControl: [],
    stints: [
      { driver_number: 55, lap_start: 1, lap_end: 20, compound: "MEDIUM" },
      { driver_number: 55, lap_start: 21, lap_end: null, compound: "HARD" },
      { driver_number: 63, lap_start: 1, lap_end: 61, compound: "HARD" },
      { driver_number: 4, lap_start: 1, lap_end: 20, compound: "MEDIUM" },
      { driver_number: 4, lap_start: 21, lap_end: 62, compound: "HARD" },
    ],
    results: [
      { driver_number: 63, position: null, number_of_laps: 61, dnf: true },
      { driver_number: 4, position: 2, number_of_laps: 62 },
      { driver_number: 55, position: 1, number_of_laps: 62 },
    ],
  });

  test("the race distance is the winner's; classified first, in order; open stints end with the car's laps", () => {
    expect(race.laps).toBe(62);
    expect(race.finish.map((f) => [f.driver, f.position, f.status])).toEqual([
      [55, 1, "finished"],
      [4, 2, "finished"],
      [63, null, "dnf"],
    ]);
    expect(race.stints.filter((s) => s.driver === 55)).toEqual([
      { driver: 55, compound: "MEDIUM", from: 1, to: 20 },
      { driver: 55, compound: "HARD", from: 21, to: 62 },
    ]);
  });

  test("strategies in finishing order, with the driver", () => {
    expect(strategies(race).map((s) => [s.driver?.code, s.stints.length])).toEqual([
      ["SAI", 2],
      ["NOR", 2],
      ["RUS", 1],
    ]);
  });
});

describe("passes on track", () => {
  const at = (s: number) => new Date(Date.UTC(2023, 8, 17, 12, 0, s)).toISOString();
  // Each car's laps start every 100 s: lap n starts at (n - 1) * 100.
  const laps = [1, 2, 3, 4, 5, 6].flatMap((d) => Array.from({ length: 10 }, (_, i) => ({ driver_number: d, lap_number: i + 1, date_start: at(i * 100), lap_duration: 100, is_pit_out_lap: false })));
  const ov = (s: number, by: number, on: number) => ({ overtaking_driver_number: by, overtaken_driver_number: on, date: at(s) });
  const ctx = { laps, pits: [{ driver_number: 3, lap_number: 5 }], neutral: [{ kind: "SC" as const, from: 7, to: 8 }], retiredAfter: new Map([[6, 4]]) };

  test("lap 1, a neutral phase, a pit stop (that lap or the one before) and a retiring car are left out", () => {
    const passes = onTrackPasses([ov(50, 1, 2), ov(250, 1, 2), ov(450, 2, 3), ov(550, 1, 3), ov(650, 4, 1), ov(750, 2, 1), ov(310, 5, 6)], ctx);
    // Kept: only lap 3's. Lap 1; 3 pitting on lap 5 (passed on 5 and 6); laps 7-8 behind the safety car; 6 retiring after lap 4.
    expect(passes).toEqual([{ lap: 3, by: 1, on: 2 }]);
  });

  test("a swap undone within 5 s, and a car passed by three within 15 s, are timing noise", () => {
    const passes = onTrackPasses([ov(220, 1, 2), ov(223, 2, 1), ov(230, 3, 4), ov(231, 5, 4), ov(232, 1, 4), ov(260, 2, 1)], { ...ctx, pits: [], neutral: [], retiredAfter: new Map() });
    expect(passes).toEqual([{ lap: 3, by: 2, on: 1 }]);
  });
});

describe("pit stops and pace", () => {
  const session = { sessionKey: 1, year: 2025, meetingName: "GP", sessionName: "Race", dateStart: "2025-10-05T12:00:00Z" };
  const lap = (driver: number, n: number, duration: number, out = false) => ({ driver_number: driver, lap_number: n, date_start: null, lap_duration: duration, is_pit_out_lap: out });
  const race = summarize(session, {
    drivers: [],
    raceControl: [{ lap_number: 4, category: "SafetyCar", flag: null, message: "SAFETY CAR DEPLOYED" }, { lap_number: 5, category: "SafetyCar", flag: null, message: "SAFETY CAR IN THIS LAP" }],
    stints: [],
    results: [{ driver_number: 1, position: 1, number_of_laps: 8 }],
    laps: [lap(1, 1, 120), lap(1, 2, 96), lap(1, 3, 95.5), lap(1, 4, 130), lap(1, 5, 128), lap(1, 6, 97, true), lap(1, 7, 96.5), lap(1, 8, 140)],
    pits: [
      { driver_number: 1, lap_number: 5, lane_duration: 21.2, stop_duration: 2.4 },
      { driver_number: 1, lap_number: 2, pit_duration: 24.1 },
      { driver_number: 1, lap_number: 3, lane_duration: 95 },
    ],
  });

  test("stops under a safety car are marked; a minute in the lane isn't a stop", () => {
    expect(race.pits).toEqual([
      { driver: 1, lap: 2, lane: 24.1, stationary: null, neutral: false },
      { driver: 1, lap: 5, lane: 21.2, stationary: 2.4, neutral: true },
    ]);
  });

  test("green laps only: no lap 1, in- or out-laps, neutral laps, or laps over 107% of the median; the fastest lap of the race", () => {
    // Lap 2 and 3 are in-laps (a 95 s "stop" is still one), 4-5 behind the safety car, 6 an out-lap, 8 too slow.
    expect(race.pace).toEqual([{ driver: 1, laps: [96.5] }]);
    expect(race.fastest).toEqual({ driver: 1, lap: 3, time: 95.5 });
  });
});
