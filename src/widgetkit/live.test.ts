// Live sessions are rebuilt as data arrives (withMeta): what widgets see must keep its identity.

import { describe, expect, test } from "bun:test";
import { buildSession, withMeta } from "../data/session";
import type { DriverTelemetry, SessionMeta } from "../types";
import { feedEndAt, feedUpTo, heightInputOf } from "./select";

const rc = (t: number, message: string) => ({ t, lap: 1, category: "Other", flag: null, scope: null, sector: null, driver: null, message });

function meta(messages: ReturnType<typeof rc>[], duration = 100_000): SessionMeta {
  return {
    sessionKey: 1,
    meetingName: "Test",
    sessionName: "Race",
    year: 2026,
    circuit: "Test",
    country: "Test",
    gmtOffset: "00:00:00",
    t0: "2026-01-01T00:00:00Z",
    duration,
    lightsOut: 0,
    totalLaps: 10,
    drivers: [{ number: 1, acronym: "ONE", fullName: "Driver One", broadcastName: "D ONE", team: "Team", teamColour: "ffffff", headshotUrl: null }],
    grid: [],
    laps: [],
    stints: [],
    pits: [],
    positions: [],
    intervals: [],
    trackStatus: [],
    raceControl: messages,
    weather: [],
    radio: [],
    overtakes: [],
    results: [],
    track: { outline: { x: [0, 1, 1], y: [0, 0, 1], z: [0, 0, 0] }, pitLane: null, sectorMarks: [], bounds: { minX: 0, maxX: 1, minY: 0, maxY: 1 }, referenceLap: { driver: 0, lap: 0, duration: 0 }, rotation: 0, corners: [], marshalSectors: [], pitLoss: null },
  } as unknown as SessionMeta;
}

const telemetry: DriverTelemetry[] = [{ driver: 1, loc: { t: [0], x: [0], y: [0], z: [0] }, car: { t: [0], speed: [0], rpm: [0], gear: [0], throttle: [0], brake: [0] } }];

describe("live rebuilds", () => {
  const first = buildSession(meta([rc(10_000, "A"), rc(20_000, "B")]), telemetry);
  const visible = (s: ReturnType<typeof buildSession>, t: number) => feedUpTo(s, feedEndAt(s, t));

  test("height inputs stay the same object while they don't change", () => {
    const a = heightInputOf(first);
    const rebuilt = withMeta(first, meta([rc(10_000, "A"), rc(20_000, "B")], 120_000));
    expect(rebuilt).not.toBe(first);
    expect(heightInputOf(rebuilt)).toBe(a);
  });

  test("feed entries keep identity and id across a rebuild; new items get new ids", () => {
    const before = visible(first, 50_000);
    const rebuilt = withMeta(first, meta([rc(10_000, "A"), rc(15_000, "NEW"), rc(20_000, "B")], 120_000));
    const after = visible(rebuilt, 50_000);
    expect(after.length).toBe(3);
    expect(after[0]).toBe(before[0]); // B
    expect(after[2]).toBe(before[1]); // A
    expect(after[1].text).toBe("NEW");
    expect(new Set(after.map((e) => e.id)).size).toBe(3);
    // An unchanged visible feed is element-for-element the same list (so useFeed doesn't re-render).
    const again = withMeta(rebuilt, meta([rc(10_000, "A"), rc(15_000, "NEW"), rc(20_000, "B"), rc(90_000, "LATER")], 130_000));
    expect(visible(again, 50_000)).toEqual(after);
    visible(again, 50_000).forEach((e, i) => expect(e).toBe(after[i]));
  });
});
