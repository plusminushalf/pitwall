// Raw OpenF1 records -> processed replay format (src/types.ts). Pure: no file or network I/O.
//
// Used by scripts/ingest.ts (a finished session, all data at once) and by the live relay
// (server/live.ts: a session in progress, recomputed every few seconds as data arrives).
// Free practice has its own timing (practice.ts): the session runs from the green light to the flag, and the
// order is by best lap.
// Repairs known OpenF1 glitches: missed timing-line crossings (laps split and renumbered),
// mis-dated lap starts, duplicate pit records, 2026 race-control wording, stale and missing
// location samples (cars dead-reckoned along the track outline from their speed trace).

import type {
  RawCarData,
  RawCircuit,
  RawDriver,
  RawInterval,
  RawLap,
  RawLocation,
  RawMeeting,
  RawOvertake,
  RawPit,
  RawPosition,
  RawRaceControl,
  RawRadio,
  RawResult,
  RawSession,
  RawStint,
  RawWeather,
} from "./openf1Types";
import { deletedLaps } from "./deletedLaps";
import { endInLapsAtPitEntry, practiceStandings, practiceStart, preparePracticeLaps, PRACTICE_PRE_MS } from "./practice";
import { isFreePractice, venueCountry } from "./season";
import type {
  DriverInfo,
  DriverTelemetry,
  IntervalEvent,
  Lap,
  Ms,
  PitStop,
  Polyline,
  PositionEvent,
  RaceControlMsg,
  Result,
  SessionMeta,
  Stint,
  TrackGeometry,
  TrackStatus,
  TrackStatusEvent,
  WeatherSample,
} from "../../src/types";

const PRE_START_MS = 5 * 60_000; // keep the formation lap
const POST_FINISH_MS = 3 * 60_000; // keep the last finishers and cool-down
const VSC_ENDING_MS = 15_000; // VSC ENDING -> green if no explicit message follows
const STALE_SPEED = 50; // km/h: above this a car cannot report the same position twice in a row
export const LOC_GAP_MS = 3_000; // location gaps longer than this are dead-reckoned
// Live: lights out is usually 3-4 minutes after the scheduled start (formation lap).
const LIGHTS_OUT_AFTER_START_MS = 220_000;
// Live: only extrapolate past a car's last location fix when the feed has stalled this long
// (MQTT can deliver location a little later than car data).
const LIVE_EDGE_GAP_MS = 10_000;

/** Everything OpenF1 has for one session (so far), as returned by the REST endpoints. */
export interface RawSessionData {
  session: RawSession;
  meeting: RawMeeting | null;
  circuit: RawCircuit | null;
  drivers: RawDriver[];
  laps: RawLap[];
  stints: RawStint[];
  pits: RawPit[];
  positions: RawPosition[];
  intervals: RawInterval[];
  raceControl: RawRaceControl[];
  weather: RawWeather[];
  radio: RawRadio[];
  overtakes: RawOvertake[];
  results: RawResult[];
  /** Raw car / location samples per driver number... */
  car?: Map<number, RawCarData[]>;
  location?: Map<number, RawLocation[]>;
  /** ...or already cleaned ones (the live relay keeps these incrementally; same `t0` required). */
  samples?: Map<number, DriverSamples>;
}

export interface LiveOptions {
  /** Absolute ms of t = 0, fixed for the whole live session (e.g. scheduled start - 10 min). */
  t0: number;
  /** Absolute ms of the live edge: the window ends here (`duration`). */
  now: number;
  /** Keep this reference lap for the outline while it qualifies, so the map doesn't shift. */
  referenceLap?: { driver: number; lap: number } | null;
}

/**
 * A finished session whose telemetry is still coming in (a race watched while it downloads, src/ingest/stream.ts):
 * everything else is complete, car data and locations cover only some spans. What's worked out from telemetry (lap
 * repairs, the outline, pit timing, retirements) only uses whole stretches of it, and nothing is driven across a gap.
 */
export interface PartialOptions {
  /** Absolute ms spans with car data and locations, in order and disjoint. */
  telemetry: { from: number; to: number }[];
  /** Keep this reference lap for the outline while it qualifies, so the map doesn't shift as faster laps come in. */
  referenceLap?: { driver: number; lap: number } | null;
}

export interface NormalizeOptions {
  /** A session in progress: see LiveOptions. Without it the session is treated as finished. */
  live?: LiveOptions;
  /** A finished session with telemetry still coming in: see PartialOptions. */
  partial?: PartialOptions;
}

/** Partial telemetry: a retirement counts once the car is seen standing for this long after it last moved. */
const RETIRED_SEEN_MS = 60_000;

/** Like DriverTelemetry, but with absolute times (ms since t0) instead of delta-encoded ones. */
export interface CleanTelemetry {
  driver: number;
  loc: { t: number[]; x: number[]; y: number[]; z: number[] };
  car: {
    t: number[];
    speed: number[];
    rpm: number[];
    gear: number[];
    throttle: number[];
    brake: number[];
    drs?: number[];
  };
}

/** What normalization found and repaired, for ingest's sanity summary. */
export interface NormalizeReport {
  warnings: string[];
  lapRenumbered: number; // drivers
  splitCount: number;
  undatedLap1: number;
  restarted: number;
  droppedCoolDown: number;
  finishFromLine: number;
  staleLoc: number;
  deadReckoned: number;
  deadReckonedDrivers: number;
  deadReckonedNumbers: number[];
  rawPits: number;
  uniquePits: number;
  recoveredPits: number;
  timingLineFound: boolean;
  pitDateIsExit: boolean;
  speedIfExit: number;
  speedIfEntry: number;
  refLap: Lap | null; // null: outline from the circuit map (live, no clean lap yet)
  /** Real location fixes per driver (before dead reckoning). */
  locFixes: Map<number, number[]>;
}

export interface NormalizeResult {
  meta: SessionMeta;
  telemetry: Map<number, CleanTelemetry>; // by driver number, ascending
  report: NormalizeReport;
}

// Timestamps of the same records are parsed again on every live recompute: memoize.
const parsed = new Map<string, number>();
function abs(iso: string): number {
  let t = parsed.get(iso);
  if (t === undefined) {
    t = Date.parse(iso);
    if (parsed.size >= 1_000_000) parsed.clear();
    parsed.set(iso, t);
  }
  return t;
}
const byTime = <T extends { t: number }>(a: T, b: T) => a.t - b.t;
const lastNumber = (v: number | string | number[] | null): number | string | null =>
  Array.isArray(v) ? (v.filter((x) => x != null).at(-1) ?? null) : v;
