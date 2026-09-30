// Spoiler-free views of a session at time t: what the block hooks return (H3.4).
// Pure functions over the loaded session and the shared 10 Hz race state; the hooks add caching and
// equality on top. Anything derived from the whole session belongs to useWholeSession() only.

import type { CarSeries, DriverData, FeedItem, Session } from "../data/session";
import { indexAtOrBefore } from "../engine/lookup";
import { carPositionAt, mapOpacity, type RaceState, type SectorFlag } from "../engine/raceState";
import type { DriverInfo, Lap, SessionMeta, Stint, TrackGeometry, TrackStatus, WeatherSample } from "../types";

export type SessionKind = "race" | "qualifying";

export const sessionKind = (session: Session): SessionKind => (session.meta.quali ? "qualifying" : "race");

/** Cached per key object, so every block reading the same thing shares one result. */
function cached<K extends object, V>(make: (key: K) => V): (key: K) => V {
  const cache = new WeakMap<K, V>();
  return (key) => {
    let v = cache.get(key);
    if (v === undefined) cache.set(key, (v = make(key)));
    return v;
  };
}

// ---------------------------------------------------------------- session info (fixed for the session)

/** Scheduled facts about the session: nothing here depends on how it went. */
export interface SessionInfo {
  kind: SessionKind;
  sessionKey: number;
  meetingName: string;
  sessionName: string;
  year: number;
  circuit: string;
  country: string;
  /** ISO UTC timestamp of t = 0, and the circuit's UTC offset (e.g. "04:00:00"), for local time. */
  t0: string;
  gmtOffset: string;
  /** Lights out, in ms since t0 (race time = t - lightsOut). Live, before lap 1, only an estimate. */
  lightsOut: number;
  lightsOutEstimated: boolean;
  totalLaps: number;
  /** Live: the race distance isn't known yet, so totalLaps is estimated from the lap length. */
  totalLapsEstimated: boolean;
}

export const sessionInfoOf = cached((meta: SessionMeta): SessionInfo => ({
  kind: meta.quali ? "qualifying" : "race",
  sessionKey: meta.sessionKey,
  meetingName: meta.meetingName,
  sessionName: meta.sessionName,
  year: meta.year,
  circuit: meta.circuit,
  country: meta.country,
  t0: meta.t0,
  gmtOffset: meta.gmtOffset,
  lightsOut: meta.lightsOut,
  lightsOutEstimated: meta.lightsOutEstimated ?? false,
  totalLaps: meta.totalLaps,
  totalLapsEstimated: meta.totalLapsEstimated ?? false,
}));

/** Drivers with data, in session order. */
export const driversOf = cached((session: Session): DriverInfo[] => session.driverNumbers.map((n) => session.drivers.get(n)!.info));

/** The circuit, without the reference lap (a lap time taken from the whole race). */
export type Track = Omit<TrackGeometry, "referenceLap">;

export const trackOf = cached((track: TrackGeometry): Track => {
  const { referenceLap: _, ...rest } = track;
  return rest;
});

// ---------------------------------------------------------------- the race at t

export interface RaceView {
  leaderLap: number;
  totalLaps: number;
  trackStatus: TrackStatus;
  /** Marshal sector -> flag. */
  sectorFlags: ReadonlyMap<number, SectorFlag>;
  weather: WeatherSample | null;
  /** Fastest completed lap so far. */
  fastestLap: Lap | null;
  /** Driver numbers in timing-tower order (retired cars last). */
  order: readonly number[];
}

export const raceViewOf = cached(
  (race: RaceState): RaceView => ({
    leaderLap: race.leaderLap,
    totalLaps: race.totalLaps,
    trackStatus: race.trackStatus,
    sectorFlags: race.sectorFlags,
    weather: race.weather,
    fastestLap: race.fastestLap,
    order: race.drivers.map((d) => d.driver),
  }),
);

/** Laps the driver has completed by t (the lap in progress isn't included). */
export function lapsAt(d: DriverData, t: number): Lap[] {
  return d.laps.filter((l) => l.end != null && l.end <= t);
}

