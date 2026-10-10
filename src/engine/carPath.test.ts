// Car paths (carPath.ts): motion rules on synthetic drives, live appends, and a real race if it's ingested
// (run `bun run ingest 11377` first).

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { buildSession, type CarSeries, type DriverData } from "../data/session";
import type { DriverTelemetry, SessionMeta } from "../types";
import { carPathOf, carPathPosition } from "./carPath";
import { carPositionAt } from "./raceState";

// ---------------------------------------------------------------- synthetic drives
// Units as in the data: position in dm, time in ms, speed in km/h.

interface Drive {
  /** Distance driven (dm) at t. */
  dist: (t: number) => number;
  /** Speed (km/h) at t. */
  speed: (t: number) => number;
  /** Position of a point `s` dm along the line. */
  at: (s: number) => [number, number];
}

/** Along the x axis at a constant speed. */
const straight = (kmh: number): Drive => ({ dist: (t) => (kmh * t) / 360, speed: () => kmh, at: (s) => [s, 0] });

/** Round a circle of radius r (dm) at a constant speed. */
const circle = (kmh: number, r: number): Drive => ({
  dist: (t) => (kmh * t) / 360,
  speed: () => kmh,
  at: (s) => [r * Math.sin(s / r), r - r * Math.cos(s / r)],
});

/** Deterministic pseudo-random numbers in [0, 1). */
function rng(seed: number) {
  let x = seed;
  return () => ((x = (x * 1_103_515_245 + 12_345) % 2_147_483_648) / 2_147_483_648);
}

interface Options {
  from?: number;
  to?: number;
  /** Fraction of samples stamped `early` ms before they were taken (the OpenF1 jitter). */
  earlyFrac?: number;
  early?: number;
  /** Replace a sample's position, e.g. a glitch. */
  edit?: (i: number, t: number, p: [number, number]) => [number, number] | null;
  /** Car samples to leave out / speeds to override. */
  carEdit?: (t: number, v: number) => number | null;
  /** Pit-lane entry times (ms) of the driver's stops. */
  pitEntries?: number[];
}

function drive(d: Drive, o: Options = {}): DriverData {
  const from = o.from ?? 0;
  const to = o.to ?? 120_000;
  const r = rng(7);
  const lt: number[] = [];
  const lx: number[] = [];
  const ly: number[] = [];
  let i = 0;
  for (let t = from; t <= to; t += 180 + Math.round(r() * 160), i++) {
    const stamp = r() < (o.earlyFrac ?? 0) ? t - (o.early ?? 0) : t;
    const p = o.edit ? o.edit(i, t, d.at(d.dist(t))) : d.at(d.dist(t));
    if (!p || stamp <= (lt.at(-1) ?? -Infinity)) continue;
    lt.push(stamp);
    lx.push(p[0]);
    ly.push(p[1]);
  }
  const ct: number[] = [];
  const cv: number[] = [];
  for (let t = from; t <= to + 1_000; t += 240 + Math.round(r() * 40)) {
    const v = o.carEdit ? o.carEdit(t, d.speed(t)) : d.speed(t);
    if (v == null) continue;
    ct.push(t);
    cv.push(v);
  }
  const n = ct.length;
  const car: CarSeries = {
    t: Float64Array.from(ct),
    speed: Float32Array.from(cv),
    rpm: new Float32Array(n),
    gear: new Uint8Array(n),
    throttle: new Float32Array(n),
    brake: new Float32Array(n),
    drs: null,
  };
  return {
    loc: { t: Float64Array.from(lt), x: Float32Array.from(lx), y: Float32Array.from(ly) },
    car,
    pits: (o.pitEntries ?? []).map((entry, k) => ({ driver: 1, lap: k + 1, entry, exit: entry + 20_000, laneDuration: 20, stopDuration: null })),
    result: null,
  } as unknown as DriverData;
}

