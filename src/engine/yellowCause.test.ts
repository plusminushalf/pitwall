// Inferring who caused a sector yellow: synthetic tracks for each rule, then the real 2026 Azerbaijan GP.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { buildSession, type DriverData } from "../data/session";
import type { DriverTelemetry, PitStop, RaceControlMsg, SessionMeta, TrackStatusEvent } from "../types";
import { incidentsOf, yellowCulprits } from "./yellowCause";

// A circular track of 100 outline points and 10 marshal sectors of 10 points each (sector 10 wraps
// past the line). A car at full speed covers one outline point a second: a lap is 100 s.
const N = 100;
const R = 10_000;
const LAP_MS = 100_000;
const LIGHTS_OUT = 10_000;
const END = 1_000_000;
const FAST = 200;

const xy = (p: number) => ({ x: R * Math.cos((2 * Math.PI * p) / N), y: R * Math.sin((2 * Math.PI * p) / N) });

function meta(raceControl: Partial<RaceControlMsg>[], trackStatus: TrackStatusEvent[] = [{ t: 0, status: "GREEN" }]): SessionMeta {
  const outline = Array.from({ length: N }, (_, i) => xy(i));
  return {
    lightsOut: LIGHTS_OUT,
    chequered: END - 50_000,
    duration: END,
    trackStatus,
    raceControl: raceControl.map((m) => ({ lap: 5, category: "Flag", flag: "YELLOW", scope: "Sector", sector: null, driver: null, message: "", t: 0, ...m })),
    track: {
      outline: { x: outline.map((p) => p.x), y: outline.map((p) => p.y), z: outline.map(() => 0) },
      referenceLap: { driver: 1, lap: 3, duration: LAP_MS / 1000 },
      marshalSectors: Array.from({ length: 10 }, (_, k) => ({ number: k + 1, from: k * 10, to: k === 9 ? 0 : (k + 1) * 10 })),
    },
  } as unknown as SessionMeta;
}

const yellow = (t: number, sector: number, extra: Partial<RaceControlMsg> = {}): Partial<RaceControlMsg> => ({
  t,
  sector,
  message: `YELLOW IN TRACK SECTOR ${sector}`,
  ...extra,
});

/** Where the car is (outline index, or null for no location) and how fast it goes, at t. */
type Motion = (t: number) => { p: number | null; v: number };

/** A car lapping at full speed, `offset` outline points ahead of car 1. */
const lapping = (offset = 0): Motion => (t) => ({ p: (t / 1000 + offset) % N, v: FAST });

/** Laps normally, then from `at` stops dead at outline point `p`. */
const stopsAt = (at: number, p: number, offset = 0): Motion => {
  const go = lapping(offset);
  return (t) => (t < at ? go(t) : { p, v: 0 });
};

function car(n: number, motion: Motion, opts: { until?: number; pits?: PitStop[]; retired?: number } = {}): DriverData {
  const ts: number[] = [];
  const x: number[] = [];
  const y: number[] = [];
  const v: number[] = [];
  for (let t = 0; t <= (opts.until ?? END); t += 250) {
    const m = motion(t);
    if (m.p == null) continue;
    const q = xy(m.p);
    ts.push(t);
    x.push(q.x);
    y.push(q.y);
    v.push(m.v);
  }
  const zeros = new Float32Array(ts.length);
  return {
    info: { number: n, acronym: `C${n}`, fullName: "", broadcastName: "", team: "", teamColour: "ffffff", headshotUrl: null },
    loc: { t: Float64Array.from(ts), x: Float32Array.from(x), y: Float32Array.from(y) },
    car: { t: Float64Array.from(ts), speed: Float32Array.from(v), rpm: zeros, gear: new Uint8Array(ts.length), throttle: zeros, brake: zeros, drs: null },
    laps: [],
    lapStarts: new Float64Array(),
    stints: [],
    pits: opts.pits ?? [],
    positions: [],
    positionTimes: new Float64Array(),
    intervals: [],
    intervalTimes: new Float64Array(),
    result: opts.retired != null ? { driver: n, position: null, laps: 0, points: 0, dnf: true, dns: false, dsq: false, duration: null, gapToLeader: null, finish: null, retired: opts.retired } : null,
    gridPosition: n,
  };
}

const field = (...cars: DriverData[]) => new Map(cars.map((d) => [d.info.number, d]));

/** Culprits of raceControl[0]. */
const first = (m: SessionMeta, drivers: Map<number, DriverData>) => yellowCulprits(m, drivers).get(0);

// Car 1 (offset 0) reaches outline point 45 (sector 5) 45 s into each lap: t = 345 s on the 4th lap.
const T = 350_000;