/** A stint started by t. The one in progress is `open`, and its `lapEnd` is cut at the current lap. */
export interface StintView extends Stint {
  open: boolean;
}

/**
 * Stints started by the driver's current lap (the rule the tyre strip and tyre badge use), so a replay
 * never shows a stop that hasn't happened. `lap` is the driver's lap at t (DriverState.lap).
 */
export function stintsAt(d: DriverData, lap: number): StintView[] {
  const upTo = Math.max(lap, 1);
  const started = d.stints.filter((s) => s.lapStart <= upTo);
  return started.map((s, i) => ({ ...s, lapEnd: Math.min(s.lapEnd, upTo), open: i === started.length - 1 }));
}

/** Index of the newest feed item shown at t. At the end of the replay, includes post-race items. */
export function feedEndAt(session: Session, t: number): number {
  return t >= session.meta.duration ? session.feed.length - 1 : indexAtOrBefore(session.feedTimes, t);
}

/** Feed items up to index `end` (from feedEndAt), newest first. */
export const feedUpTo = (session: Session, end: number): FeedItem[] => session.feed.slice(0, end + 1).reverse();

/** Car telemetry samples, columnar: copies, so nothing past t is reachable (not even via `.buffer`). */
export interface CarHistory {
  t: Float64Array;
  speed: Float32Array;
  rpm: Float32Array;
  gear: Uint8Array;
  throttle: Float32Array;
  brake: Float32Array;
  /** Absent from 2026 (no DRS). */
  drs: Uint8Array | null;
}

/** Sample index range [from, to] of `car` inside [t - windowMs, t] (empty when to < from). */
export function historyRange(car: CarSeries, t: number, windowMs: number): { from: number; to: number } {
  const lo = t - Math.max(windowMs, 0);
  const before = indexAtOrBefore(car.t, lo);
  const from = before >= 0 && car.t[before] === lo ? before : before + 1;
  return { from, to: indexAtOrBefore(car.t, t) };
}

export function historySlice(car: CarSeries, from: number, to: number): CarHistory {
  const end = Math.max(to + 1, from);
  return {
    t: car.t.slice(from, end),
    speed: car.speed.slice(from, end),
    rpm: car.rpm.slice(from, end),
    gear: car.gear.slice(from, end),
    throttle: car.throttle.slice(from, end),
    brake: car.brake.slice(from, end),
    drs: car.drs ? car.drs.slice(from, end) : null,
  };
}

/** The car on the map at t: track coordinates (as useTrack's outline) and opacity (fading after retiring). */
export interface CarPosition {
  x: number;
  y: number;
  opacity: number;
}

export function carAt(d: DriverData, t: number): CarPosition | null {
  const opacity = mapOpacity(d, t);
  if (opacity === 0) return null;
  const p = carPositionAt(d, t);
  return p ? { x: p.x, y: p.y, opacity } : null;
}

// ---------------------------------------------------------------- selection

/**
 * The driver a driver block shows: pinned by its settings, else the focused driver, else the
 * best-placed selected one, else the leader (the driver panel's rule). `order` is the running order.
 */
export function selectedDriverOf(
  order: readonly number[],
  selected: readonly number[],
  focused: number | null,
  pinned: number | null,
): number | null {
  if (pinned != null && order.includes(pinned)) return pinned;
  if (focused != null && order.includes(focused)) return focused;
  return order.find((n) => selected.includes(n)) ?? order[0] ?? null;
}

// ---------------------------------------------------------------- the whole session (opt-out)

/** Everything, past and future. Only for blocks that need it (the timeline's bands and markers). */
export interface WholeSession {
  meta: SessionMeta;
  /** lapStartTimes[n] = when the leader started lap n (index 0 unused). */
  lapStartTimes: readonly number[];
  /** Every feed item, oldest first. */
  feed: readonly FeedItem[];
}

export const wholeSessionOf = cached(
  (session: Session): WholeSession => ({ meta: session.meta, lapStartTimes: session.lapStartTimes, feed: session.feed }),
);
