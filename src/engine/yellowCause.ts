// Who caused a sector yellow? Race control's sector flags never name a car (OpenF1 `driver_number`
// is null), so this infers it from telemetry: the car that was stopped, or crawling, in or next to
// the flagged marshal sectors around the moment the flag came out. It only names a car when that is
// clear: a wrong name is worse than none.

import type { DriverData } from "../data/session";
import type { Ms, RaceControlMsg, SessionMeta, TrackStatus } from "../types";
import { indexAtOrBefore } from "./lookup";

export const YELLOW_CAUSE = {
  /** Telemetry window around the flag: marshals react to what already happened, a car may still be slowing. */
  beforeMs: 15_000,
  afterMs: 5_000,
  /** At or below this a car counts as stopped (km/h). */
  stoppedKmh: 10,
  /** Under green, a car this slow (km/h) counts if it is also well below its own speed there a lap earlier. */
  slowKmh: 50,
  slowRatio: 0.5,
  /** Cars stopped for longer than this before the window were already out (retired, parked) (ms). */
  parkedMs: 60_000,
  /** Cars that retired this long before the flag are not candidates (ms). */
  retiredMs: 60_000,
  /** Pit windows are widened by this on both sides: the entry/exit lanes run beside the track (ms). */
  pitMarginMs: 10_000,
  /** The first seconds after lights out, when every car is still accelerating, don't count (ms). */
  startMs: 8_000,
  /** Flags in adjacent sectors this soon after an incident's first flag belong to that incident (ms). */
  joinMs: 10_000,
  /** A location sample this far from the speed sample doesn't place the car (ms). */
  locGapMs: 2_000,
  /** More candidates than this is a pile-up or a slow field: name nobody. */
  maxStopped: 4,
  maxSlowed: 2,
};

export type YellowCauseOptions = typeof YELLOW_CAUSE;

const isYellow = (m: RaceControlMsg) =>
  m.category === "Flag" && m.scope === "Sector" && m.sector != null && (m.flag === "YELLOW" || m.flag === "DOUBLE YELLOW");

/** One incident: the first flag and the marshal sectors flagged for it. */
export interface Incident {
  t: Ms;
  sectors: Set<number>;
  messages: number[]; // indexes into meta.raceControl
}

/**
 * Sector yellows grouped into incidents. A yellow in a sector that is already yellow (e.g. upgraded to
 * double yellow) continues that sector's incident; so does a new yellow next to one of its sectors
 * shortly after it started (OpenF1 often flags sectors N and N + 1 in the same second).
 */
export function incidentsOf(meta: SessionMeta, joinMs: number = YELLOW_CAUSE.joinMs): Incident[] {
  const count = meta.track.marshalSectors.length;
  const incidents: Incident[] = [];
  const active = new Map<number, Incident>(); // flagged sector -> its incident
  const adjacent = (a: number, b: number) => {
    const d = Math.abs(a - b);
    return d === 1 || (count > 2 && d === count - 1);
  };
  meta.raceControl.forEach((m, i) => {
    if (m.category !== "Flag") return;
    if (m.scope === "Track" && (m.flag === "CLEAR" || m.flag === "GREEN")) active.clear();
    if (m.scope !== "Sector" || m.sector == null) return;
    if (!isYellow(m)) {
      if (m.flag !== "RED") active.delete(m.sector); // clear or green: this sector's yellow is over
      return;
    }
    let incident = active.get(m.sector);
    if (!incident) {
      for (const [s, inc] of active) if (adjacent(s, m.sector) && m.t - inc.t <= joinMs) incident = inc;
    }
    if (!incident) {
      incident = { t: m.t, sectors: new Set(), messages: [] };
      incidents.push(incident);
    }
    incident.sectors.add(m.sector);
    incident.messages.push(i);
    active.set(m.sector, incident);
  });
  return incidents;
}