describe("who caused a yellow", () => {
  test("a car that stops in the flagged sector", () => {
    const m = meta([yellow(T, 5)]);
    expect(first(m, field(car(1, stopsAt(345_000, 45), { retired: 345_000 }), car(2, lapping(30)), car(3, lapping(60))))).toEqual([1]);
  });

  test("a car that stops in the sector next to the flagged one", () => {
    const m = meta([yellow(T, 6)]);
    expect(first(m, field(car(1, stopsAt(345_000, 45)), car(2, lapping(30))))).toEqual([1]);
  });

  test("a car crawling where it went flat out a lap earlier", () => {
    const crawl: Motion = (t) => (t >= 340_000 && t < 352_000 ? { p: 40 + (t - 340_000) / 4_000, v: 30 } : lapping()(t < 340_000 ? t : t - 9_000));
    const m = meta([yellow(T, 4)]);
    expect(first(m, field(car(1, crawl), car(2, lapping(30))))).toEqual([1]);
  });

  test("not a car that is always slow at that spot (a hairpin)", () => {
    const hairpin: Motion = (t) => {
      const p = (t / 1000) % N;
      return { p, v: p >= 40 && p < 50 ? 40 : FAST };
    };
    expect(first(meta([yellow(T, 5)]), field(car(1, hairpin), car(2, lapping(30))))).toBeUndefined();
  });

  test("OpenF1's same-second pair of sectors is one incident with the same culprit", () => {
    const m = meta([yellow(T, 5), yellow(T, 4), yellow(T + 20_000, 5, { flag: "DOUBLE YELLOW" })]);
    const got = yellowCulprits(m, field(car(1, stopsAt(345_000, 45)), car(2, lapping(30))));
    expect(incidentsOf(m)).toHaveLength(1);
    expect([got.get(0), got.get(1), got.get(2)]).toEqual([[1], [1], [1]]);
  });

  test("two cars stopped together are both named", () => {
    const m = meta([yellow(T, 5)]);
    expect(first(m, field(car(1, stopsAt(345_000, 45)), car(2, stopsAt(346_000, 46, 1)), car(3, lapping(30))))).toEqual([1, 2]);
  });

  test("cars merely slowed next to a stopped one are left out", () => {
    const avoid: Motion = (t) => (t >= 344_000 && t < 350_000 ? { p: 44 + (t - 344_000) / 3_000, v: 30 } : lapping(1)(t < 344_000 ? t : t - 4_000));
    const m = meta([yellow(T, 5)]);
    expect(first(m, field(car(1, stopsAt(345_000, 45)), car(2, avoid)))).toEqual([1]);
  });

  test("too many slow cars to tell: nobody", () => {
    const slowIn5 = (offset: number): Motion => (t) => {
      const p = (t / 1000 + offset) % N;
      return { p, v: t > 330_000 && t < 360_000 && p >= 40 && p < 50 ? 30 : FAST };
    };
    const m = meta([yellow(T, 5)]);
    expect(first(m, field(car(1, slowIn5(0)), car(2, slowIn5(2)), car(3, slowIn5(4))))).toBeUndefined();
  });

  test("a message that names a driver keeps it", () => {
    const m = meta([yellow(T, 5, { driver: 2 })]);
    expect(first(m, field(car(1, stopsAt(345_000, 45)), car(2, lapping(30))))).toBeUndefined();
  });

  describe("false positives", () => {
    test("a car that retired long before the flag", () => {
      // Out since 280 s, and still reporting: recovered on a truck at walking pace through sector 5.
      const recovered: Motion = (t) => (t < 280_000 ? lapping()(t) : { p: 40 + ((t - 280_000) / 60_000) % 10, v: 15 });
      const m = meta([yellow(T, 5)]);
      expect(first(m, field(car(1, recovered, { retired: 280_000 }), car(2, lapping(30))))).toBeUndefined();
      expect(first(m, field(car(1, recovered), car(2, lapping(30))))).toEqual([1]);
    });

    test("a car stationary for over a minute before the flag", () => {
      const m = meta([yellow(T, 5)]);
      expect(first(m, field(car(1, stopsAt(250_000, 45)), car(2, lapping(30))))).toBeUndefined();
    });

    test("a car in the pit lane", () => {
      // Car 1 sits in its box beside sector 1 (the pit lane runs along the start/finish straight).
      const pits = [{ driver: 1, lap: 4, entry: 295_000, exit: 320_000, laneDuration: 25, stopDuration: 2 }];
      const inPits: Motion = (t) => (t >= 297_000 && t < 305_000 ? { p: 3, v: 0 } : lapping()(t));
      const m = meta([yellow(305_000, 1)]);
      expect(first(m, field(car(1, inPits, { pits }), car(2, lapping(30))))).toBeUndefined();
    });

    test("under the safety car only a stopped car counts", () => {
      const sc: TrackStatusEvent[] = [
        { t: 0, status: "GREEN" },
        { t: 300_000, status: "SC" },
      ];
      const crawl: Motion = (t) => (t >= 340_000 && t < 352_000 ? { p: 40 + (t - 340_000) / 4_000, v: 40 } : lapping()(t < 340_000 ? t : t - 9_000));
      expect(first(meta([yellow(T, 4)], sc), field(car(1, crawl), car(2, lapping(30))))).toBeUndefined();
      expect(first(meta([yellow(T, 5)], sc), field(car(1, stopsAt(345_000, 45)), car(2, lapping(30))))).toEqual([1]);
    });

    test("not before the start or after the chequered flag", () => {
      const grid: Motion = (t) => (t < LIGHTS_OUT ? { p: 45, v: 0 } : lapping(45)(t - LIGHTS_OUT));
      expect(first(meta([yellow(LIGHTS_OUT - 2_000, 5)]), field(car(1, grid), car(2, lapping(30))))).toBeUndefined();
      const late = END - 40_000;
      expect(first(meta([yellow(late, 5)]), field(car(1, stopsAt(late - 5_000, 45)), car(2, lapping(30))))).toBeUndefined();
    });

    test("a car still parked from an earlier incident is not the new one's cause", () => {
      // Car 1 stops in sector 5; 30 s later sector 6 goes yellow and car 2 crawls through it.
      const crawl: Motion = (t) => (t >= 370_000 && t < 382_000 ? { p: 50 + (t - 370_000) / 4_000, v: 30 } : lapping(-20)(t < 370_000 ? t : t - 9_000));
      const m = meta([yellow(T, 5), { t: T + 10_000, sector: 5, flag: "CLEAR" }, yellow(T + 30_000, 6)]);
      const got = yellowCulprits(m, field(car(1, stopsAt(345_000, 45)), car(2, crawl)));
      expect(got.get(0)).toEqual([1]);
      expect(got.get(2)).toEqual([2]);
    });

    test("...but is when nothing else explains the flags spreading next to it", () => {
      const m = meta([yellow(T, 5), { t: T + 10_000, sector: 5, flag: "CLEAR" }, yellow(T + 30_000, 6)]);
      const got = yellowCulprits(m, field(car(1, stopsAt(345_000, 45)), car(2, lapping(30))));
      expect(got.get(2)).toEqual([1]);
    });
  });

  test("live: no answer until telemetry covers the window", () => {
    const m = meta([yellow(T, 5)]);
    expect(first(m, field(car(1, stopsAt(345_000, 45), { until: T + 2_000 }), car(2, lapping(30), { until: T + 2_000 })))).toBeUndefined();
    expect(first(m, field(car(1, stopsAt(345_000, 45), { until: T + 6_000 }), car(2, lapping(30), { until: T + 6_000 })))).toEqual([1]);
  });
});