// Events derived from one raw record only depend on it and t0: reuse them across live recomputes.
const derivedPositions = new WeakMap<object, { t0: number; e: PositionEvent }>();
const derivedIntervals = new WeakMap<object, { t0: number; e: IntervalEvent }>();
function derive<R extends object, E>(cache: WeakMap<object, { t0: number; e: E }>, rec: R, t0: number, make: (r: R) => E): E {
  const hit = cache.get(rec);
  if (hit && hit.t0 === t0) return hit.e;
  const e = make(rec);
  cache.set(rec, { t0, e });
  return e;
}
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? NaN;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Index of the first element >= t in ascending `times` (times.length if none). */
export function firstAtOrAfter(times: number[], t: number): number {
  let lo = 0;
  let hi = times.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Index of the first element > t in ascending `times` (times.length if none). */
export function firstAfter(times: number[], t: number): number {
  let lo = 0;
  let hi = times.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function encodeTimes(times: number[]): number[] {
  return times.map((t, i) => (i === 0 ? t : t - times[i - 1]));
}

/** The file format (drivers/<n>.json): delta-encoded times. */
export function encodeTelemetry(tel: CleanTelemetry): DriverTelemetry {
  const { loc, car } = tel;
  return {
    driver: tel.driver,
    loc: { t: encodeTimes(loc.t), x: loc.x, y: loc.y, z: loc.z },
    car: {
      t: encodeTimes(car.t),
      speed: car.speed,
      rpm: car.rpm,
      gear: car.gear,
      throttle: car.throttle,
      brake: car.brake,
      ...(car.drs ? { drs: car.drs } : {}),
    },
  };
}

// ---------------------------------------------------------------- telemetry cleaning

/** Position of t in ascending `times`: existing index when present, else the insertion index. */
function place(times: number[], t: number): { i: number; same: boolean } {
  const n = times.length;
  if (n === 0 || times[n - 1] < t) return { i: n, same: false };
  if (times[n - 1] === t) return { i: n - 1, same: true };
  const i = firstAtOrAfter(times, t);
  return { i, same: times[i] === t };
}

function put(arrays: unknown[][], values: unknown[], i: number, mode: "push" | "set" | "insert") {
  for (let k = 0; k < arrays.length; k++) {
    if (mode === "push") arrays[k].push(values[k]);
    else if (mode === "set") arrays[k][i] = values[k];
    else arrays[k].splice(i, 0, values[k]);
  }
}

/**
 * One driver's car and location samples, cleaned as they arrive: times in ms since `t0`, sorted,
 * samples before t0 dropped, duplicate timestamps collapsed (the last one received wins),
 * (0, 0, 0) "no signal" locations dropped, and stale locations (the same x/y repeated while the
 * car moves, e.g. 2026 Hungary) filtered out. Appending is O(1); `view` is cheap once settled,
 * so the live relay can recompute a growing session every few seconds.
 */
export class DriverSamples {
  readonly car = {
    t: [] as number[],
    speed: [] as number[],
    rpm: [] as number[],
    gear: [] as number[],
    throttle: [] as number[],
    brake: [] as number[],
    drs: [] as (number | null)[],
  };
  readonly fixes = { t: [] as number[], x: [] as number[], y: [] as number[], z: [] as number[] };
  // Fixes [0, settled) have been filtered into kept[0, keptSettled): later car samples can no longer
  // change them. Kept fixes after that are provisional (redone on every view).
  private kept = { t: [] as number[], x: [] as number[], y: [] as number[], z: [] as number[] };
  private settled = 0;
  private keptSettled = 0;
  private dirty = false;
  private dist: number[] = []; // cumulative distance driven (dm) at each car sample

  constructor(
    readonly driver: number,
    readonly t0: number,
  ) {}

  addCar(s: RawCarData): void {
    const t = Math.round(Date.parse(s.date) - this.t0);
    if (!(t >= 0)) return;
    const c = this.car;
    const { i, same } = place(c.t, t);
    const values = [t, s.speed, s.rpm, s.n_gear, clamp(s.throttle, 0, 100), clamp(s.brake, 0, 100), s.drs ?? null];
    put([c.t, c.speed, c.rpm, c.gear, c.throttle, c.brake, c.drs], values, i, same ? "set" : i === c.t.length ? "push" : "insert");
    // A car sample among settled fixes (or a new first one) can change their stale verdicts.
    if (this.settled > 0 && (i === 0 || t <= this.fixes.t[this.settled - 1])) this.dirty = true;
    if (i < this.dist.length) this.dist = [];
  }

  /** Cumulative distance driven (location units, i.e. decimetres) at each car sample, from speed. */
  distance(): number[] {
    const { t, speed: v } = this.car;
    const d = this.dist;
    if (t.length && !d.length) d.push(0);
    // km/h × ms / 360 = dm
    for (let i = d.length; i < t.length; i++) d.push(d[i - 1] + (((v[i - 1] + v[i]) / 2) * (t[i] - t[i - 1])) / 360);
    return d;
  }

  addLocation(s: RawLocation): void {
    if (s.x === 0 && s.y === 0 && s.z === 0) return; // no position signal, not a real point on track
    const t = Math.round(Date.parse(s.date) - this.t0);
    if (!(t >= 0)) return;
    const f = this.fixes;
    const { i, same } = place(f.t, t);
    put([f.t, f.x, f.y, f.z], [t, s.x, s.y, s.z], i, same ? "set" : i === f.t.length ? "push" : "insert");
    if (i < this.settled) this.dirty = true;
  }

  get size(): number {
    return this.car.t.length + this.fixes.t.length;
  }

  /** Stale fix: same x/y as the previous fix while the car (last sample at or before it) was moving. */
  private stale(i: number, nCar: number): boolean {
    const f = this.fixes;
    if (i === 0 || f.x[i] !== f.x[i - 1] || f.y[i] !== f.y[i - 1] || nCar === 0) return false;
    const ci = Math.max(0, firstAfter(this.car.t, f.t[i]) - 1);
    return this.car.speed[ci] >= STALE_SPEED;
  }

  /** Samples in [0, duration], plus how many stale fixes were dropped. Arrays may be shared: don't mutate. */
  view(duration: Ms): { telemetry: CleanTelemetry; stale: number } {
    const c = this.car;
    const f = this.fixes;
    if (this.dirty) {
      // Fresh arrays: earlier views may still hold the old ones.
      this.kept = { t: [], x: [], y: [], z: [] };
      this.settled = this.keptSettled = 0;
      this.dirty = false;
    }
    const k = this.kept;
    const all = [k.t, k.x, k.y, k.z];
    for (const a of all) a.length = this.keptSettled;
    const lastCar = c.t.length ? c.t[c.t.length - 1] : -Infinity;
    for (; this.settled < f.t.length && f.t[this.settled] < lastCar; this.settled++) {
      const i = this.settled;
      if (!this.stale(i, c.t.length)) put(all, [f.t[i], f.x[i], f.y[i], f.z[i]], 0, "push");
    }
    this.keptSettled = k.t.length;
    for (let i = this.settled; i < f.t.length; i++) {
      if (!this.stale(i, c.t.length)) put(all, [f.t[i], f.x[i], f.y[i], f.z[i]], 0, "push");
    }

    const nCar = firstAfter(c.t, duration);
    const nFix = firstAfter(f.t, duration);
    let loc: CleanTelemetry["loc"];
    let stale = 0;
    if (nCar === 0) {
      loc = { t: f.t.slice(0, nFix), x: f.x.slice(0, nFix), y: f.y.slice(0, nFix), z: f.z.slice(0, nFix) };
    } else {
      const nKept = firstAfter(k.t, duration);
      stale = nFix - nKept;
      loc = nKept === k.t.length ? k : { t: k.t.slice(0, nKept), x: k.x.slice(0, nKept), y: k.y.slice(0, nKept), z: k.z.slice(0, nKept) };
    }

    const whole = nCar === c.t.length;
    const cut = <T>(a: T[]) => (whole ? a : a.slice(0, nCar));
    let hasDrs = false;
    for (let i = 0; i < nCar && !hasDrs; i++) hasDrs = c.drs[i] != null;
    return {
      telemetry: {
        driver: this.driver,
        loc,
        car: {
          t: cut(c.t),
          speed: cut(c.speed),
          rpm: cut(c.rpm),
          gear: cut(c.gear),
          throttle: cut(c.throttle),
          brake: cut(c.brake),
          ...(hasDrs ? { drs: c.drs.slice(0, nCar).map((v) => v ?? 0) } : {}),
        },
      },
      stale,
    };
  }
}

// ---------------------------------------------------------------- live estimates

/** Closed length of the MultiViewer circuit trace (decimetres), or null. */
function circuitTraceLength(circuit: RawCircuit | null): number | null {
  const x = circuit?.x;
  const y = circuit?.y;
  if (!x?.length || !y || y.length !== x.length || x.length < 10) return null;
  let len = Math.hypot(x[0] - x[x.length - 1], y[0] - y[y.length - 1]);
  for (let i = 1; i < x.length; i++) len += Math.hypot(x[i] - x[i - 1], y[i] - y[i - 1]);
  return len;
}

/**
 * Race distance in laps when it isn't known yet: the fewest laps over 305 km (sprints 100 km,
 * Monaco 260 km). Traces run slightly inside the official lap length, hence the small factors
 * (calibrated on the 2026 season: right for 18 of 20 races and sprints, one lap over otherwise).
 */
export function estimateTotalLaps(
  session: Pick<RawSession, "session_name" | "circuit_short_name">,
  lengths: { circuit?: number | null; outline?: number | null; driven?: number | null },
): number {
  const sprint = /sprint/i.test(session.session_name);
  const monaco = /monaco|monte carlo/i.test(session.circuit_short_name);
  const km = sprint ? 100 : monaco ? 260 : 305;
  const lapMetres =
    lengths.circuit && lengths.circuit > 0
      ? (lengths.circuit * 1.008) / 10
      : lengths.outline && lengths.outline > 0
        ? (lengths.outline * 1.015) / 10
        : lengths.driven && lengths.driven > 0
          ? (lengths.driven * 1.02) / 10
          : null;
  if (lapMetres == null || lapMetres < 1_000) return sprint ? 19 : monaco ? 78 : 57;
  return Math.ceil((km * 1000) / lapMetres);
}

// ---------------------------------------------------------------- normalize

/**
 * A finished session's replay window in absolute ms, from its laps and race control alone: t0 is 5 minutes
 * before lights out (the formation lap), the end 3 minutes after the flag (or after the last lap, if later).
 * Free practice (laps as preparePracticeLaps leaves them): "lights out" is the green light, t0 a minute before it.
 * Ingest plans its telemetry requests from it before any telemetry is in.
 */
/**
 * The chequered flag that ends a session: the first one, except in qualifying, which shows one after each segment (Q1,
 * Q2, Q3; SQ1 to SQ3): there the third, so none until the last segment's is out. (Live mode: a qualifying replay's
 * segments come from quali.ts.)
 */
export function endingFlag<T extends { flag: string | null; date: string }>(raceControl: readonly T[], session: { session_type: string }): T | undefined {
  if (session.session_type !== "Qualifying") return raceControl.find((m) => m.flag === "CHEQUERED");
  const flags = raceControl.filter((m) => m.flag === "CHEQUERED").sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
  return flags.length >= 3 ? flags.at(-1) : undefined;
}

export function replayWindow(raw: Pick<RawSessionData, "session" | "laps" | "raceControl">): { lightsOut: number; t0: number; end: number } {
  const practice = isFreePractice(raw.session);
  const lap1Starts = raw.laps.filter((l) => l.lap_number === 1 && l.date_start).map((l) => abs(l.date_start!));
  const firstLap = lap1Starts.length ? Math.min(...lap1Starts) : abs(raw.session.date_start);
  const lightsOut = practice ? (practiceStart(raw.raceControl) ?? firstLap) : firstLap;
  const chequered =
    raw.raceControl.find((m) => m.flag === "CHEQUERED") ??
    (practice ? raw.raceControl.find((m) => m.category === "SessionStatus" && /FINISHED/i.test(m.message)) : undefined);
  const lastLapEnd = Math.max(
    ...raw.laps.filter((l) => l.date_start && l.lap_duration != null).map((l) => abs(l.date_start!) + l.lap_duration! * 1000),
  );
  const end = Math.max((chequered ? abs(chequered.date) : lastLapEnd) + POST_FINISH_MS, lastLapEnd + 30_000);
  return { lightsOut, t0: lightsOut - (practice ? PRACTICE_PRE_MS : PRE_START_MS), end };
}

export function normalize(raw: RawSessionData, opts: NormalizeOptions = {}): NormalizeResult {
  const live = opts.live ?? null;
  const partial = live ? null : (opts.partial ?? null);
  const { session, meeting, circuit } = raw;
  const practice = isFreePractice(session);
  const rawDrivers = raw.drivers;
  // Practice: no lap times for the laps either side of a garage visit (OpenF1's include the time in the garage).
  const rawLaps = practice ? preparePracticeLaps(raw.laps, raw.pits) : raw.laps;
  const rawStints = raw.stints;
  const rawPits = raw.pits;
  const rawPositions = raw.positions;
  const rawIntervals = raw.intervals;
  const rawRaceControl = raw.raceControl;
  const rawWeather = raw.weather;
  const rawRadio = raw.radio;
  const rawOvertakes = raw.overtakes;
  const rawResults = raw.results;
  const warnings: string[] = [];

  const driverNumbers = [...new Set(rawDrivers.map((d) => d.driver_number))].sort((a, b) => a - b);

  // ---------------------------------------------------------------- time window

  const lap1Starts = rawLaps.filter((l) => l.lap_number === 1 && l.date_start).map((l) => abs(l.date_start!));
  const window = { session, laps: rawLaps, raceControl: raw.raceControl };
  // Practice, live: the green light, or until it shows the scheduled start (>= the live edge).
  const green = practice ? practiceStart(raw.raceControl) : null;
  let lightsOutAbs: number;
  if (practice && live) lightsOutAbs = green ?? Math.max(abs(session.date_start), live.now);
  else if (lap1Starts.length || !live) lightsOutAbs = replayWindow(window).lightsOut;
  else {
    // Lap 1 undated but later laps known: back from lap 2's start; else not started yet.
    const lap2 = rawLaps.flatMap((l) => {
      if (l.lap_number !== 2 || !l.date_start) return [];
      const lap1 = rawLaps.find((p) => p.driver_number === l.driver_number && p.lap_number === 1);
      return [abs(l.date_start) - (lap1?.lap_duration ?? 120) * 1000];
    });
    lightsOutAbs = lap2.length ? Math.min(...lap2) : Math.max(abs(session.date_start) + LIGHTS_OUT_AFTER_START_MS, live.now);
  }
  // (Live qualifying: the last segment's flag, not Q1's.)
  const chequeredMsg = live ? endingFlag(rawRaceControl, session) : rawRaceControl.find((m) => m.flag === "CHEQUERED");
  const chequeredAbs = chequeredMsg ? abs(chequeredMsg.date) : null;

  const t0 = live ? live.t0 : lightsOutAbs - (practice ? PRACTICE_PRE_MS : PRE_START_MS);
  const windowEndAbs = live ? Math.max(live.now, t0) : replayWindow(window).end;
  const duration: Ms = windowEndAbs - t0;
  const rel = (iso: string): Ms => abs(iso) - t0;
  const inWindow = (t: Ms) => t >= 0 && t <= duration;
  // Partial telemetry: the spans it covers (ms since t0); whether [from, to] lies in one of them.
  const spans = partial ? partial.telemetry.map((s) => ({ from: s.from - t0, to: s.to - t0 })) : null;
  const covered = (from: Ms, to: Ms) => !spans || spans.some((s) => s.from <= from && to <= s.to);
  /** Partial telemetry: where the span with t in it ends (t if none); else, Infinity. */
  const coveredUntil = (t: Ms) => (spans ? (spans.find((s) => s.from <= t && t <= s.to)?.to ?? t) : Infinity);

  /**
   * Keep events inside the window, plus the last event before it (per key) moved to t = 0,
   * so state at the start of the replay is known (e.g. grid positions, initial weather).
   */
  function clipSteps<T extends { t: Ms }>(events: T[], key: (e: T) => string | number = () => 0): T[] {
    const sorted = [...events].sort(byTime);
    const before = new Map<string | number, T>();
    const kept: T[] = [];
    for (const e of sorted) {
      if (e.t < 0) before.set(key(e), e);
      else if (e.t <= duration) kept.push(e);
    }
    const seeded = [...before.values()].map((e) => ({ ...e, t: 0 }));
    return [...seeded, ...kept].sort(byTime);
  }

  // ---------------------------------------------------------------- telemetry

  let samples = raw.samples;
  if (samples) {
    for (const s of samples.values()) if (s.t0 !== t0) throw new Error(`samples for #${s.driver} use a different t0`);
  } else {
    samples = new Map();
    for (const n of driverNumbers) {
      const s = new DriverSamples(n, t0);
      for (const c of raw.car?.get(n) ?? []) s.addCar(c);
      for (const l of raw.location?.get(n) ?? []) s.addLocation(l);
      samples.set(n, s);
    }
  }

  let staleLoc = 0;
  const telemetry = new Map<number, CleanTelemetry>();
  for (const n of driverNumbers) {
    const { telemetry: tel, stale } = (samples.get(n) ?? new DriverSamples(n, t0)).view(duration);
    staleLoc += stale;
    telemetry.set(n, tel);
  }

  // Location per driver, reused for pit detection and track geometry.
  const locTimes = new Map(driverNumbers.map((n) => [n, telemetry.get(n)!.loc.t]));
  const carTimes = new Map(driverNumbers.map((n) => [n, telemetry.get(n)!.car.t]));

  function meanSpeed(driver: number, from: Ms, to: Ms): number | null {
    const times = carTimes.get(driver) ?? [];
    const speeds = telemetry.get(driver)?.car.speed ?? [];
    let sum = 0;
    let count = 0;
    for (let i = firstAtOrAfter(times, from); i < times.length && times[i] <= to; i++) {
      sum += speeds[i];
      count++;
    }
    return count ? sum / count : null;
  }

  /** Distance travelled (location units, i.e. decimetres) between two times, from the speed trace. */
  const carDistance = new Map<number, number[]>();
  function distanceAt(driver: number, t: Ms): number {
    const times = carTimes.get(driver)!;
    let dist = carDistance.get(driver);
    if (!dist) {
      dist = samples!.get(driver)?.distance() ?? [];
      carDistance.set(driver, dist);
    }
    const i = firstAtOrAfter(times, t);
    if (i === 0 || i >= times.length) return dist[Math.min(i, times.length - 1)] ?? 0;
    return dist[i - 1] + ((t - times[i - 1]) / (times[i] - times[i - 1])) * (dist[i] - dist[i - 1]);
  }
  const travelled = (driver: number, from: Ms, to: Ms) => distanceAt(driver, to) - distanceAt(driver, from);

  function locAt(driver: number, t: Ms): { x: number; y: number } | null {
    const times = locTimes.get(driver)!;
    const { x, y } = telemetry.get(driver)!.loc;
    let i = times.findIndex((ti) => ti >= t);
    if (i <= 0) return null;
    const f = (t - times[i - 1]) / (times[i] - times[i - 1]);
    return { x: x[i - 1] + f * (x[i] - x[i - 1]), y: y[i - 1] + f * (y[i] - y[i - 1]) };
  }

  function slice(driver: number, from: Ms, to: Ms): Polyline {
    const times = locTimes.get(driver) ?? [];
    const loc = telemetry.get(driver)?.loc;
    const out: Polyline = { x: [], y: [], z: [] };
    if (!loc) return out;
    for (let i = firstAtOrAfter(times, from); i < times.length && times[i] <= to; i++) {
      out.x.push(loc.x[i]);
      out.y.push(loc.y[i]);
      out.z.push(loc.z[i]);
    }
    return out;
  }

  // ---------------------------------------------------------------- timing

  const drivers: DriverInfo[] = driverNumbers.map((n) => {
    const d = rawDrivers.find((r) => r.driver_number === n)!;
    return {
      number: n,
      acronym: d.name_acronym,
      fullName: d.full_name,
      broadcastName: d.broadcast_name,
      team: d.team_name ?? "Unknown",
      teamColour: d.team_colour ?? "888888",
      headshotUrl: d.headshot_url,
    };
  });

  // OpenF1 occasionally misses a timing-line crossing (2026 Melbourne: the end of lap 1, for every
  // car). That merges two laps into one record and shifts every later lap number (in laps, pits and
  // stints) by one. Find the crossings in the location trace, split merged records and renumber.

  const LINE_MAX_STEP = 1_500; // location units are decimetres: at most 150 m between two samples
  const LINE_MAX_OFFSET = 1_000; // 100 m either side of the line's centre (covers the pit lane)
  const typicalLapMs = median(rawLaps.flatMap((l) => (l.lap_duration != null ? [l.lap_duration * 1000] : [])));
  const minLapMs = 0.8 * typicalLapMs; // a missed crossing leaves (nearly) a full lap on both sides
  const minLapDistance =
    0.8 *
    median(
      rawLaps.flatMap((l) =>
        l.lap_number > 1 &&
        !l.is_pit_out_lap &&
        l.date_start &&
        l.lap_duration != null &&
        carTimes.get(l.driver_number)?.length &&
        covered(rel(l.date_start), rel(l.date_start) + l.lap_duration * 1000)
          ? [travelled(l.driver_number, rel(l.date_start), rel(l.date_start) + l.lap_duration * 1000)]
          : [],
      ),
    );

  /** The timing line: median car position at lap starts, and the mean heading there. */
  function findTimingLine(): { x: number; y: number; ux: number; uy: number } | null {
    const xs: number[] = [];
    const ys: number[] = [];
    let hx = 0;
    let hy = 0;
    for (const l of rawLaps) {
      if (l.lap_number < 2 || l.is_pit_out_lap || !l.date_start || !locTimes.has(l.driver_number)) continue;
      const times = locTimes.get(l.driver_number)!;
      const { x, y } = telemetry.get(l.driver_number)!.loc;
      const t = rel(l.date_start);
      const i = firstAtOrAfter(times, t);
      if (i === 0 || i >= times.length || times[i] - times[i - 1] > 1_500) continue;
      const f = (t - times[i - 1]) / (times[i] - times[i - 1]);
      const dx = x[i] - x[i - 1];
      const dy = y[i] - y[i - 1];
      xs.push(x[i - 1] + f * dx);
      ys.push(y[i - 1] + f * dy);
      const len = Math.hypot(dx, dy);
      if (len > 0) {
        hx += dx / len;
        hy += dy / len;
      }
    }
    const len = Math.hypot(hx, hy);
    return xs.length >= 20 && len > 0 ? { x: median(xs), y: median(ys), ux: hx / len, uy: hy / len } : null;
  }
  const timingLine = findTimingLine();

  /** Times at which the driver crossed the timing line going forwards. */
  function lineCrossings(driver: number): Ms[] {
    if (!timingLine) return [];
    const { x: px, y: py, ux, uy } = timingLine;
    const times = locTimes.get(driver)!;
    const { x, y } = telemetry.get(driver)!.loc;
    const out: Ms[] = [];
    for (let i = 1; i < times.length; i++) {
      const a = (x[i - 1] - px) * ux + (y[i - 1] - py) * uy;
      const b = (x[i] - px) * ux + (y[i] - py) * uy;
      if (!(a < 0 && b >= 0) || b - a > LINE_MAX_STEP || times[i] - times[i - 1] > 3_000) continue;
      const f = -a / (b - a);
      const offset = -(x[i - 1] + f * (x[i] - x[i - 1]) - px) * uy + (y[i - 1] + f * (y[i] - y[i - 1]) - py) * ux;
      if (Math.abs(offset) < LINE_MAX_OFFSET) out.push(times[i - 1] + f * (times[i] - times[i - 1]));
    }
    return out;
  }

  interface LapSource {
    raw: RawLap | null; // null: a lap OpenF1 merged into the previous record
    start: Ms;
  }
  const crossings = new Map(driverNumbers.map((n) => [n, lineCrossings(n)]));
  let undatedLap1 = 0;
  const ownLaps = new Map(
    driverNumbers.map((n) => {
      const all = rawLaps.filter((l) => l.driver_number === n);
      // Lap 1 starts at lights out for every car, but is occasionally undated.
      const fill = all.some((l) => l.lap_number > 1 && l.date_start);
      const dated = all.flatMap((l) => {
        if (l.date_start) return [l];
        if (l.lap_number !== 1 || !fill) return [];
        undatedLap1++;
        return [{ ...l, date_start: new Date(lightsOutAbs).toISOString() }];
      });
      return [n, dated.sort((a, b) => a.lap_number - b.lap_number)];
    }),
  );
  // OpenF1 occasionally dates a lap's start late (by up to a minute). The previous lap's duration,
  // when a timing-line crossing confirms it, gives the real start.
  let restarted = 0;
  const lapStarts = new Map<number, Ms[]>();
  for (const n of driverNumbers) {
    const own = ownLaps.get(n)!;
    lapStarts.set(
      n,
      own.map((l, i) => {
        const start = Math.round(rel(l.date_start!));
        const prev = own[i - 1];
        if (!prev || prev.lap_duration == null || l.lap_number !== prev.lap_number + 1) return start;
        const prevEnd = rel(prev.date_start!) + prev.lap_duration * 1000;
        if (Math.abs(start - prevEnd) <= 2_000 || !crossings.get(n)!.some((c) => Math.abs(c - prevEnd) < 3_000)) return start;
        restarted++;
        return Math.round(prevEnd);
      }),
    );
  }

  const splitSources = new Map<number, LapSource[]>();
  for (const n of driverNumbers) {
    const own = ownLaps.get(n)!;
    const starts = lapStarts.get(n)!;
    const sources: LapSource[] = [];
    own.forEach((l, i) => {
      const start = starts[i];
      sources.push({ raw: l, start });
      if (i + 1 >= own.length) return;
      const nextStart = starts[i + 1];
      // Could a lap boundary at t split this record into two real laps? (Partial telemetry: only where it's in.)
      const fullLapsAround = (from: Ms, t: Ms) =>
        covered(from, nextStart) &&
        t - from >= minLapMs &&
        nextStart - t >= minLapMs &&
        !(travelled(n, from, t) < minLapDistance) &&
        !(travelled(n, t, nextStart) < minLapDistance);
      let last: Ms = start;
      if (l.lap_duration != null) {
        // A timed record ends where its duration says: consistent with the next start (standing
        // restarts, red-flag laps) means nothing is missing; ending a lap early means OpenF1 lost the
        // next record, even where the location feed has a gap.
        const end = start + l.lap_duration * 1000;
        if (!fullLapsAround(start, end)) return;
        sources.push({ raw: null, start: Math.round(end) });
        last = end;
      }
      // Further missed laps: timing-line crossings with (nearly) a lap driven on both sides; this
      // excludes cars moved along the pit lane under a red flag.
      for (const c of crossings.get(n)!) {
        if (c - last < 3_000 || !fullLapsAround(last, c)) continue;
        sources.push({ raw: null, start: Math.round(c) });
        last = c;
      }
    });
    splitSources.set(n, sources);
  }
  const splitCount = [...splitSources.values()].flat().filter((s) => s.raw == null).length;
  // Crossings inside a lap should be rare; many means the line was misplaced, so trust OpenF1.
  const repairLaps = splitCount > 0 && splitCount <= 0.1 * rawLaps.length;
  if (splitCount > 0 && !repairLaps) warnings.push(`  ignoring ${splitCount} mid-lap timing-line crossings (too many to be missed laps)`);

  /** Per renumbered driver: OpenF1 lap number -> corrected lap number. */
  const lapRenumber = new Map<number, Map<number, number>>();
  const lapSources = new Map<number, LapSource[]>();
  for (const n of driverNumbers) {
    const split = splitSources.get(n)!;
    const own = ownLaps.get(n)!;
    if (repairLaps && split.length > own.length) {
      const renumber = new Map<number, number>();
      split.forEach((s, j) => s.raw && renumber.set(s.raw.lap_number, own[0].lap_number + j));
      lapRenumber.set(n, renumber);
      lapSources.set(n, split);
    } else {
      lapSources.set(n, own.map((l, i) => ({ raw: l, start: lapStarts.get(n)![i] })));
    }
  }

  /** An OpenF1 lap number (pits, stints) in the corrected numbering. */
  function mapLap(driver: number, lap: number): number {
    const renumber = lapRenumber.get(driver);
    if (!renumber) return lap;
    // Anchor on the next known record: a missing record sits right before one.
    const known = [...renumber.keys()].sort((a, b) => a - b);
    const anchor = known.find((k) => k >= lap) ?? known.at(-1)!;
    return renumber.get(anchor)! + (lap - anchor);
  }

  // Classified finishers: OpenF1 lap count and whether later records are cool-down laps.
  const finisherLaps = new Map(
    rawResults.filter((r) => !r.dnf && !r.dns && !r.dsq && r.number_of_laps != null).map((r) => [r.driver_number, r.number_of_laps!]),
  );
  const chequeredRel = chequeredAbs != null ? chequeredAbs - t0 : null;

  const laps: Lap[] = [];
  let droppedCoolDown = 0;
  let finishFromLine = 0;
  for (const n of driverNumbers) {
    const sources = lapSources.get(n)!;
    const renumbered = lapRenumber.has(n);
    const number = (j: number) => (renumbered ? sources[0].raw!.lap_number + j : sources[j].raw!.lap_number);
    const own: Lap[] = sources.map((s, j) => {
      const l = s.raw;
      const next = sources[j + 1];
      // A split record's duration may span both laps.
      const d = l?.lap_duration ?? null;
      const duration = d != null && next?.raw === null && Math.abs(s.start + d * 1000 - next.start) > 3_000 ? null : d;
      const end =
        duration != null ? Math.round(s.start + duration * 1000) : next && number(j + 1) === number(j) + 1 ? next.start : null;
      return {
        driver: n,
        lap: number(j),
        start: s.start,
        end,
        duration,
        sectors: l ? [l.duration_sector_1, l.duration_sector_2, l.duration_sector_3] : [null, null, null],
        segments: l ? [l.segments_sector_1 ?? [], l.segments_sector_2 ?? [], l.segments_sector_3 ?? []] : [[], [], []],
        speedTrap: l ? { i1: l.i1_speed, i2: l.i2_speed, st: l.st_speed } : { i1: null, i2: null, st: null },
        pitOut: l?.is_pit_out_lap ?? false,
      };
    });
    const finalLap = finisherLaps.get(n);
    let afterFlag = 0;
    for (const lap of own) {
      // After the flag: a cool-down lap, only recorded when OpenF1's lap numbers had slipped.
      if (finalLap != null && lap.lap > finalLap && (chequeredRel == null || lap.start >= chequeredRel - 5_000)) {
        droppedCoolDown++;
        continue;
      }
      // Practice: the cool-down lap after the flag is the last; later records are pit-lane crossings to the garage.
      if (practice && chequeredRel != null && lap.start > chequeredRel && afterFlag++ > 0) {
        droppedCoolDown++;
        continue;
      }
      // A finisher's last lap without a duration ends where the car next crosses the line.
      if (lap.lap === finalLap && lap.end == null) {
        const line = crossings
          .get(n)!
          .find(
            (c) =>
              c - lap.start >= minLapMs && c - lap.start <= 3 * typicalLapMs && covered(lap.start, c) && !(travelled(n, lap.start, c) < minLapDistance),
          );
        if (line != null) {
          lap.end = Math.round(line);
          finishFromLine++;
        }
      }
      laps.push(lap);
    }
  }
  laps.sort((a, b) => a.start - b.start || a.driver - b.driver);
  const maxLap = new Map<number, number>();
  for (const l of laps) maxLap.set(l.driver, Math.max(maxLap.get(l.driver) ?? 0, l.lap));

  const stints: Stint[] = rawStints
    .map((s) => {
      const n = s.driver_number;
      // Renumbered drivers: the last stint ran to OpenF1's (one too high) final lap.
      const cap = lapRenumber.has(n) ? (maxLap.get(n) ?? Infinity) : Infinity;
      const lapEnd = Math.min(mapLap(n, s.lap_end), cap);
      return {
        driver: n,
        stint: s.stint_number,
        lapStart: Math.min(mapLap(n, s.lap_start), lapEnd),
        lapEnd,
        compound: s.compound ?? "UNKNOWN",
        ageAtStart: s.tyre_age_at_start ?? 0,
      };
    })
    .sort((a, b) => a.driver - b.driver || a.stint - b.stint);

  // OpenF1 occasionally lists one stop twice (seconds apart, same lane time, a bogus lap number).
  // Real stops are at least a lap apart: keep the record whose lap number matches the car's lap.
  const rawLapAt = (driver: number, t: number) =>
    ownLaps.get(driver)?.filter((l) => abs(l.date_start!) <= t).at(-1)?.lap_number ?? 0;
  const pitLapError = (p: RawPit) => Math.abs(p.lap_number - rawLapAt(p.driver_number, abs(p.date)));
  const uniquePits = rawPits.filter(
    (p, i) =>
      !rawPits.some(
        (q, j) =>
          j !== i &&
          q.driver_number === p.driver_number &&
          Math.abs(abs(q.date) - abs(p.date)) < 0.5 * typicalLapMs &&
          (pitLapError(q) < pitLapError(p) || (pitLapError(q) === pitLapError(p) && j < i)),
      ),
  );

  // OpenF1's pit `date` is not documented as entry or exit. Pick whichever reading puts the
  // pit-lane window at pit-limiter speed across all stops.
  const laneSeconds = (p: RawPit) => p.lane_duration ?? p.pit_duration;
  const pitSpeeds = (dateIsExit: boolean) =>
    uniquePits
      .filter((p) => laneSeconds(p) != null)
      .map((p) => {
        const t = rel(p.date);
        const lane = laneSeconds(p)! * 1000;
        return meanSpeed(p.driver_number, dateIsExit ? t - lane : t, dateIsExit ? t : t + lane);
      })
      .filter((s): s is number => s != null);
  const speedIfExit = median(pitSpeeds(true));
  const speedIfEntry = median(pitSpeeds(false));
  const pitDateIsExit = !(speedIfEntry < speedIfExit);

  const laneMsOf = (p: RawPit) => {
    const lane = laneSeconds(p);
    return lane != null ? Math.round(lane * 1000) : 0;
  };
  const datedPits: PitStop[] = uniquePits.map((p) => {
    const t = Math.round(rel(p.date));
    const laneMs = laneMsOf(p);
    return {
      driver: p.driver_number,
      lap: mapLap(p.driver_number, p.lap_number),
      entry: pitDateIsExit ? t - laneMs : t,
      exit: pitDateIsExit ? t : t + laneMs,
      laneDuration: laneSeconds(p),
      stopDuration: p.stop_duration ?? null,
    };
  });

  // A dropped duplicate may be the only record of a real stop that OpenF1 mis-dated: when the car
  // began a pit-out lap right after that lap, rebuild the stop around its pit-lane line crossing.
  const pitOutStarts = (driver: number) =>
    (ownLaps.get(driver) ?? []).flatMap((l, i) =>
      l.is_pit_out_lap && l.lap_number > 1 ? [{ lap: l.lap_number, start: lapStarts.get(driver)![i] }] : [],
    );
  const pitNear = (driver: number, t: Ms) => datedPits.some((p) => p.driver === driver && p.entry - 5_000 <= t && t <= p.exit + 5_000);
  // Where the pit lane's timing line sits: time from pit entry to crossing it.
  const lineAfterEntry = median(
    datedPits.flatMap((p) => {
      const s = pitOutStarts(p.driver).find((o) => o.start >= p.entry - 5_000 && o.start <= p.exit + 5_000);
      return s ? [s.start - p.entry] : [];
    }),
  );
  const recoveredPits: PitStop[] = rawPits
    .filter((p) => !uniquePits.includes(p))
    .flatMap((p) => {
      // Stops are numbered with the lap before or the pit-out lap itself, depending on the track.
      const out = pitOutStarts(p.driver_number).find((o) => o.lap === p.lap_number || o.lap === p.lap_number + 1);
      if (!out || pitNear(p.driver_number, out.start)) return [];
      const laneMs = laneMsOf(p);
      const entry = Math.round(out.start - (Number.isFinite(lineAfterEntry) ? lineAfterEntry : laneMs / 2));
      return [
        {
          driver: p.driver_number,
          lap: mapLap(p.driver_number, p.lap_number),
          entry,
          exit: entry + laneMs,
          laneDuration: laneSeconds(p),
          stopDuration: p.stop_duration ?? null,
        },
      ];
    });
  const pits: PitStop[] = [...datedPits, ...recoveredPits].sort((a, b) => a.entry - b.entry);

  const lightsOut: Ms = lightsOutAbs - t0;
  const chequered: Ms | null = chequeredAbs != null ? chequeredAbs - t0 : null;

  const allRaceControl: RaceControlMsg[] = rawRaceControl
    .map((m) => ({
      t: Math.round(rel(m.date)),
      lap: m.lap_number,
      category: m.category,
      flag: m.flag,
      scope: m.scope,
      sector: m.sector,
      driver: m.driver_number,
      message: m.message,
    }))
    .sort(byTime);
  // Keep messages after the window too: stewards' post-race decisions (penalties) arrive then.
  const raceControl = allRaceControl.filter((m) => m.t >= 0);

  // Practice: in-laps end at the pit entry, deleted lap times, and the timing screen's order by best lap.
  let practiceTiming: { positions: PositionEvent[]; intervals: IntervalEvent[] } | null = null;
  if (practice) {
    const lapsOf = new Map<number, Lap[]>(driverNumbers.map((n) => [n, []]));
    for (const l of laps) lapsOf.get(l.driver)?.push(l);
    for (const own of lapsOf.values()) own.sort((a, b) => a.lap - b.lap);
    endInLapsAtPitEntry(lapsOf, pits);
    const { deleted } = deletedLaps(allRaceControl, lapsOf, session.gmt_offset, t0);
    for (const l of laps) {
      const d = deleted.get(`${l.driver}:${l.lap}`);
      if (d) l.deleted = d;
    }
    practiceTiming = practiceStandings(laps, driverNumbers);
  }

  const positions: PositionEvent[] = practiceTiming?.positions ?? clipSteps(
    rawPositions.map((raw) =>
      derive(derivedPositions, raw, t0, (p) => ({ t: Math.round(rel(p.date)), driver: p.driver_number, position: p.position })),
    ),
    (e) => e.driver,
  );

  const intervals: IntervalEvent[] = practiceTiming?.intervals ?? clipSteps(
    rawIntervals.map((raw) =>
      derive(derivedIntervals, raw, t0, (i) => ({
        t: Math.round(rel(i.date)),
        driver: i.driver_number,
        gapToLeader: i.gap_to_leader,
        interval: i.interval,
      })),
    ),
    (e) => e.driver,
  );

  // ---------------------------------------------------------------- track status

  function statusFor(m: RaceControlMsg): TrackStatus | null {
    const msg = m.message.toUpperCase();
    if (m.category === "SafetyCar") {
      // "VIRTUAL SAFETY CAR DEPLOYED" until 2025, "VSC DEPLOYED" from 2026.
      if (msg.includes("VIRTUAL") || /\bVSC\b/.test(msg)) {
        if (msg.includes("ENDING")) return "VSC_ENDING";
        if (msg.includes("DEPLOYED")) return "VSC";
        return null;
      }
      if (msg.includes("IN THIS LAP")) return "SC_ENDING";
      if (msg.includes("DEPLOYED")) return "SC";
      return null;
    }
    // Flag "RED" until 2025; from 2026 an "Other" message "RED FLAG - RACE SUSPENDED".
    if (m.flag === "RED" || msg.startsWith("RED FLAG")) return "RED";
    if (m.category === "Flag" && m.scope === "Track") {
      if (m.flag === "CHEQUERED") return "CHEQUERED";
      if (m.flag === "GREEN" || m.flag === "CLEAR") return "GREEN";
    }
    return null;
  }

  /** Driver in P1 at time t. */
  function leaderAt(t: Ms): number | null {
    let leader: number | null = null;
    for (const p of positions) {
      if (p.t > t) break;
      if (p.position === 1) leader = p.driver;
    }
    return leader;
  }

  const statusEvents: TrackStatusEvent[] = [];
  let currentStatus: TrackStatus = "GREEN";
  let scAtRestart = false;
  // Live qualifying: a flag ends a segment and the next one starts green (a replay's segments: quali.ts).
  const segmented = live != null && session.session_type === "Qualifying";
  for (const m of allRaceControl) {
    const msg = m.message.toUpperCase();
    if (currentStatus === "CHEQUERED") {
      if (!segmented) break; // e.g. TRACK CLEAR after the flag is not a green-flag phase
      if (m.category === "SessionStatus" && /STARTED/.test(msg)) {
        statusEvents.push({ t: m.t, status: "GREEN" });
        currentStatus = "GREEN";
      }
      continue;
    }
    let status = statusFor(m);
    if (currentStatus === "RED") {
      // TRACK CLEAR while the cars wait in the pit lane is not a restart. The race resumes with the
      // pit exit opening or the session (re)starting, behind the safety car if it was called.
      if (status === "SC" || status === "VSC" || msg.includes("SAFETY CAR LIGHTS ON")) scAtRestart = true;
      const restart = (status === "GREEN" && m.flag === "GREEN") || (m.category === "SessionStatus" && /STARTED|RESUMED/.test(msg));
      status = restart ? (scAtRestart ? "SC" : "GREEN") : status === "CHEQUERED" ? status : null;
    } else if (currentStatus === "SC" && msg === "STANDING START") {
      status = "SC_ENDING"; // the safety car leads the field to the grid for a standing restart
    }
    if (!status) continue;
    if (status === "RED") scAtRestart = false;
    statusEvents.push({ t: m.t, status });
    currentStatus = status;
  }
  // Close "ending" phases that have no explicit green message after them.
  for (let i = 0; i < statusEvents.length; i++) {
    const e = statusEvents[i];
    const next = statusEvents[i + 1];
    let greenAt: Ms | null = null;
    if (e.status === "VSC_ENDING") greenAt = e.t + VSC_ENDING_MS;
    if (e.status === "SC_ENDING") {
      // The safety car pits at the end of the lap: green when the leader next crosses the line.
      const leader = leaderAt(e.t);
      greenAt = laps.find((l) => l.driver === leader && l.start > e.t)?.start ?? null;
    }
    if (greenAt != null && (!next || next.t > greenAt)) {
      statusEvents.splice(i + 1, 0, { t: greenAt, status: "GREEN" });
    }
  }
  const trackStatus = clipSteps([{ t: -1, status: "GREEN" as TrackStatus }, ...statusEvents]).filter(
    (e, i, arr) => i === 0 || arr[i - 1].status !== e.status,
  );

  // ---------------------------------------------------------------- the rest

  const weather: WeatherSample[] = clipSteps(
    rawWeather.map((w) => ({
      t: Math.round(rel(w.date)),
      airTemp: w.air_temperature,
      trackTemp: w.track_temperature,
      humidity: w.humidity,
      pressure: w.pressure,
      rainfall: w.rainfall,
      windSpeed: w.wind_speed,
      windDirection: w.wind_direction,
    })),
  );

  const radio = rawRadio
    .map((r) => ({ t: Math.round(rel(r.date)), driver: r.driver_number, url: r.recording_url }))
    .filter((r) => inWindow(r.t))
    .sort(byTime);

  const overtakes = rawOvertakes
    .map((o) => ({
      t: Math.round(rel(o.date)),
      overtaker: o.overtaking_driver_number,
      overtaken: o.overtaken_driver_number,
      position: o.position,
    }))
    .filter((o) => inWindow(o.t))
    .sort(byTime);

  /** Last time the car moved; retired cars keep streaming (stationary) positions afterwards. */
  function lastMoving(driver: number): Ms {
    const times = carTimes.get(driver) ?? [];
    const speeds = telemetry.get(driver)?.car.speed ?? [];
    for (let i = times.length - 1; i >= 0; i--) if (speeds[i] > 10) return times[i];
    return 0;
  }
  /** When a car that didn't finish stopped; partial telemetry: null until it's been seen standing after that. */
  function retiredAt(driver: number): Ms | null {
    const t = lastMoving(driver);
    return covered(t, t + RETIRED_SEEN_MS) ? t : null;
  }

  const results: Result[] = rawResults
    .map((r) => {
      const finished = !r.dnf && !r.dns && !r.dsq;
      const finalLap = laps.find((l) => l.driver === r.driver_number && l.lap === r.number_of_laps);
      const d = lastNumber(r.duration);
      return {
        driver: r.driver_number,
        position: r.position,
        // null for disqualified drivers: count their completed laps instead.
        laps: r.number_of_laps ?? Math.max(0, ...laps.filter((l) => l.driver === r.driver_number && l.end != null).map((l) => l.lap)),
        points: r.points ?? 0,
        dnf: r.dnf,
        dns: r.dns,
        dsq: r.dsq,
        duration: typeof d === "number" ? d : null,
        gapToLeader: lastNumber(r.gap_to_leader),
        // (Practice has no finish: cars drive back to the garage.)
        finish: finished && !practice ? (finalLap?.end ?? null) : null,
        retired: r.dnf || r.dns ? retiredAt(r.driver_number) : null,
      };
    })
    .sort((a, b) => (a.position ?? 99) - (b.position ?? 99));

  const grid = (practice ? [] : driverNumbers)
    .map((n) => {
      const p = positions.filter((e) => e.driver === n && e.t <= lightsOut).at(-1);
      return p ? { driver: n, position: p.position } : null;
    })
    .filter((g): g is { driver: number; position: number } => g != null)
    .sort((a, b) => a.position - b.position);

  // ---------------------------------------------------------------- track geometry

  function statusDuring(from: Ms, to: Ms): boolean {
    let current: TrackStatus = "GREEN";
    for (const e of trackStatus) {
      if (e.t > to) break;
      if (e.t <= from) current = e.status;
      else if (e.status !== "GREEN") return false;
    }
    return current === "GREEN";
  }

  const inLaps = new Set(pits.map((p) => `${p.driver}:${p.lap}`));
  /** A usable outline: dense (the feed is ~3.7 Hz), no jumps, and ending where it started. */
  function plausibleTrace(trace: Polyline, seconds: number): boolean {
    const n = trace.x.length;
    if (n <= 2.5 * seconds) return false;
    for (let i = 1; i < n; i++) if (Math.hypot(trace.x[i] - trace.x[i - 1], trace.y[i] - trace.y[i - 1]) > 1_500) return false;
    return Math.hypot(trace.x[n - 1] - trace.x[0], trace.y[n - 1] - trace.y[0]) < 2_000;
  }
  const isClean = (l: Lap) =>
    l.lap > 1 &&
    l.duration != null &&
    l.end != null &&
    !l.pitOut &&
    !inLaps.has(`${l.driver}:${l.lap}`) &&
    statusDuring(l.start, l.end) &&
    plausibleTrace(slice(l.driver, l.start, l.end), l.duration);
  const pinned = live?.referenceLap ?? partial?.referenceLap;
  const pinnedLap = pinned ? laps.find((l) => l.driver === pinned.driver && l.lap === pinned.lap) : undefined;
  const refLap =
    pinnedLap && isClean(pinnedLap)
      ? pinnedLap
      : laps.filter(isClean).reduce<Lap | null>((best, l) => (!best || l.duration! < best.duration! ? l : best), null);
  if (!refLap && !live && !partial) throw new Error("No clean lap found to build the track outline");

  // Live (or partial), before any clean lap: the MultiViewer circuit trace (same frame, starts at the line).
  const outline: Polyline = refLap
    ? slice(refLap.driver, refLap.start, refLap.end!)
    : { x: [...(circuit?.x ?? [])], y: [...(circuit?.y ?? [])], z: (circuit?.x ?? []).map(() => 0) };
  const s1 = refLap?.sectors[0] ?? null;
  const s2 = refLap?.sectors[1] ?? null;
  const sectorMarks = refLap
    ? [s1, s1 != null && s2 != null ? s1 + s2 : null]
        .map((s) => (s != null ? locAt(refLap.driver, refLap.start + s * 1000) : null))
        .filter((p): p is { x: number; y: number } => p != null)
    : [];

  // The median-length stop that has a location trace (the feed can have gaps) draws the pit lane. (Practice: of the
  // passes through the pit lane, not the visits to the garage.)
  const passes = pits.filter((p) => p.laneDuration != null && p.laneDuration < 60);
  const pitTraces = (practice && passes.length ? passes : pits)
    .filter((p) => p.laneDuration != null)
    .sort((a, b) => a.laneDuration! - b.laneDuration!)
    .map((p) => slice(p.driver, p.entry - 2_000, p.exit + 2_000))
    .filter((trace) => trace.x.length >= 20);
  const pitLane = pitTraces[Math.floor(pitTraces.length / 2)] ?? null;

  function nearestOutlineIndex(x: number, y: number): number {
    let best = 0;
    let bestDist = Infinity;
    for (let i = 0; i < outline.x.length; i++) {
      const d = (outline.x[i] - x) ** 2 + (outline.y[i] - y) ** 2;
      if (d < bestDist) {
        bestDist = d;
        best = i;
      }
    }
    return best;
  }

  const marshalStarts = (outline.x.length ? (circuit?.marshalSectors ?? []) : [])
    .map((s) => ({ number: s.number, start: nearestOutlineIndex(s.trackPosition.x, s.trackPosition.y) }))
    .sort((a, b) => a.number - b.number);
  const marshalSectors = marshalStarts.map((s, i) => ({
    number: s.number,
    from: s.start,
    to: marshalStarts[(i + 1) % marshalStarts.length].start,
  }));
  const corners = (circuit?.corners ?? []).map((c) => ({
    number: c.number,
    x: c.trackPosition.x,
    y: c.trackPosition.y,
    angle: c.angle,
  }));
  const pitLoss = circuit?.pitLoss
    ? { normal: Number(circuit.pitLoss.normal), sc: Number(circuit.pitLoss.sc), vsc: Number(circuit.pitLoss.vsc) }
    : null;

  const allX = [...outline.x, ...(pitLane?.x ?? [])];
  const allY = [...outline.y, ...(pitLane?.y ?? [])];
  const track: TrackGeometry = {
    outline,
    pitLane,
    sectorMarks,
    bounds: allX.length
      ? { minX: Math.min(...allX), maxX: Math.max(...allX), minY: Math.min(...allY), maxY: Math.max(...allY) }
      : { minX: 0, maxX: 0, minY: 0, maxY: 0 },
    referenceLap: refLap ? { driver: refLap.driver, lap: refLap.lap, duration: refLap.duration! } : { driver: 0, lap: 0, duration: 0 },
    rotation: circuit?.rotation ?? 0,
    corners,
    marshalSectors,
    pitLoss,
  };

  // ---------------------------------------------------------------- location gaps

  // OpenF1's location feed has gaps: it stops six minutes into 2026 Monaco, and 2026 Hungary only has
  // a fresh fix every ~5 s. Where a car has no fix for over LOC_GAP_MS, move it along the track
  // outline at the pace of its speed trace: between two fixes, from one to the other; after the last
  // fix of a feed, lap by lap, so that the car reaches the line as each lap ends.
  // The outline as a closed loop, so a lap ends where the next one starts.
  const loop = { x: [...outline.x, outline.x[0]], y: [...outline.y, outline.y[0]], z: [...outline.z, outline.z[0]] };
  const loopS: number[] = [0];
  for (let i = 1; i < loop.x.length; i++) loopS.push(loopS[i - 1] + Math.hypot(loop.x[i] - loop.x[i - 1], loop.y[i] - loop.y[i - 1]));
  const outlineLength = loopS.at(-1)!;
  // Outline length per unit of distance driven (the racing line is not the outline's line).
  const outlinePerDistance = Number.isFinite(minLapDistance) && minLapDistance > 0 ? (0.8 * outlineLength) / minLapDistance : 1;

  function outlineAt(s: number): { x: number; y: number; z: number } {
    const wrapped = ((s % outlineLength) + outlineLength) % outlineLength;
    const i = clamp(firstAtOrAfter(loopS, wrapped), 1, loopS.length - 1);
    const f = clamp((wrapped - loopS[i - 1]) / (loopS[i] - loopS[i - 1] || 1), 0, 1);
    const lerp = (a: number[]) => Math.round(a[i - 1] + f * (a[i] - a[i - 1]));
    return { x: lerp(loop.x), y: lerp(loop.y), z: lerp(loop.z) };
  }

  /** Arc length of the point on the outline loop nearest to (x, y). */
  function outlinePosition(x: number, y: number): number {
    let best = 0;
    let bestDist = Infinity;
    for (let i = 1; i < loop.x.length; i++) {
      const dx = loop.x[i] - loop.x[i - 1];
      const dy = loop.y[i] - loop.y[i - 1];
      const f = clamp(((x - loop.x[i - 1]) * dx + (y - loop.y[i - 1]) * dy) / (dx * dx + dy * dy || 1), 0, 1);
      const d = (loop.x[i - 1] + f * dx - x) ** 2 + (loop.y[i - 1] + f * dy - y) ** 2;
      if (d < bestDist) {
        bestDist = d;
        best = loopS[i - 1] + f * (loopS[i] - loopS[i - 1]);
      }
    }
    return best;
  }

  let deadReckoned = 0;
  const deadReckonedDrivers = new Set<number>();
  for (const n of driverNumbers) {
    const own = laps.filter((l) => l.driver === n); // sorted by start
    const result = results.find((r) => r.driver === n);
    // Live: a running car's feed ends at its latest car sample, the live edge.
    const edge = live ? (carTimes.get(n)!.at(-1) ?? null) : (own.at(-1)?.end ?? null);
    const until = result?.finish ?? result?.retired ?? edge;
    if (!own.length || until == null || outlineLength <= 0) continue;
    const trailingGap = live && result?.finish == null && result?.retired == null ? LIVE_EDGE_GAP_MS : LOC_GAP_MS;

    // Gaps between fixes (indices into the fixes; -1 = no fix at that end).
    const times = locTimes.get(n)!;
    const gaps: { from: Ms; to: Ms; a: number; b: number }[] = [];
    let prev = own[0].start;
    let prevIndex = -1;
    for (let i = 0; i < times.length; i++) {
      const t = times[i];
      if (t <= prev) {
        if (t >= own[0].start - LOC_GAP_MS) prevIndex = i; // a fix just before the first lap anchors it
        prev = Math.max(prev, t);
        continue;
      }
      if (t >= until) break;
      // (Partial telemetry: not a gap where the fixes in between just aren't in yet.)
      if (t - prev > LOC_GAP_MS && covered(prev, t)) gaps.push({ from: prev, to: t, a: prevIndex, b: i });
      prev = t;
      prevIndex = i;
    }
    // After the last fix: up to where telemetry ends, when only some is in.
    const tail = Math.min(until, coveredUntil(prev));
    if (tail - prev > trailingGap) gaps.push({ from: prev, to: tail, a: prevIndex, b: -1 });
    if (!gaps.length) continue;

    const ct = carTimes.get(n)!;
    const distAt = (t: Ms) => distanceAt(n, t);
    const { x, y } = telemetry.get(n)!.loc;

    const synth: { t: Ms; x: number; y: number; z: number }[] = [];
    let li = 0;
    for (const { from, to, a, b } of gaps) {
      const driven = distAt(to) - distAt(from);
      let sa = NaN;
      let sb = NaN;
      if (a >= 0 && b >= 0 && driven >= 0) {
        sa = outlinePosition(x[a], y[a]);
        const sb0 = outlinePosition(x[b], y[b]);
        // Whole laps in between: whatever brings the outline distance closest to the distance driven.
        sb = sb0 + Math.round((sa + driven * outlinePerDistance - sb0) / outlineLength) * outlineLength;
      }
      for (let i = firstAtOrAfter(ct, from + 1); i < ct.length && ct[i] < to; i++) {
        const t = ct[i];
        if (!Number.isNaN(sb)) {
          const f = driven > 0 ? (distAt(t) - distAt(from)) / driven : 0;
          synth.push({ t, ...outlineAt(sa + f * (sb - sa)) });
          continue;
        }
        while (li + 1 < own.length && own[li + 1].start <= t) li++;
        const lap = own[li];
        // (Partial telemetry: not across a gap, where the distance driven isn't known.)
        if (lap.start > t || !covered(lap.start, t)) continue;
        const done = distAt(t) - distAt(lap.start);
        const whole = lap.end != null && t <= lap.end && covered(lap.start, lap.end);
        const lapDist = whole ? distAt(lap.end!) - distAt(lap.start) : 0;
        // A lap still running (live), or whose end isn't in yet (partial): scale the distance driven to the outline.
        const along = live || (spans && !whole) ? done * outlinePerDistance : done;
        synth.push({ t, ...outlineAt(lapDist > 0 ? (done / lapDist) * outlineLength : Math.min(along, outlineLength * 0.999)) });
      }
    }
    if (!synth.length) continue;

    // Both sorted by time (synthetic samples fill gaps between real ones): merge, real first on ties.
    const tel = telemetry.get(n)!;
    const loc = tel.loc;
    const merged: CleanTelemetry["loc"] = { t: [], x: [], y: [], z: [] };
    for (let a = 0, b = 0; a < times.length || b < synth.length; ) {
      if (b >= synth.length || (a < times.length && times[a] <= synth[b].t)) {
        merged.t.push(times[a]);
        merged.x.push(loc.x[a]);
        merged.y.push(loc.y[a]);
        merged.z.push(loc.z[a++]);
      } else {
        const r = synth[b++];
        merged.t.push(r.t);
        merged.x.push(r.x);
        merged.y.push(r.y);
        merged.z.push(r.z);
      }
    }
    telemetry.set(n, { ...tel, loc: merged });
    deadReckoned += synth.length;
    deadReckonedDrivers.add(n);
  }

  // ---------------------------------------------------------------- race distance

  let totalLaps: number;
  let totalLapsEstimated = false;
  const maxLapSeen = Math.max(0, ...laps.map((l) => l.lap));
  if (practice) {
    // No race distance: the most laps anyone has done.
    totalLaps = maxLapSeen;
  } else if (!live) {
    totalLaps = Math.max(...results.map((r) => r.laps), 0) || Math.max(...laps.map((l) => l.lap));
  } else if (chequered != null) {
    // After the flag: the winner's laps, from the results once published, else from the timing.
    const byFlag = Math.max(0, ...laps.filter((l) => l.end != null && l.end <= chequered + 5_000).map((l) => l.lap));
    totalLaps = Math.max(...results.map((r) => r.laps), 0) || byFlag || maxLapSeen;
  } else {
    const driven = minLapDistance / 0.8;
    totalLaps = Math.max(
      estimateTotalLaps(session, { circuit: circuitTraceLength(circuit), outline: refLap ? outlineLength : null, driven }),
      maxLapSeen,
    );
    totalLapsEstimated = true;
  }

  // ---------------------------------------------------------------- meta

  const meta: SessionMeta = {
    version: 1,
    sessionKey: session.session_key,
    meetingKey: session.meeting_key,
    meetingName: meeting?.meeting_name ?? `${session.country_name} Grand Prix`,
    sessionName: session.session_name,
    year: session.year,
    circuit: session.circuit_short_name,
    country: venueCountry(session),
    gmtOffset: session.gmt_offset,
    t0: new Date(t0).toISOString(),
    duration,
    lightsOut,
    chequered,
    totalLaps,
    drivers,
    grid,
    laps,
    stints,
    pits,
    positions,
    intervals,
    trackStatus,
    raceControl,
    weather,
    radio,
    overtakes,
    results,
    track,
    ...(live ? { totalLapsEstimated, lightsOutEstimated: practice ? green == null : lap1Starts.length === 0 } : {}),
    ...(practice ? { practice: { scheduledEnd: abs(session.date_end) - t0 } } : {}),
  };

  return {
    meta,
    telemetry,
    report: {
      warnings,
      lapRenumbered: lapRenumber.size,
      splitCount,
      undatedLap1,
      restarted,
      droppedCoolDown,
      finishFromLine,
      staleLoc,
      deadReckoned,
      deadReckonedDrivers: deadReckonedDrivers.size,
      deadReckonedNumbers: [...deadReckonedDrivers],
      rawPits: rawPits.length,
      uniquePits: uniquePits.length,
      recoveredPits: recoveredPits.length,
      timingLineFound: timingLine != null,
      pitDateIsExit,
      speedIfExit,
      speedIfEntry,
      refLap,
      locFixes: locTimes,
    },
  };
}