/** Frames at 60 Hz over [a, b]: positions (null where there's none). */
function frames(d: DriverData, a: number, b: number) {
  const out: { t: number; p: { x: number; y: number } | null }[] = [];
  for (let t = a; t <= b; t += 1000 / 60) out.push({ t, p: carPositionAt(d, t) });
  return out;
}

/** Frame speeds (km/h) between consecutive non-null frames. */
function speeds(f: ReturnType<typeof frames>) {
  const v: number[] = [];
  for (let k = 1; k < f.length; k++) {
    const a = f[k - 1].p;
    const b = f[k].p;
    if (a && b) v.push((Math.hypot(b.x - a.x, b.y - a.y) / (f[k].t - f[k - 1].t)) * 360);
  }
  return v;
}

const cv = (v: number[]) => {
  const mean = v.reduce((s, x) => s + x, 0) / v.length;
  return Math.sqrt(v.reduce((s, x) => s + (x - mean) ** 2, 0) / v.length) / mean;
};

/** Stamps of the path's relocations (entries flagged BREAK). */
const breaks = (p: ReturnType<typeof carPathOf>) => {
  const out: number[] = [];
  for (let q = 0; q < p.m; q++) if (p.FL[q] & 4) out.push(p.T[q]);
  return out;
};

/** Largest backward step (dm, positive = backwards) along +x. */
const worstBackwardX = (f: ReturnType<typeof frames>) => {
  let worst = 0;
  for (let k = 1; k < f.length; k++) {
    const a = f[k - 1].p;
    const b = f[k].p;
    if (a && b) worst = Math.max(worst, a.x - b.x);
  }
  return worst;
};

// ---------------------------------------------------------------- motion rules