// ---------------------------------------------------------------- the real thing

const dir = new URL("../../data/sessions/11377/", import.meta.url).pathname;
const available = existsSync(`${dir}meta.json`);

describe.skipIf(!available)("Baku 2026 yellows", () => {
  const meta: SessionMeta = available ? JSON.parse(readFileSync(`${dir}meta.json`, "utf8")) : (null as unknown as SessionMeta);
  const telemetry: DriverTelemetry[] = available ? meta.drivers.map((d) => JSON.parse(readFileSync(`${dir}drivers/${d.number}.json`, "utf8"))) : [];
  const s = available ? buildSession(meta, telemetry) : null!;
  const byNumber = new Map(meta?.drivers.map((d) => [d.number, d.acronym]));
  /** Acronyms named on the feed's sector yellows of `lap`, by message. */
  const named = (lap: number) =>
    s.feed
      .filter((f) => f.kind === "flag" && f.text.includes("TRACK SECTOR") && meta.raceControl.some((m) => m.t === f.t && m.lap === lap))
      .map((f) => (f.inferred ?? []).map((n) => byNumber.get(n)).join("+"));

  test("the cars that stopped or went off", () => {
    expect(named(9)).toEqual(["STR", "STR"]);
    expect(named(30)).toEqual(["NOR", "NOR"]);
    expect(named(31)).toEqual(["ALB", "ALB"]);
    expect(named(51).slice(0, 2)).toEqual(["BOT", "BOT"]);
  });

  test("lap 36: the turn 1 crash, then GAS limping on to sector 4", () => {
    const [a, b, ...rest] = named(36);
    expect(a).toBe(b);
    for (const n of ["NOR", "GAS", "COL"]) expect(a.split("+")).toContain(n);
    expect(rest).toEqual(["GAS", "GAS", "GAS"]);
  });

  test("nobody under the safety car without a stopped car, nor after the flag", () => {
    expect(named(32).every((x) => x === "")).toBe(true);
    expect(named(33).every((x) => x === "")).toBe(true);
    const after = s.feed.filter((f) => f.inferred && f.t > meta.chequered!);
    expect(after).toEqual([]);
  });
});
