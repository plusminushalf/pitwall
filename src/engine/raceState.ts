// Pure "state at time t" queries over a loaded session.

import type { Lap, Ms, TrackStatus, WeatherSample } from "../types";
import type { DriverData, FeedItem, Session } from "../data/session";
import { catmullRom, indexAtOrBefore, lerpAt, stepAt } from "./lookup";

/** Retired cars stay on the map (faded) this long after they stop, then disappear. */
const RETIRED_VISIBLE_MS = 20_000;

export type DriverStatus = "RUNNING" | "PIT" | "OUT" | "FINISHED";
export type SectorFlag = "YELLOW" | "DOUBLE YELLOW" | "RED";

export interface DriverState {
  driver: number;
  position: number | null;
  gridPosition: number | null;
  status: DriverStatus;
  lap: number; // lap currently being driven (0 before the start)
  gapToLeader: number | string | null;
  interval: number | string | null;
  lastLap: Lap | null; // most recent completed, timed lap
  bestLap: Lap | null; // fastest completed lap so far
  compound: string | null;
  tyreAge: number | null; // laps on the current set
  stint: number | null;
  pitStops: number;
}

export interface RaceState {
  t: Ms;
  raceTime: Ms; // t - lights out (negative on the formation lap)
  leaderLap: number;
  totalLaps: number;
  trackStatus: TrackStatus;
  sectorFlags: Map<number, SectorFlag>; // marshal sector -> flag
  weather: WeatherSample | null;
  fastestLap: Lap | null;
  drivers: DriverState[]; // timing-tower order
}

export interface Telemetry {
  speed: number;
  rpm: number;
  gear: number;
  throttle: number;
  brake: number;
  drs: number | null;
}

/**
 * Smoothed (Catmull-Rom) car position at t, or null outside the recorded range.
 * Finished cars stay parked at their last position: the location feed stops before the replay ends.
 */
export function carPositionAt(d: DriverData, t: Ms): { x: number; y: number } | null {
  const { t: ts, x, y } = d.loc;
  const n = ts.length;
  const i = indexAtOrBefore(ts, t);
  if (i < 0) return null;
  if (i >= n - 1) {
    const finished = d.result?.finish != null && t >= d.result.finish;
    return finished && n > 0 ? { x: x[n - 1], y: y[n - 1] } : null;
  }
  const u = (t - ts[i]) / (ts[i + 1] - ts[i]);
  const i0 = i > 0 ? i - 1 : i;
  const i3 = i + 2 < n ? i + 2 : i + 1;
  return {
    x: catmullRom(x[i0], x[i], x[i + 1], x[i3], u),
    y: catmullRom(y[i0], y[i], y[i + 1], y[i3], u),
  };
}

/** 1 = on track, between 0 and 1 = recently retired (fading), 0 = hidden. */
export function mapOpacity(d: DriverData, t: Ms): number {
  const retired = d.result?.retired;
  if (retired == null || t < retired) return 1;
  return t < retired + RETIRED_VISIBLE_MS ? 0.35 : 0;
}

export function telemetryAt(d: DriverData, t: Ms): Telemetry | null {
  const c = d.car;
  const i = indexAtOrBefore(c.t, t);
  if (i < 0) return null;
  return {
    speed: lerpAt(c.t, c.speed, t) ?? c.speed[i],
    rpm: lerpAt(c.t, c.rpm, t) ?? c.rpm[i],
    throttle: lerpAt(c.t, c.throttle, t) ?? c.throttle[i],
    gear: c.gear[i],
    brake: c.brake[i],
    drs: c.drs ? c.drs[i] : null,
  };
}

/** OpenF1 DRS codes: 10/12/14 = open, 8 = eligible (within a second in a zone). */
export const drsOpen = (code: number | null) => code === 10 || code === 12 || code === 14;
export const drsEligible = (code: number | null) => code === 8;

