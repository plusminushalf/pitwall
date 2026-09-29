// Qualifying lap traces (laps/<driver>.json), fetched on demand and decoded once per session.

import { decodeLapTrace, type DecodedLap } from "../engine/compare";
import type { DriverLapTraces, QualiData, QualiLap, SessionMeta } from "../types";
import { source } from "./fetch";

const base = `${import.meta.env.BASE_URL}sessions`;
const cache = new Map<string, Promise<Map<number, DecodedLap>>>();

/** Every traced lap of one driver, by lap number. */
export function fetchLapTraces(sessionKey: number, driver: number): Promise<Map<number, DecodedLap>> {
  const key = `${sessionKey}:${driver}`;
  let p = cache.get(key);
  if (!p) {
    const url = `${base}/${sessionKey}/laps/${driver}.json`;
    // Spike S1: `?source=opfs` reads from browser storage (see ./fetch.ts).
    p = (
      source === "opfs"
        ? import("./opfs").then((m) => m.opfsJson<DriverLapTraces>(url))
        : fetch(url).then((res) => {
            if (!res.ok) throw new Error(`${res.status} loading lap traces for #${driver}`);
            return res.json() as Promise<DriverLapTraces>;
          })
    )
      .then((tr) => new Map(tr.laps.map((l) => [l.lap, decodeLapTrace(driver, l)])));
    p.catch(() => cache.delete(key));
    cache.set(key, p);
  }
  return p;
}

export type LapPreset = "best" | number; // fastest counting lap overall, or in segment n

/** The lap to compare for a driver when none was picked: fastest counting lap (overall or in a segment). */
export function defaultLap(meta: SessionMeta, driver: number, preset: LapPreset): number | null {
  const q = meta.quali!;
  const r = q.results.find((x) => x.driver === driver);
  const own = (k: number) => (r?.laps[k] != null && r.times[k] != null ? { lap: r.laps[k]!, time: r.times[k]! } : null);
  if (preset !== "best") {
    const s = own(preset - 1);
    if (s) return s.lap;
  }
  const best = q.segments.map((_, k) => own(k)).filter((x) => x != null).sort((a, b) => a.time - b.time)[0];
  if (best) return best.lap;
  // No counting time at all: the fastest lap with a trace (possibly deleted).
  return traced(q, driver, meta)[0]?.lap ?? null;
}

/** Laps with a trace, fastest first. */
export function traced(q: QualiData, driver: number, meta: SessionMeta): QualiLap[] {
  const dur = (l: QualiLap) => meta.laps.find((m) => m.driver === l.driver && m.lap === l.lap)?.duration ?? Infinity;
  return q.laps.filter((l) => l.driver === driver && l.trace).sort((a, b) => dur(a) - dur(b));
}