/** Marshal sector of each outline point (0 where none covers it). */
function sectorOfOutline(meta: SessionMeta): Int32Array {
  const n = meta.track.outline.x.length;
  const out = new Int32Array(n);
  for (const s of meta.track.marshalSectors) {
    if (s.from <= s.to) {
      for (let i = s.from; i < s.to && i < n; i++) out[i] = s.number;
    } else {
      for (let i = s.from; i < n; i++) out[i] = s.number;
      for (let i = 0; i < s.to && i < n; i++) out[i] = s.number;
    }
  }
  return out;
}

function nearestOutline(meta: SessionMeta, x: number, y: number): number {
  const ox = meta.track.outline.x;
  const oy = meta.track.outline.y;
  let best = -1;
  let bestD = Infinity;
  for (let i = 0; i < ox.length; i++) {
    const d = (ox[i] - x) ** 2 + (oy[i] - y) ** 2;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/** The car's location at t (nearest sample within `gapMs`), or null. */
function locAt(d: DriverData, t: Ms, gapMs: number): { x: number; y: number } | null {
  const lt = d.loc.t;
  const i = indexAtOrBefore(lt, t);
  let k = -1;
  if (i >= 0 && t - lt[i] <= gapMs) k = i;
  if (i + 1 < lt.length && lt[i + 1] - t <= gapMs && (k < 0 || lt[i + 1] - t < t - lt[k])) k = i + 1;
  return k < 0 ? null : { x: d.loc.x[k], y: d.loc.y[k] };
}

/** The car's speed about a lap before `t` at the point nearest (x, y), or null if it can't tell. */
function speedLapBefore(d: DriverData, t: Ms, x: number, y: number, lapMs: number): number | null {
  const lt = d.loc.t;
  const from = indexAtOrBefore(lt, t - 1.5 * lapMs) + 1;
  const to = indexAtOrBefore(lt, t - 0.6 * lapMs);
  let best = -1;
  let bestD = Infinity;
  for (let i = from; i <= to; i++) {
    const dd = (d.loc.x[i] - x) ** 2 + (d.loc.y[i] - y) ** 2;
    if (dd < bestD) {
      bestD = dd;
      best = i;
    }
  }
  if (best < 0) return null;
  const c = indexAtOrBefore(d.car.t, lt[best]);
  return c >= 0 && lt[best] - d.car.t[c] < 2_000 ? d.car.speed[c] : null;
}

interface Slowest {
  speed: number;
  t: Ms;
  x: number;
  y: number;
}

/** The slowest the car went inside `sectors` during [from, to] (earliest such sample), or null if never slow there. */
function slowestIn(d: DriverData, meta: SessionMeta, sectorAt: Int32Array, sectors: Set<number>, from: Ms, to: Ms, o: YellowCauseOptions): Slowest | null {
  const ct = d.car.t;
  let best: Slowest | null = null;
  for (let i = indexAtOrBefore(ct, from) + 1; i < ct.length && ct[i] <= to; i++) {
    const v = d.car.speed[i];
    // Only slow samples can qualify; placing a sample on the outline is the costly part.
    if (v >= o.slowKmh || (best && v >= best.speed)) continue;
    const p = locAt(d, ct[i], o.locGapMs);
    if (!p) continue;
    if (sectors.has(sectorAt[nearestOutline(meta, p.x, p.y)])) best = { speed: v, t: ct[i], x: p.x, y: p.y };
  }
  return best;
}

/** True if the car was stopped for all of [t - o.parkedMs, t] (it was already out before the incident). */
function parkedBefore(d: DriverData, t: Ms, o: YellowCauseOptions): boolean {
  const ct = d.car.t;
  const end = indexAtOrBefore(ct, t);
  if (end < 0 || t - ct[end] > o.parkedMs) return false; // no data: can't tell
  for (let i = end; i >= 0; i--) {
    if (d.car.speed[i] > o.stoppedKmh) return false;
    if (t - ct[i] >= o.parkedMs) return true;
  }
  return false;
}

function maxSpeed(d: DriverData, from: Ms, to: Ms): number {
  const ct = d.car.t;
  let max = 0;
  for (let i = Math.max(0, indexAtOrBefore(ct, from)); i < ct.length && ct[i] <= to; i++) max = Math.max(max, d.car.speed[i]);
  return max;
}

const neutralised = (s: TrackStatus) => s !== "GREEN" && s !== "CHEQUERED";

/**
 * Cars that caused each sector yellow, by index into `meta.raceControl`. Only messages it is confident
 * about get an entry, and never ones that already name a driver. Telemetry must cover the whole window
 * (live sessions: the entry appears once it does).
 */
export function yellowCulprits(
  meta: SessionMeta,
  drivers: ReadonlyMap<number, DriverData>,
  o: YellowCauseOptions = YELLOW_CAUSE,
): Map<number, number[]> {
  const out = new Map<number, number[]>();
  const { marshalSectors, outline } = meta.track;
  if (!marshalSectors.length || !outline.x.length) return out;
  const count = marshalSectors.length;
  const sectorAt = sectorOfOutline(meta);
  const lapMs = meta.track.referenceLap.duration * 1000;
  const statusTimes = meta.trackStatus.map((e) => e.t);
  const explained = new Map<number, Ms>(); // car -> when it stopped for an earlier incident
  let latest = -Infinity;
  for (const d of drivers.values()) if (d.car.t.length) latest = Math.max(latest, d.car.t[d.car.t.length - 1]);

  for (const inc of incidentsOf(meta, o.joinMs)) {
    const T = inc.t;
    if (T < meta.lightsOut + o.startMs || (meta.chequered != null && T > meta.chequered)) continue;
    const to = T + o.afterMs;
    if (to > latest) continue; // live: not enough telemetry yet
    const from = Math.max(T - o.beforeMs, meta.lightsOut + o.startMs);
    const si = indexAtOrBefore(statusTimes, T);
    const strict = si >= 0 && neutralised(meta.trackStatus[si].status);

    // The flagged sectors and their neighbours: flags go up a sector or so from where the car is.
    const region = new Set<number>();
    for (const s of inc.sectors) for (const k of [s - 1, s, s + 1]) region.add(((k - 1 + count) % count) + 1);

    const stopped: number[] = [];
    const slowed: number[] = [];
    const stale: number[] = []; // still stopped for an earlier incident next door
    for (const [n, d] of drivers) {
      const retired = d.result?.retired;
      if (retired != null && retired < T - o.retiredMs) continue;
      if (d.result?.finish != null && d.result.finish < from) continue;
      if (d.pits.some((p) => p.entry - o.pitMarginMs <= to && p.exit + o.pitMarginMs >= from)) continue;
      const slow = slowestIn(d, meta, sectorAt, region, from, to, o);
      if (!slow || parkedBefore(d, from, o)) continue;
      // Still sitting where an earlier incident already accounts for it.
      const prev = explained.get(n);
      if (prev != null && prev < slow.t && maxSpeed(d, prev, slow.t) <= o.stoppedKmh) {
        stale.push(n);
        continue;
      }
      if (slow.speed <= o.stoppedKmh) {
        stopped.push(n);
        explained.set(n, slow.t);
      } else if (!strict) {
        // Slow for this spot, not just a slow corner: well below its own speed there a lap earlier.
        const ref = speedLapBefore(d, slow.t, slow.x, slow.y, lapMs);
        if (ref != null && slow.speed < o.slowRatio * ref) slowed.push(n);
      }
    }
    // Stopped cars are the incident; cars merely slow next to them are avoiding it. Failing both, a car
    // still stopped for an incident next door is why the flags spread.
    const [culprits, max] = stopped.length
      ? [stopped, o.maxStopped]
      : slowed.length
        ? [slowed, o.maxSlowed]
        : [stale, o.maxStopped];
    if (culprits.length === 0 || culprits.length > max) continue;
    for (const i of inc.messages) if (meta.raceControl[i].driver == null) out.set(i, culprits);
  }
  return out;
}
