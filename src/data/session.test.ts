// Live session helpers against the real 2026 Azerbaijan GP (run `bun run ingest 11377` first):
// a snapshot plus streamed chunks must end up exactly like loading the whole replay.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import type { DriverTelemetry, SessionMeta } from "../types";
import { appendTelemetry, buildSession, withMeta, type DriverData, type Session } from "./session";

const dir = new URL("../../data/sessions/11377/", import.meta.url).pathname;
const available = existsSync(`${dir}meta.json`);

function decode(deltas: number[]): number[] {
  let t = 0;
  return deltas.map((d) => (t += d));
}

/** Absolute times per driver, so slicing a time window is a pointer walk. */
interface Decoded {
  tel: DriverTelemetry;
  locT: number[];
  carT: number[];
}

function firstAfter(ts: number[], t: number): number {
  let lo = 0;
  let hi = ts.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ts[mid] <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Samples with from < t <= to, encoded like a live `tel` chunk (t[0] absolute, then deltas). */
function window(d: Decoded, from: number, to: number): DriverTelemetry {
  const range = (ts: number[]) => [firstAfter(ts, from), firstAfter(ts, to)] as const;
  const enc = (ts: number[], a: number, b: number) => ts.slice(a, b).map((t, i) => (i === 0 ? t : t - ts[a + i - 1]));
  const [la, lb] = range(d.locT);
  const [ca, cb] = range(d.carT);
  const { loc, car } = d.tel;
  return {
    driver: d.tel.driver,
    loc: { t: enc(d.locT, la, lb), x: loc.x.slice(la, lb), y: loc.y.slice(la, lb), z: loc.z.slice(la, lb) },
    car: {
      t: enc(d.carT, ca, cb),
      speed: car.speed.slice(ca, cb),
      rpm: car.rpm.slice(ca, cb),
      gear: car.gear.slice(ca, cb),
      throttle: car.throttle.slice(ca, cb),
      brake: car.brake.slice(ca, cb),
      ...(car.drs ? { drs: car.drs.slice(ca, cb) } : {}),
    },
  };
}

const columns = (d: DriverData) => ({
  loc: [d.loc.t, d.loc.x, d.loc.y].map((a) => Array.from(a)),
  car: [d.car.t, d.car.speed, d.car.rpm, d.car.gear, d.car.throttle, d.car.brake].map((a) => Array.from(a)),
  drs: d.car.drs ? Array.from(d.car.drs) : null,
});

describe.skipIf(!available)("live session helpers (Baku 2026)", () => {
  const meta: SessionMeta = available ? JSON.parse(readFileSync(`${dir}meta.json`, "utf8")) : (null as unknown as SessionMeta);
  const telemetry: DriverTelemetry[] = available
    ? meta.drivers.map((d) => JSON.parse(readFileSync(`${dir}drivers/${d.number}.json`, "utf8")))
    : [];
  const decoded: Decoded[] = telemetry.map((tel) => ({ tel, locT: decode(tel.loc.t), carT: decode(tel.car.t) }));
  const full = available ? buildSession(meta, telemetry) : (null as unknown as Session);

  test("a snapshot plus streamed chunks equals the whole session", () => {
    const cut = meta.lightsOut + 20 * 60_000;
    const late = meta.drivers.at(-1)!.number; // no samples in the snapshot: joins mid-stream
    let s = buildSession(
      meta,
      decoded.filter((d) => d.tel.driver !== late).map((d) => window(d, -Infinity, cut)),
    );
    expect(s.drivers.has(late)).toBe(false);

    const first = s;
    const buffers = new Set<ArrayBufferLike>();
    const lateJoinsAt = cut + 7 * 60_000;
    let replaced = 0;
    const end = Math.max(...decoded.flatMap((d) => [d.locT.at(-1) ?? 0, d.carT.at(-1) ?? 0]));
    for (let from = cut, step = 0; from < end; step++) {
      const to = from + 500 + (step % 7) * 700; // uneven chunks, like the relay's
      const chunks = decoded
        .filter((d) => d.tel.driver !== late || to > lateJoinsAt)
        .map((d) => window(d, d.tel.driver === late && from < lateJoinsAt ? -Infinity : from, to))
        .filter((c) => c.loc.t.length + c.car.t.length > 0);
      const next = appendTelemetry(s, chunks);
      if (next !== s) replaced++;
      s = next;
      const ver = s.drivers.get(1);
      if (ver) buffers.add(ver.loc.t.buffer);
      from = to;
    }

    expect(replaced).toBe(1); // only when the late driver's first samples arrived
    expect(s.meta).toBe(first.meta);
    expect(s.driverNumbers.sort((a, b) => a - b)).toEqual(full.driverNumbers.sort((a, b) => a - b));
    for (const n of full.driverNumbers) expect(columns(s.drivers.get(n)!)).toEqual(columns(full.drivers.get(n)!));
    // Capacity doubling: a handful of reallocations for thousands of appends.
    expect(buffers.size).toBeLessThan(12);
  });

  test("duplicate or stale samples are not appended twice", () => {
    const d = decoded[0];
    const s = buildSession(meta, [window(d, -Infinity, meta.lightsOut)]);
    const chunk = window(d, meta.lightsOut, meta.lightsOut + 10_000);
    appendTelemetry(s, [chunk]);
    const once = columns(s.drivers.get(d.tel.driver)!);
    appendTelemetry(s, [chunk, window(d, meta.lightsOut + 5_000, meta.lightsOut + 10_000)]);
    expect(columns(s.drivers.get(d.tel.driver)!)).toEqual(once);
    const ts = once.loc[0];
    expect(ts.every((t, i) => i === 0 || t > ts[i - 1])).toBe(true);
  });

  test("older views keep their length while the session grows", () => {
    const d = decoded[0];
    const s = buildSession(meta, [window(d, -Infinity, meta.lightsOut)]);
    appendTelemetry(s, [window(d, meta.lightsOut, meta.lightsOut + 2_000)]);
    const before = s.drivers.get(d.tel.driver)!.loc;
    const len = before.t.length;
    const last = before.t[len - 1];
    appendTelemetry(s, [window(d, meta.lightsOut + 2_000, meta.lightsOut + 4_000)]);
    expect(before.t.length).toBe(len);
    expect(before.t[len - 1]).toBe(last);
    expect(s.drivers.get(d.tel.driver)!.loc.t.length).toBeGreaterThan(len);
  });

  test("withMeta rebuilds timing from the new meta and reuses the decoded telemetry", () => {
    const cut = meta.lightsOut + 15 * 60_000;
    const s = buildSession(meta, decoded.map((d) => window(d, -Infinity, cut)));
    const partial: SessionMeta = {
      ...meta,
      duration: cut,
      chequered: null,
      laps: meta.laps.filter((l) => l.lap <= 10),
      results: [],
      track: JSON.parse(JSON.stringify(meta.track)), // equal but not the same object
    };
    const next = withMeta(s, partial);
    expect(next).not.toBe(s);
    expect(next.meta.duration).toBe(cut);
    expect(next.meta.track).toBe(s.meta.track); // unchanged track keeps its identity
    expect(next.lapStartTimes.length).toBe(11);
    for (const n of s.driverNumbers) {
      const a = s.drivers.get(n)!;
      const b = next.drivers.get(n)!;
      expect(b.loc).toBe(a.loc);
      expect(b.car).toBe(a.car);
      expect(b.laps.every((l) => l.lap <= 10)).toBe(true);
      expect(b.result).toBeNull();
    }
    const moved = withMeta(next, { ...partial, track: { ...partial.track, rotation: partial.track.rotation + 90 } });
    expect(moved.meta.track).not.toBe(next.meta.track);
    // Growing the new session leaves the old one as it was.
    const lenBefore = s.drivers.get(s.driverNumbers[0])!.loc.t.length;
    appendTelemetry(next, decoded.map((d) => window(d, cut, cut + 30_000)));
    expect(s.drivers.get(s.driverNumbers[0])!.loc.t.length).toBe(lenBefore);
    expect(next.drivers.get(s.driverNumbers[0])!.loc.t.length).toBeGreaterThan(lenBefore);
  });

  test("buildSession groups per-driver timing exactly like filtering the meta", () => {
    for (const n of full.driverNumbers) {
      const d = full.drivers.get(n)!;
      expect(d.laps).toEqual(meta.laps.filter((l) => l.driver === n).sort((a, b) => a.lap - b.lap));
      expect(d.stints).toEqual(meta.stints.filter((s) => s.driver === n).sort((a, b) => a.stint - b.stint));
      expect(d.pits).toEqual(meta.pits.filter((p) => p.driver === n));
      expect(d.positions).toEqual(meta.positions.filter((p) => p.driver === n));
      expect(d.intervals).toEqual(meta.intervals.filter((i) => i.driver === n));
      expect(d.result).toEqual(meta.results.find((r) => r.driver === n) ?? null);
      expect(d.gridPosition).toEqual(meta.grid.find((g) => g.driver === n)?.position ?? null);
    }
  });
});