describe("car paths: motion", () => {
  test("jittered stamps: the dot moves at telemetry speed (a spline through the stamps surges and stalls)", () => {
    const d = drive(straight(250), { earlyFrac: 0.25, early: 120 });
    const v = speeds(frames(d, 20_000, 100_000)).sort((a, b) => a - b);
    const pct = (f: number) => v[Math.floor(f * v.length)] / 250;
    expect(cv(v)).toBeLessThan(0.03);
    expect(pct(0.01)).toBeGreaterThan(0.9);
    expect(pct(0.99)).toBeLessThan(1.1);
    // The old way, a uniform Catmull-Rom through each sample at its stamp:
    const { t, x } = d.loc;
    const old: number[] = [];
    for (let i = 200; i < t.length - 200; i++) {
      const dx = (x[i + 1] - x[i - 1]) / 2; // its speed at the samples, roughly
      old.push((dx / ((t[i + 1] - t[i - 1]) / 2)) * 360);
    }
    expect(cv(old)).toBeGreaterThan(0.1);
  });

  test("on a curve it stays on the racing line", () => {
    const r = 1_500; // 150 m
    const d = drive(circle(160, r), { earlyFrac: 0.25, early: 120 });
    for (const { p } of frames(d, 10_000, 60_000)) {
      expect(p).not.toBeNull();
      expect(Math.abs(Math.hypot(p!.x, p!.y - r) - r)).toBeLessThan(5); // 0.5 m
    }
  });

  test("never backwards, through a forward spike, a burst of stale samples and a stale repeat", () => {
    const seen: [number, number][] = [];
    const d = drive(straight(200), {
      earlyFrac: 0.25,
      early: 120,
      edit: (i, _t, p) => {
        seen[i] = p;
        // 50 m ahead; 4 samples 90 m behind; sample 301 repeats 299's position (the car drove on).
        return i === 100 ? [p[0] + 500, p[1]] : i >= 200 && i < 204 ? [p[0] - 900, p[1] + 50] : i === 301 ? seen[299] : p;
      },
    });
    const f = frames(d, 5_000, 110_000);
    expect(worstBackwardX(f)).toBeLessThan(0.1); // 1 cm
    // ...and the glitches aren't on the path: it's never far off the drive.
    for (const { t, p } of f) if (p) expect(Math.abs(p.x - (200 * t) / 360)).toBeLessThan(250);
  });

  test("a stationary car doesn't creep over the location noise", () => {
    // 60 km/h, stopped (speed 0) from 20 s to 40 s, location noise of +-0.3 m.
    const dist = (t: number) => (t < 20_000 ? t : t < 40_000 ? 20_000 : t - 20_000) * (60 / 360);
    const noise = rng(3);
    const d = drive(
      { dist, speed: (t) => (t >= 20_000 && t < 40_000 ? 0 : 60), at: (s) => [s, 0] },
      { edit: (_i, t, p) => (t > 20_000 && t < 40_000 ? [p[0] + (noise() - 0.5) * 6, p[1] + (noise() - 0.5) * 6] : p) },
    );
    const f = frames(d, 21_000, 39_000);
    const first = f[0].p!;
    for (const { p } of f) expect(Math.hypot(p!.x - first.x, p!.y - first.y)).toBe(0);
    // and it's where the car stopped
    expect(Math.abs(first.x - dist(30_000))).toBeLessThan(15);
  });

  test("a standing start: still until the speed trace moves, then on the samples", () => {
    const go = 30_000;
    const a = 12; // m/s^2
    const dist = (t: number) => (t < go ? 0 : 10 * 0.5 * a * ((t - go) / 1000) ** 2); // dm
    const d = drive({ dist, speed: (t) => (t < go ? 0 : a * ((t - go) / 1000) * 3.6), at: (s) => [s, 0] }, { to: 40_000 });
    const before = frames(d, 5_000, go);
    for (const { p } of before) expect(p!.x).toBe(before[0].p!.x);
    for (const { t, p } of frames(d, go, 39_000)) expect(Math.abs(p!.x - dist(t))).toBeLessThan(30); // 3 m
    expect(worstBackwardX(frames(d, 5_000, 39_000))).toBe(0);
  });

  test("telemetry dropouts: the dot follows the samples", () => {
    // Speed reported as 0 from 30 s to 40 s while driving on, then no car samples from 60 s to 70 s.
    const d = drive(straight(180), {
      carEdit: (t, v) => (t >= 30_000 && t < 40_000 ? 0 : t >= 60_000 && t < 70_000 ? null : v),
    });
    for (const [a, b] of [
      [31_000, 39_000],
      [61_000, 69_000],
    ]) {
      const f = frames(d, a, b);
      for (const { t, p } of f) expect(Math.abs(p!.x - (180 * t) / 360)).toBeLessThan(30);
      expect(Math.min(...speeds(f))).toBeGreaterThan(180 * 0.4);
    }
  });

  test("location gaps of 0.7-1.3 s: speed stays with the telemetry", () => {
    // Every 10th interval stretched to ~1.1 s (samples in between dropped).
    const d = drive(straight(290), { edit: (i, _t, p) => (i % 12 >= 8 && i % 12 < 11 ? null : p) });
    const v = speeds(frames(d, 10_000, 100_000));
    expect(Math.min(...v)).toBeGreaterThan(290 * 0.9);
    expect(Math.max(...v)).toBeLessThan(290 * 1.1);
  });

  test("a relocation (pit-lane coordinates) stays a jump", () => {
    // From 50 s on the samples are 200 m to the side, and stay there.
    const d = drive(straight(80), { edit: (_i, t, p) => (t >= 50_000 ? [p[0], p[1] + 2_000] : p) });
    // Before: on the old line; within a second after: on the new one.
    for (const { p } of frames(d, 40_000, 49_000)) expect(Math.abs(p!.y)).toBeLessThan(10);
    for (const { p } of frames(d, 51_500, 60_000)) expect(Math.abs(p!.y - 2_000)).toBeLessThan(10);
  });

  test("pit entry: a run of samples at the wrong distance along the lane is dropped (replays)", () => {
    // Pit entry at 60 s; from 55 s to 58.5 s the feed puts the car 60 m further along, then corrects it.
    const edit = (_i: number, t: number, p: [number, number]): [number, number] => (t >= 55_000 && t < 58_500 ? [p[0] + 600, p[1]] : p);
    const o = { edit };
    const d = drive(straight(100), { ...o, pitEntries: [60_000] });
    const p = carPathOf(d);
    expect(breaks(p)).toEqual([]);
    for (let q = 0; q < p.m; q++) expect(p.T[q] >= 55_000 && p.T[q] < 58_500).toBe(false);
    const f = frames(d, 50_000, 65_000);
    for (const { t, p } of f) expect(Math.abs(p!.x - (100 * t) / 360)).toBeLessThan(30); // 3 m
    expect(Math.max(...speeds(f))).toBeLessThan(110);
    // Without the stop it's taken for a relocation there and back (the dot slides 60 m each way).
    expect(breaks(carPathOf(drive(straight(100), o))).length).toBeGreaterThan(0);
  });

  test("a relocation stays a jump outside and inside a pit-entry window", () => {
    // From 50 s on the samples are 200 m to the side, and stay there; the stop's entry 50 s later / 3 s later.
    const edit = (_i: number, t: number, p: [number, number]): [number, number] => (t >= 50_000 ? [p[0], p[1] + 2_000] : p);
    for (const entry of [100_000, 53_000]) {
      const d = drive(straight(80), { edit, pitEntries: [entry] });
      const first = d.loc.t.find((t) => t >= 50_000)!;
      expect(breaks(carPathOf(d))).toEqual([first]);
      for (const { p } of frames(d, 40_000, 49_000)) expect(Math.abs(p!.y)).toBeLessThan(10);
      for (const { p } of frames(d, 51_500, 60_000)) expect(Math.abs(p!.y - 2_000)).toBeLessThan(10);
    }
  });

  test("null before the first sample and after the last; parked at the end once finished", () => {
    const d = drive(straight(200), { from: 10_000, to: 60_000 });
    const last = d.loc.t[d.loc.t.length - 1];
    expect(carPositionAt(d, 9_000)).toBeNull();
    expect(carPositionAt(d, last + 1_000)).toBeNull();
    const finished = { ...d, result: { finish: last - 5_000 } } as unknown as DriverData;
    expect(carPositionAt(finished, last + 60_000)).not.toBeNull();
    expect(carPositionAt(finished, last + 60_000)).toEqual(carPositionAt(finished, last + 1_000));
  });
});