export function driverStateAt(d: DriverData, t: Ms): DriverState {
  const r = d.result;
  const li = indexAtOrBefore(d.lapStarts, t);
  const finished = r?.finish != null && t >= r.finish;
  const retired = r?.retired != null && t >= r.retired;
  const lap = finished && r ? r.laps : li >= 0 ? d.laps[li].lap : 0;

  let lastLap: Lap | null = null;
  let bestLap: Lap | null = null;
  for (let k = li; k >= 0; k--) {
    const l = d.laps[k];
    if (l.end == null || l.end > t || l.duration == null) continue;
    lastLap ??= l;
    if (!bestLap || l.duration < bestLap.duration!) bestLap = l;
  }

  const tyreLap = Math.max(lap, 1);
  let stint = d.stints[0] ?? null;
  for (const s of d.stints) if (s.lapStart <= tyreLap) stint = s;

  const inPit = d.pits.some((p) => t >= p.entry && t <= p.exit);
  const status = retired ? "OUT" : finished ? "FINISHED" : inPit ? "PIT" : "RUNNING";
  const iv = stepAt(d.intervals, d.intervalTimes, t);

  return {
    driver: d.info.number,
    position: stepAt(d.positions, d.positionTimes, t)?.position ?? d.gridPosition,
    gridPosition: d.gridPosition,
    status,
    lap,
    gapToLeader: iv?.gapToLeader ?? null,
    interval: iv?.interval ?? null,
    lastLap,
    bestLap,
    compound: stint?.compound ?? null,
    tyreAge: stint ? stint.ageAtStart + Math.max(0, tyreLap - stint.lapStart) : null,
    stint: stint?.stint ?? null,
    pitStops: d.pits.filter((p) => p.entry <= t).length,
  };
}

export function leaderLapAt(session: Session, t: Ms): number {
  let lap = 0;
  for (let n = 1; n < session.lapStartTimes.length; n++) {
    if (session.lapStartTimes[n] <= t) lap = n;
    else break;
  }
  return Math.min(lap, session.meta.totalLaps);
}

function sectorFlagsAt(session: Session, t: Ms): Map<number, SectorFlag> {
  const flags = new Map<number, SectorFlag>();
  const last = indexAtOrBefore(session.raceControlTimes, t);
  for (let i = 0; i <= last; i++) {
    const m = session.meta.raceControl[i];
    if (m.category !== "Flag") continue;
    if (m.scope === "Sector" && m.sector != null) {
      if (m.flag === "YELLOW" || m.flag === "DOUBLE YELLOW" || m.flag === "RED") flags.set(m.sector, m.flag);
      else flags.delete(m.sector);
    } else if (m.scope === "Track" && (m.flag === "CLEAR" || m.flag === "GREEN")) {
      flags.clear();
    }
  }
  return flags;
}

const statusRank = (s: DriverState) => (s.status === "OUT" ? 1 : 0);

export function raceStateAt(session: Session, t: Ms): RaceState {
  const { meta } = session;
  const drivers = session.driverNumbers.map((n) => driverStateAt(session.drivers.get(n)!, t));
  drivers.sort((a, b) => statusRank(a) - statusRank(b) || (a.position ?? 99) - (b.position ?? 99));

  let fastestLap: Lap | null = null;
  for (const s of drivers) {
    if (s.bestLap && (!fastestLap || s.bestLap.duration! < fastestLap.duration!)) fastestLap = s.bestLap;
  }

  return {
    t,
    raceTime: t - meta.lightsOut,
    leaderLap: leaderLapAt(session, t),
    totalLaps: meta.totalLaps,
    trackStatus: stepAt(meta.trackStatus, session.trackStatusTimes, t)?.status ?? "GREEN",
    sectorFlags: sectorFlagsAt(session, t),
    weather: stepAt(meta.weather, session.weatherTimes, t),
    fastestLap,
    drivers,
  };
}

/** Newest-first feed items up to t. At the end of the replay, includes post-race items. */
export function feedAt(session: Session, t: Ms, limit = 80): FeedItem[] {
  const end = t >= session.meta.duration ? session.feed.length - 1 : indexAtOrBefore(session.feedTimes, t);
  return session.feed.slice(Math.max(0, end - limit + 1), end + 1).reverse();
}

/** Replay time to jump to for lap n: just before the leader starts it. */
export function timeForLap(session: Session, lap: number): Ms {
  const n = Math.max(1, Math.min(lap, session.meta.totalLaps));
  return Math.max(0, (session.lapStartTimes[n] ?? 0) - 3_000);
}
