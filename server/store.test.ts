// Live store: merging document versions, deduplicating samples, and streaming telemetry
// as append-only chunks that add up to the full picture.

import { describe, expect, test } from "bun:test";
import type { RawSession } from "../scripts/openf1";
import type { DriverTelemetry } from "../src/types";
import { inLiveWindow, isRaceSession } from "./openf1Source";
import { LiveSession, LiveStore } from "./store";

const start = Date.parse("2026-10-04T08:00:00Z");
const session: RawSession = {
  session_key: 99,
  meeting_key: 9,
  session_name: "Race",
  session_type: "Race",
  date_start: new Date(start).toISOString(),
  date_end: new Date(start + 2 * 3600_000).toISOString(),
  year: 2026,
  circuit_short_name: "Test",
  country_name: "Testland",
  location: "Testville",
  gmt_offset: "00:00:00",
};
const at = (s: number) => new Date(start + s * 1000).toISOString();

function store(clockS: { now: number }) {
  return new LiveStore({ session, meeting: null, circuit: null, t0: start - 600_000, clock: () => start + clockS.now * 1000 });
}

const driver = { driver_number: 1, name_acronym: "TST", full_name: "Test Driver", broadcast_name: "T DRIVER", team_name: "Team", team_colour: "ff0000", headshot_url: null, session_key: 99 };

describe("LiveStore", () => {
  test("a newer version of a document replaces the older one; samples are deduplicated", () => {
    const s = store({ now: 100 });
    const lap = { driver_number: 1, lap_number: 1, date_start: at(0), lap_duration: null, duration_sector_1: null, session_key: 99 };
    s.ingest("laps", { ...lap, _key: "a", _id: 1 });
    s.ingest("laps", { ...lap, duration_sector_1: 30.1, _key: "a", _id: 2 });
    s.ingest("position", { driver_number: 1, position: 3, date: at(1), session_key: 99 });
    s.ingest("position", { driver_number: 1, position: 3, date: "2026-10-04T08:00:01.000000+00:00", session_key: 99 });
    s.ingest("car_data", { driver_number: 1, date: at(2), speed: 100, rpm: 1, n_gear: 1, throttle: 50, brake: 0, drs: null, session_key: 99 });
    s.ingest("car_data", { driver_number: 1, date: at(2), speed: 100, rpm: 1, n_gear: 1, throttle: 50, brake: 0, drs: null, session_key: 99 });
    expect(s.list<{ duration_sector_1: number }>("laps")).toHaveLength(1);
    expect(s.list<{ duration_sector_1: number }>("laps")[0].duration_sector_1).toBe(30.1);
    expect(s.count("position")).toBe(1);
    expect(s.count("car_data")).toBe(1);
    expect(s.latestDataTime).toBe(start + 2000);
  });

  test("records of other sessions are ignored", () => {
    const s = store({ now: 0 });
    expect(s.ingest("drivers", { ...driver, session_key: 1 })).toBe(false);
    expect(s.count("drivers")).toBe(0);
  });

  test("the live edge follows the data, but doesn't freeze when it stops", () => {
    const clock = { now: 10 };
    const s = store(clock);
    s.ingest("location", { driver_number: 1, date: at(7), x: 1, y: 1, z: 0, session_key: 99 });
    expect(s.now()).toBe(start + 7000);
    clock.now = 60;
    expect(s.now()).toBe(start + 45_000); // 15 s behind the clock
  });
});

