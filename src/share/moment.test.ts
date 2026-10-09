// A share card's moment in the session (moment.ts).

import { describe, expect, test } from "bun:test";
import type { DriverInfo, LiveQualiSegment, SessionMeta } from "../types";
import { sessionMoment } from "./moment";

const MIN = 60_000;
const seg = (number: number, start: number, end: number, advance: number | null, stopped: LiveQualiSegment["stopped"] = []): LiveQualiSegment => ({
  number,
  name: `SQ${number}`,
  start,
  end,
  advance,
  length: [12, 10, 8][number - 1] * MIN,
  stopped,
});
const drivers = Array.from({ length: 22 }, (_, i) => ({ number: i + 1 }) as DriverInfo);
// SQ1 0–12 min, SQ2 20–30, SQ3 40–48 (a red flag from 42 to 45, so it ends at 51).
const QUALI = {
  drivers,
  totalLaps: 0,
  chequered: 51 * MIN,
  quali: {},
  qualiLive: { segments: [seg(1, 0, 12 * MIN, 16), seg(2, 20 * MIN, 30 * MIN, 10), seg(3, 40 * MIN, 51 * MIN, null, [{ from: 42 * MIN, to: 45 * MIN }])] },
} as unknown as SessionMeta;
const at = (t: number, leaderLap = 0) => ({ t, raceTime: t, leaderLap });

describe("a share card's moment", () => {
  test("qualifying: the segment and its clock, red flags, the laps after the flag, between segments", () => {
    expect(sessionMoment(QUALI, at(-MIN))).toBeNull();
    expect(sessionMoment(QUALI, at(5 * MIN))).toBe("SQ1 · 7:00 left");
    expect(sessionMoment(QUALI, at(12 * MIN + 30_000))).toBe("SQ1 · after the flag");
    expect(sessionMoment(QUALI, at(15 * MIN))).toBe("After SQ1");
    expect(sessionMoment(QUALI, at(43 * MIN))).toBe("SQ3 · red flag");
    expect(sessionMoment(QUALI, at(51 * MIN - 16_000))).toBe("SQ3 · 0:16 left");
    expect(sessionMoment(QUALI, at(51 * MIN + 30_000))).toBe("SQ3 · after the flag");
    // Over: the card is of the whole session.
    expect(sessionMoment(QUALI, at(55 * MIN))).toBeNull();
  });

  test("practice: the time left, until the flag", () => {
    const practice = { drivers, totalLaps: 0, chequered: 60 * MIN, practice: { scheduledEnd: 60 * MIN } } as unknown as SessionMeta;
    expect(sessionMoment(practice, at(-MIN))).toBeNull();
    expect(sessionMoment(practice, at(47 * MIN + 20_000))).toBe("12:40 left");
    expect(sessionMoment(practice, at(61 * MIN))).toBeNull();
  });

  test("a race: the lap; qualifying stored before it was timed as live: nothing", () => {
    const race = { drivers, totalLaps: 57, chequered: null } as unknown as SessionMeta;
    expect(sessionMoment(race, at(0, 0))).toBeNull();
    expect(sessionMoment(race, at(0, 23))).toBe("Lap 23 of 57");
    expect(sessionMoment({ ...race, quali: {} } as unknown as SessionMeta, at(0, 5))).toBeNull();
  });
});