// ---------------------------------------------------------------- caching and live appends

describe("car paths: caching and live appends", () => {
  test("computed once per data version, shared by drivers built on the same arrays", () => {
    const d = drive(straight(200));
    const p = carPathOf(d);
    expect(carPathOf(d)).toBe(p);
    expect(carPathOf({ ...d } as DriverData)).toBe(p); // a live meta update rebuilds the driver, same arrays
  });

  test("appending samples never moves a car that's been shown, and ends where one build would", () => {
    const full = drive(circle(220, 3_000), { earlyFrac: 0.25, early: 120, to: 90_000 });
    const L = full.loc;
    const C = full.car;
    const upTo = (end: number) => {
      const nl = L.t.findLastIndex((t) => t <= end) + 1;
      const nc = C.t.findLastIndex((t) => t <= end) + 1;
      const sub = <T extends Float64Array | Float32Array | Uint8Array>(a: T, n: number) => a.subarray(0, n) as T;
      return {
        loc: { t: sub(L.t, nl), x: sub(L.x, nl), y: sub(L.y, nl) },
        car: { ...C, t: sub(C.t, nc), speed: sub(C.speed, nc), brake: sub(C.brake, nc) },
      };
    };
    const d = { ...full, ...upTo(10_000) } as DriverData;
    const p = carPathOf(d, true);
    let moved = 0;
    let shown = 0;
    for (let end = 10_000; end < 90_000; end += 500 + (end % 1_700)) {
      const probe: number[] = [];
      for (let t = end - 6_000; t <= end; t += 20) probe.push(t);
      const before = probe.map((t) => carPathPosition(d, t, false));
      Object.assign(d, upTo(end + 500 + (end % 1_700)));
      expect(carPathOf(d)).toBe(p); // extended in place
      probe.forEach((t, k) => {
        const b = before[k];
        const a = carPathPosition(d, t, false);
        if (!b || !a) return;
        shown++;
        moved = Math.max(moved, Math.hypot(a.x - b.x, a.y - b.y));
      });
    }
    expect(shown).toBeGreaterThan(10_000);
    expect(moved).toBeLessThan(1); // 0.1 m
    const once = carPathOf({ ...full, loc: { ...L, t: L.t.slice() } } as DriverData, true);
    const grown = carPathOf(d);
    expect(grown.m).toBe(once.m);
    expect(Array.from(grown.OFF.subarray(0, grown.m))).toEqual(Array.from(once.OFF.subarray(0, once.m)));
    expect(Array.from(grown.S.subarray(0, grown.m))).toEqual(Array.from(once.S.subarray(0, once.m)));
  });
});