describe("LiveSession telemetry", () => {
  test("snapshot + tel chunks = everything, without overlaps", () => {
    const clock = { now: 0 };
    const s = store(clock);
    s.ingest("drivers", driver);
    const feed = (from: number, to: number) => {
      for (let t = from; t < to; t += 0.25) {
        s.ingest("car_data", { driver_number: 1, date: at(t), speed: 200, rpm: 11000, n_gear: 7, throttle: 100, brake: 0, drs: null, session_key: 99 });
        s.ingest("location", { driver_number: 1, date: at(t + 0.1), x: Math.round(t * 100), y: 5, z: 0, session_key: 99 });
      }
      clock.now = to;
    };
    const live = new LiveSession(s);
    feed(0, 5);
    live.recompute();
    live.markAllSent();
    const snap = live.snapshot()!;
    expect(snap.type).toBe("snapshot");
    expect(snap.now).toBe(snap.meta.duration);

    const chunks: DriverTelemetry[] = [];
    for (let k = 0; k < 4; k++) {
      feed(5 + k, 6 + k);
      live.recompute();
      chunks.push(...live.telemetryChunks());
    }
    expect(live.telemetryChunks()).toEqual([]); // nothing new

    const decode = (t: number[]) => t.reduce<number[]>((out, d, i) => (out.push(i ? out[i - 1] + d : d), out), []);
    const locTimes = [snap.telemetry[0], ...chunks].flatMap((c) => decode(c.loc.t));
    const carTimes = [snap.telemetry[0], ...chunks].flatMap((c) => decode(c.car.t));
    for (let i = 1; i < locTimes.length; i++) expect(locTimes[i]).toBeGreaterThan(locTimes[i - 1]);
    expect(carTimes).toHaveLength(9 * 4);
    expect(locTimes).toHaveLength(9 * 4); // the live edge is the latest sample, location included
    expect(chunks[0].car.t[0]).toBe(600_000 + 5000); // chunk t[0] is absolute
  });
});

describe("LiveSession quick ticks", () => {
  test("stream new samples between recomputes; hold location across a gap until the next one", () => {
    const clock = { now: 0 };
    const s = store(clock);
    s.ingest("drivers", driver);
    const car = (t: number) =>
      s.ingest("car_data", { driver_number: 1, date: at(t), speed: 200, rpm: 11000, n_gear: 7, throttle: 100, brake: 0, drs: null, session_key: 99 });
    const loc = (t: number) => s.ingest("location", { driver_number: 1, date: at(t), x: Math.round(t * 100), y: 5, z: 0, session_key: 99 });
    for (let t = 0; t < 5; t += 0.25) (car(t), loc(t + 0.1));
    clock.now = 5;
    const live = new LiveSession(s);
    live.recompute();
    live.markAllSent();
    const snap = live.snapshot()!;
    const end = (t: number[]) => t.reduce((a, d, i) => (i ? a + d : d), 0);
    const lastLoc = end(snap.telemetry[0].loc.t);

    clock.now = 6;
    for (let t = 5; t < 6; t += 0.25) (car(t), loc(t + 0.1));
    const q1 = live.quickChunks();
    expect(q1).toHaveLength(1);
    expect(q1[0].car.t).toHaveLength(4);
    expect(q1[0].loc.t[0]).toBeGreaterThan(lastLoc);
    expect(live.quickChunks()).toEqual([]);

    // Location drops out for 5 s while car data continues: the fix after the gap waits.
    clock.now = 11.2;
    for (let t = 6; t < 11; t += 0.25) car(t);
    loc(11.1);
    car(11);
    const q2 = live.quickChunks();
    expect(q2[0].car.t).toHaveLength(21);
    expect(q2[0].loc.t).toHaveLength(0);
    live.recompute();
    const full = live.telemetryChunks();
    expect(full[0].loc.t).toEqual([600_000 + 11_100]);
    expect(full[0].car.t).toHaveLength(0);
  });
});

describe("OpenF1 live window", () => {
  test("races and sprints from 15 min before to 30 min after", () => {
    expect(isRaceSession(session)).toBe(true);
    expect(isRaceSession({ ...session, session_type: "Qualifying" })).toBe(false);
    expect(inLiveWindow(session, start - 16 * 60_000)).toBe(false);
    expect(inLiveWindow(session, start - 14 * 60_000)).toBe(true);
    expect(inLiveWindow(session, start + 2.4 * 3600_000)).toBe(true);
    expect(inLiveWindow(session, start + 2.6 * 3600_000)).toBe(false);
  });
});