// ---------------------------------------------------------------- a real race

const dir = new URL("../../data/sessions/11377/", import.meta.url).pathname;
const available = existsSync(`${dir}meta.json`);

describe.skipIf(!available)("car paths: Baku 2026", () => {
  const meta: SessionMeta = available ? JSON.parse(readFileSync(`${dir}meta.json`, "utf8")) : (null as unknown as SessionMeta);
  const telemetry: DriverTelemetry[] = available
    ? meta.drivers.map((d) => JSON.parse(readFileSync(`${dir}drivers/${d.number}.json`, "utf8")))
    : [];
  const s = available ? buildSession(meta, telemetry) : null;

  test("flat out down the main straight, the dot's speed follows the speed trace", () => {
    const d = s!.drivers.get(63)!;
    const cvs: number[] = [];
    for (let a = 450_000; a < 600_000; a += 1_000) {
      const v = speeds(frames(d, a, a + 1_000));
      const tel = [a, a + 500, a + 1_000].map((t) => d.car.speed[d.car.t.findLastIndex((ct) => ct <= t)]);
      if (Math.min(...tel) > 250 && v.length > 50) cvs.push(cv(v));
    }
    cvs.sort((x, y) => x - y);
    expect(cvs.length).toBeGreaterThan(10);
    expect(cvs[cvs.length >> 1]).toBeLessThan(0.05);
  });

  test("#63's pit entry at 4483 s: the samples 200 m along the lane (4479.3-4482.4 s) are dropped, no slide", () => {
    const d = s!.drivers.get(63)!;
    const p = carPathOf(d);
    for (let q = 0; q < p.m; q++) expect(p.T[q] > 4_479_000 && p.T[q] < 4_482_500).toBe(false);
    expect(breaks(p).filter((t) => t > 4_470_000 && t < 4_490_000)).toEqual([]);
    // The dot drives the chord at about the telemetry speed (under 140 km/h here) and is on the samples after.
    expect(Math.max(...speeds(frames(d, 4_478_000, 4_485_000)))).toBeLessThan(200);
    const i = d.loc.t.findIndex((t) => t > 4_482_500);
    const at = carPositionAt(d, d.loc.t[i + 1])!;
    expect(Math.hypot(at.x - d.loc.x[i + 1], at.y - d.loc.y[i + 1])).toBeLessThan(50);
  });

  test("the precompute is fast (a rough guard: well under 20 ms per driver)", () => {
    const t0 = performance.now();
    const again = buildSession(meta, telemetry);
    const perDriver = (performance.now() - t0) / again.drivers.size;
    expect(perDriver).toBeLessThan(20);
  });
});
