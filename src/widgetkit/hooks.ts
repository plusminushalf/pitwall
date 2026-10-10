// The widget hooks (H3.3), built on the replay store and its shared 10 Hz race state.
// Every hook reads through useKit(): the hook's spoiler-free value, an optional `select` from the widget
// on top, and an equality check, so a widget re-renders only when what it selected changed, and not at
// all while it's off screen.

import { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type Dispatch, type SetStateAction } from "react";
import type { Session } from "../data/session";
import type { DecodedLap } from "../engine/compare";
import { lapGeometryOf, lapTraceOf, liveLapOf, type LapGeometry, type LiveLap } from "../engine/lapTrace";
import { lapWindowIn, type LapWindow } from "../engine/lapWindow";
import { qualiPhaseAt, type QualiPhase } from "../engine/qualiPhase";
import { raceDistanceAt } from "../engine/raceDistance";
import { telemetryAt, type DriverState, type RaceState, type SectorFlag, type Telemetry } from "../engine/raceState";
import { SPEEDS, useReplay } from "../store";
import type { DriverInfo, Lap, PitStop, TrackStatus, WeatherSample } from "../types";
import { CardStateContext, SettingsContext, SizeContext, VisibilityContext, type WidgetSize, type Visibility } from "./context";
import type { WidgetSettings } from "./defineWidget";
import { deepEqual } from "./equal";
import { addFrameCallback, type DrawFn } from "./frame";
import { playRadio, stopRadio, useRadioState } from "./radio";
import {
  allLapsAt,
  allPitsAt,
  allStintsAt,
  bestSectorsAt,
  driversOf,
  feedEndAt,
  feedUpTo,
  historyOf,
  historyRange,
  lapsAt,
  neutralPeriodsAt,
  orderOf,
  pitsAt,
  positionsOf,
  selectedDriverOf,
  sessionInfoOf,
  stintsAt,
  trackOf,
  wholeSessionOf,
  type CarHistory,
  type FeedEntry,
  type NeutralPeriod,
  type SessionInfo,
  type StintView,
  type Track,
  type WholeSession,
} from "./select";

type ReplayState = ReturnType<typeof useReplay.getState>;
/** The store with a race loaded: widgets are only mounted then (WidgetHost). */
type Loaded = ReplayState & { session: Session; race: RaceState };

/** A widget's optional pick from a hook's value: the widget re-renders only when the pick changes. */
export type Select<T, R> = (value: T) => R;

const ALWAYS_VISIBLE: Visibility = { current: true, set() {}, subscribe: () => () => {} };
const IDENTITY = <T,>(v: T) => v;

/**
 * `base` over the store (the hook's own, spoiler-free value; `deps` are what it depends on), then the
 * widget's `pick`, kept while deepEqual says the result is unchanged. The pick lives in a ref: an inline
 * arrow neither resubscribes nor defeats the cache. Store updates are ignored while the widget is off
 * screen (it catches up when it's back). With no race loaded (a widget about to unmount) the last value stays.
 */
function useKit<T, R = T>(base: (s: Loaded) => T, deps: readonly unknown[], pick?: Select<T, R>): R {
  const visibility = useContext(VisibilityContext) ?? ALWAYS_VISIBLE;
  // `base` is a new closure every render; `deps` say when it actually reads something else.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the caller's deps say when base reads something else
  const baseRef = useMemo(() => base, deps);
  const pickRef = useRef(pick);
  pickRef.current = pick;
  const cache = useRef<{ state: ReplayState; base: unknown; pick: unknown; value: R } | null>(null);
  const subscribe = useCallback(
    (onChange: () => void) => {
      const ifVisible = () => visibility.current && onChange();
      const offStore = useReplay.subscribe(ifVisible);
      const offVisibility = visibility.subscribe(ifVisible);
      return () => {
        offStore();
        offVisibility();
      };
    },
    [visibility],
  );
  const getSnapshot = (): R => {
    const state = useReplay.getState();
    const p = pickRef.current;
    const c = cache.current;
    if (c && c.state === state && c.base === baseRef && c.pick === p) return c.value;
    if (!state.session || !state.race) {
      if (c) return c.value;
      throw new Error("widget-kit hooks need a loaded race: render widgets inside a WidgetHost");
    }
    const value = (p ?? (IDENTITY as Select<T, R>))(baseRef(state as Loaded));
    if (c && deepEqual(c.value, value)) {
      c.state = state;
      c.base = baseRef;
      c.pick = p;
      return c.value;
    }
    cache.current = { state, base: baseRef, pick: p, value };
    return value;
  };
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** `pick` applied only to a value that's there: hooks about one car return null for a car with no data. */
const orNull =
  <T, R>(pick?: Select<T, R>): Select<T | null, R | T | null> | undefined =>
  (v) => (v == null ? null : pick ? pick(v) : v);

// ---------------------------------------------------------------- time and playback

/**
 * Replay time (ms since the session window start), updated at most 10 times a second. A `select` can
 * coarsen it (e.g. t => Math.floor(t / 1000)) so the widget re-renders only when that changes.
 */
export function useTime<R = number>(select?: Select<number, R>): R {
  return useKit((s) => s.t, [], select);
}

/**
 * Calls `draw` every animation frame with the exact time, without re-rendering. The latest `draw` is
 * used each frame. Paused while the widget is off screen; a slow draw skips its own frames.
 */
export function useFrame(draw: DrawFn): void {
  const visibility = useContext(VisibilityContext);
  const ref = useRef(draw);
  useLayoutEffect(() => {
    ref.current = draw;
  });
  useEffect(() => addFrameCallback(ref, () => visibility?.current ?? true), [visibility]);
}

export interface Playback {
  /** Playing, or following a live session. */
  playing: boolean;
  speed: number;
  speeds: readonly number[];
  play: () => void;
  pause: () => void;
  seek: (t: number) => void;
  /** Just before the leader starts lap n. */
  seekToLap: (lap: number) => void;
  setSpeed: (speed: number) => void;
}

const playbackActions = {
  // Like the P key: playback that stays on (not a hold that ends on release).
  play: () => {
    const s = useReplay.getState();
    if ((s.mode === "live" && s.followLive) || s.latched) return;
    s.togglePlay();
  },
  pause: () => {
    const s = useReplay.getState();
    // Following live, pausing freezes the picture (stops following).
    if (s.mode === "live" && s.followLive) s.togglePlay();
    else s.setPlaying(false);
  },
  seek: (t: number) => useReplay.getState().seek(t),
  seekToLap: (lap: number) => useReplay.getState().seekToLap(lap),
  setSpeed: (speed: number) => useReplay.getState().setSpeed(speed),
};

/** Playing state, speed and the playback actions (the actions never change). */
export function usePlayback<R = Playback>(select?: Select<Playback, R>): R {
  return useKit((s): Playback => ({ playing: s.playing || (s.mode === "live" && s.followLive), speed: s.speed, speeds: SPEEDS, ...playbackActions }), [], select);
}

// ---------------------------------------------------------------- session info (fixed for the session)

/** Drivers in the session (names, teams, colours, headshots), in session order. */
export function useDrivers<R = readonly DriverInfo[]>(select?: Select<readonly DriverInfo[], R>): R {
  return useKit((s) => driversOf(s.session), [], select);
}

/** Circuit outline, pit lane, corners, sector marks and marshal sectors. */
export function useTrack<R = Track>(select?: Select<Track, R>): R {
  return useKit((s) => trackOf(s.session.meta.track), [], select);
}

export function useSessionInfo<R = SessionInfo>(select?: Select<SessionInfo, R>): R {
  return useKit((s) => sessionInfoOf(s.session.meta), [], select);
}

// ---------------------------------------------------------------- the race at t (spoiler-free)
// One hook per thing, so a widget re-renders only for what it reads (H3.2).

/** The lap the leader is on (0 before the start). */
export function useLeaderLap<R = number>(select?: Select<number, R>): R {
  return useKit((s) => s.race.leaderLap, [], select);
}

/**
 * Race distance in laps as known at t: the scheduled distance until race control takes laps off or the
 * chequered flag ends a shortened race (live: estimated until it's known, see useSessionInfo().totalLapsEstimated).
 * Practice and qualifying have no distance: the most laps anyone has started (the leader's lap).
 */
export function useTotalLaps<R = number>(select?: Select<number, R>): R {
  return useKit((s) => (s.session.meta.practice || s.session.meta.qualiLive ? s.race.leaderLap : raceDistanceAt(s.session.meta, s.race.t).totalLaps), [], select);
}

/**
 * API gap: live qualifying at t, the segment running (Q1, Q2, Q3), its clock and the cut. Null in other sessions
 * (a finished qualifying session has its own screen, not widgets).
 */
export function useQualiPhase<R = QualiPhase | null>(select?: Select<QualiPhase | null, R>): R {
  return useKit((s) => (s.session.meta.qualiLive ? qualiPhaseAt(s.session.meta, s.race.t) : null), [], select);
}

export function useTrackStatus<R = TrackStatus>(select?: Select<TrackStatus, R>): R {
  return useKit((s) => s.race.trackStatus, [], select);
}

/** Marshal sector -> flag, for sectors under yellow or red. */
export function useSectorFlags<R = ReadonlyMap<number, SectorFlag>>(select?: Select<ReadonlyMap<number, SectorFlag>, R>): R {
  return useKit((s) => s.race.sectorFlags, [], select);
}

/** Latest weather sample at the circuit, or null before the first. */
export function useWeather<R = WeatherSample | null>(select?: Select<WeatherSample | null, R>): R {
  return useKit((s) => s.race.weather, [], select);
}

/** Fastest completed lap so far, by anyone. */
export function useFastestLap<R = Lap | null>(select?: Select<Lap | null, R>): R {
  return useKit((s) => s.race.fastestLap, [], select);
}

/** Driver numbers in timing-tower order (retired cars last). */
export function useRunningOrder<R = readonly number[]>(select?: Select<readonly number[], R>): R {
  return useKit((s) => orderOf(s.race), [], select);
}

/** API gap: every car's position at once (the track map labels every car). */
export function usePositions<R = ReadonlyMap<number, number | null>>(select?: Select<ReadonlyMap<number, number | null>, R>): R {
  return useKit((s) => positionsOf(s.race), [], select);
}

/** Position, gaps, tyres, laps and status of car n at t; null if it isn't in the session. */
export function useDriver<R = DriverState>(n: number | null, select?: Select<DriverState, R>): R | null {
  return useKit((s) => (n == null ? null : (s.race.drivers.find((d) => d.driver === n) ?? null)), [n], orNull(select)) as R | null;
}

/** Telemetry samples shared by every widget this 10 Hz tick. */
let telemetryCache: { session: Session; t: number; byDriver: Map<number, Telemetry | null> } | null = null;

function telemetryOf(session: Session, n: number, t: number): Telemetry | null {
  if (telemetryCache?.session !== session || telemetryCache.t !== t) telemetryCache = { session, t, byDriver: new Map() };
  const { byDriver } = telemetryCache;
  if (!byDriver.has(n)) {
    const d = session.drivers.get(n);
    byDriver.set(n, d ? telemetryAt(d, t) : null);
  }
  return byDriver.get(n)!;
}

/** Speed, gear, RPM, throttle, brake and DRS of car n at t (10 Hz); null before its first sample. */
export function useCar<R = Telemetry>(n: number | null, select?: Select<Telemetry, R>): R | null {
  return useKit((s) => (n == null ? null : telemetryOf(s.session, n, s.t)), [n], orNull(select)) as R | null;
}

const NO_HISTORY: CarHistory = {
  t: new Float64Array(),
  speed: new Float32Array(),
  rpm: new Float32Array(),
  gear: new Uint8Array(),
  throttle: new Float32Array(),
  brake: new Float32Array(),
  drs: null,
};

/** Car n's telemetry samples within [t - windowMs, t], oldest first. */
export function useCarHistory<R = CarHistory>(n: number | null, windowMs: number, select?: Select<CarHistory, R>): R {
  return useKit(
    (s) => {
      const car = n == null ? undefined : s.session.drivers.get(n)?.car;
      if (!car) return NO_HISTORY;
      const { from, to } = historyRange(car, s.t, windowMs);
      return historyOf(car, from, to);
    },
    [n, windowMs],
    select,
  );
}

/** API gap: the fastest time in each sector by anyone so far (seconds), for purple sector times. */
export function useBestSectors<R = readonly [number | null, number | null, number | null]>(
  select?: Select<readonly [number | null, number | null, number | null], R>,
): R {
  return useKit((s) => bestSectorsAt(s.session, s.t), [], select);
}

const NO_LAPS: readonly Lap[] = [];
const NO_STINTS: readonly StintView[] = [];

/** Laps car n has completed by t, in lap order. */
export function useLaps<R = readonly Lap[]>(n: number | null, select?: Select<readonly Lap[], R>): R {
  return useKit(
    (s) => {
      const d = n == null ? undefined : s.session.drivers.get(n);
      return d ? lapsAt(d, s.t) : NO_LAPS;
    },
    [n],
    select,
  );
}

/** Car n's stints started by t; the current one is `open`, cut at the current lap. */
export function useStints<R = readonly StintView[]>(n: number | null, select?: Select<readonly StintView[], R>): R {
  return useKit(
    (s) => {
      const d = n == null ? undefined : s.session.drivers.get(n);
      const state = s.race.drivers.find((x) => x.driver === n);
      return d && state ? stintsAt(d, state.lap) : NO_STINTS;
    },
    [n],
    select,
  );
}

/**
 * Car n's lap `lap` as a distance-aligned trace (time, speed, throttle, brake, gear and track position at each
 * distance from the timing line), once the lap is over at t; null before that, when the lap has no time, or when
 * too much of its car data is missing. Built from the car's telemetry on first use and shared by every widget.
 * engine/compare's helpers (deltaSeries, timeAtDistance, valueAtDistance, miniSectors) read it.
 */
export function useLapTrace<R = DecodedLap>(n: number | null, lap: number | null, select?: Select<DecodedLap, R>): R | null {
  return useKit(
    (s) => {
      if (n == null || lap == null) return null;
      const d = s.session.drivers.get(n);
      const l = d?.laps.find((x) => x.lap === lap);
      if (!l || l.end == null || l.end > s.t) return null;
      return lapTraceOf(s.session, n, lap);
    },
    [n, lap],
    orNull(select),
  ) as R | null;
}

/**
 * API gap: car n's lap in progress at t, as far as it has got (distance-aligned like useLapTrace's, growing as the
 * car goes): to follow a live push lap. Null between laps or without car data.
 */
export function useLiveLap<R = LiveLap>(n: number | null, select?: Select<LiveLap, R>): R | null {
  return useKit((s) => (n == null ? null : liveLapOf(s.session, n, s.t)), [n], orNull(select)) as R | null;
}

/** Where a car is on its lap in progress (useLiveLaps). */
export interface LapProgress {
  driver: number;
  lap: number;
  pitOut: boolean;
  /** Metres from the line. */
  distance: number;
  /** Ms into the lap at that distance. */
  elapsed: number;
}

/** API gap: every car's lap in progress at t (cars between laps or without car data left out), in session order. */
export function useLiveLaps<R = readonly LapProgress[]>(select?: Select<readonly LapProgress[], R>): R {
  return useKit(
    (s) =>
      s.session.driverNumbers.flatMap((n): LapProgress[] => {
        const l = liveLapOf(s.session, n, s.t);
        return l ? [{ driver: n, lap: l.lap, pitOut: l.pitOut, distance: l.trace.length, elapsed: l.trace.duration }] : [];
      }),
    [],
    select,
  );
}

/**
 * The lap as a distance: its length, the sector 2 and 3 boundaries and the corners, in metres from the timing line.
 * Measured on the session's clean laps (NaN lengths while there are none to measure, early in a live session).
 */
export function useLapGeometry<R = LapGeometry>(select?: Select<LapGeometry, R>): R {
  return useKit((s) => lapGeometryOf(s.session), [], select);
}

const NO_PITS: readonly PitStop[] = [];

/**
 * API gap: car n's pit stops finished by t, oldest first, with pit entry and exit times, pit lane time
 * and stationary time when reported (stints have the tyres, not the timing). Early 2023 races have none.
 */
export function usePitStops<R = readonly PitStop[]>(n: number | null, select?: Select<readonly PitStop[], R>): R {
  return useKit(
    (s) => {
      const d = n == null ? undefined : s.session.drivers.get(n);
      return d ? pitsAt(d, s.t) : NO_PITS;
    },
    [n],
    select,
  );
}

/** API gap: every car's completed laps by t (as useLaps), by driver number in session order. For widgets about the whole field. */
export function useAllLaps<R = ReadonlyMap<number, readonly Lap[]>>(select?: Select<ReadonlyMap<number, readonly Lap[]>, R>): R {
  return useKit((s) => allLapsAt(s.session, s.t), [], select);
}

/** API gap: every car's stints started by t (as useStints), by driver number in session order. */
export function useAllStints<R = ReadonlyMap<number, readonly StintView[]>>(select?: Select<ReadonlyMap<number, readonly StintView[]>, R>): R {
  return useKit((s) => allStintsAt(s.session, s.race), [], select);
}

/** API gap: every car's pit stops finished by t (as usePitStops), by driver number in session order. */
export function useAllPitStops<R = ReadonlyMap<number, readonly PitStop[]>>(select?: Select<ReadonlyMap<number, readonly PitStop[]>, R>): R {
  return useKit((s) => allPitsAt(s.session, s.t), [], select);
}

/** API gap: safety car, VSC and red flag periods started by t, oldest first; the one still out has no `end`. */
export function useNeutralPeriods<R = readonly NeutralPeriod[]>(select?: Select<readonly NeutralPeriod[], R>): R {
  return useKit((s) => neutralPeriodsAt(s.session, s.t), [], select);
}

/** Race feed items up to t, newest first (race control, overtakes, pits, retirements, radio). */
export function useFeed<R = readonly FeedEntry[]>(select?: Select<readonly FeedEntry[], R>): R {
  // Entries keep their identity across live rebuilds, so an unchanged feed compares equal cheaply.
  return useKit((s) => feedUpTo(s.session, feedEndAt(s.session, s.t)), [], select);
}

// ---------------------------------------------------------------- the lap window

/**
 * The laps picked on the timeline's zoom rail, within a chart of `totalLaps` laps (laps 1 to totalLaps): one
 * window for every lap chart on screen. The whole race when nothing is picked.
 */
export function useLapWindow(totalLaps: number): LapWindow {
  const picked = useKit((s) => (s.session.meta.practice || s.session.meta.qualiLive ? null : s.lapWindow), []);
  return useMemo(() => lapWindowIn(picked, totalLaps), [picked, totalLaps]);
}

// ---------------------------------------------------------------- selection

export interface Selection {
  /** Drivers picked by the user, in the order picked. When non-empty, the track map shows only these. */
  selected: readonly number[];
  /** The driver explicitly focused (ringed on the map); never set implicitly by selecting. */
  focused: number | null;
  /** Adds a driver to the selection, or removes it (unfocusing it). */
  toggle: (n: number) => void;
  focus: (n: number | null) => void;
  clear: () => void;
}

const selectionActions = {
  toggle: (n: number) => useReplay.getState().toggleSelected(n),
  focus: (n: number | null) => useReplay.getState().focus(n),
  clear: () => useReplay.getState().clearSelection(),
};

/** Selected and focused drivers, and the selection actions (the actions never change). */
export function useSelection<R = Selection>(select?: Select<Selection, R>): R {
  return useKit((s): Selection => ({ selected: s.selected, focused: s.focused, ...selectionActions }), [], select);
}

/**
 * The driver a driver widget shows: the one pinned by the widget's `driver` setting (a car number), else
 * the focused driver, else the best-placed selected one, else the leader.
 */
export function useSelectedDriver(): number | null {
  const setting = useContext(SettingsContext)?.settings.driver;
  const pinned = typeof setting === "number" ? setting : null;
  return useKit((s) => selectedDriverOf(orderOf(s.race), s.selected, s.focused, pinned), [pinned]);
}

// ---------------------------------------------------------------- the widget itself

/** This widget's settings (definition defaults under the layout's values), and a setter for some of them. */
export function useSettings<S extends WidgetSettings = WidgetSettings>(): [S, (patch: Partial<S>) => void] {
  const ctx = useContext(SettingsContext);
  if (!ctx) throw new Error("useSettings() must be used inside a WidgetHost");
  return [ctx.settings as S, ctx.update as (patch: Partial<S>) => void];
}

/**
 * useState for what the widget shows that a share card should too: the point hovered, a zoom, the laps picked. The
 * card mounts the widget again; with this its copy starts where the widget was when the screen was frozen (S), not
 * fresh. `key` names it within the widget. Keep the value in the data's terms (a distance, a lap, a driver), not
 * screen px: the card is narrower.
 */
export function useCardState<T>(key: string, initial: T | (() => T)): [T, Dispatch<SetStateAction<T>>] {
  const ctx = useContext(CardStateContext);
  const [value, set] = useState<T>(() =>
    ctx?.seed && key in ctx.seed ? (ctx.seed[key] as T) : typeof initial === "function" ? (initial as () => T)() : initial,
  );
  ctx?.live.set(key, value);
  return [value, set];
}

/** The widget's size in CSS px, and the display's pixel ratio. */
export function useWidgetSize(): WidgetSize {
  const size = useContext(SizeContext);
  if (!size) throw new Error("useWidgetSize() must be used inside a WidgetHost");
  return size;
}

// ---------------------------------------------------------------- media

export interface Radio {
  /** The clip playing (its url), if any. */
  playing: string | null;
  /** Clips that failed to load. */
  unavailable: ReadonlySet<string>;
  /** Plays a clip, stopping whatever was playing (one clip at a time, app-wide). */
  play: (url: string) => void;
  stop: () => void;
}

/** API gap: team radio playback. The core plays the clip; it stops when the session changes. */
export function useRadio<R = Radio>(select?: Select<Radio, R>): R {
  const pick = useRef(select);
  pick.current = select;
  const read = (s: { playing: string | null; unavailable: ReadonlySet<string> }) => {
    const radio: Radio = { playing: s.playing, unavailable: s.unavailable, play: playRadio, stop: stopRadio };
    return (pick.current ?? (IDENTITY as Select<Radio, R>))(radio);
  };
  // Radio state isn't race data: its own small store, same pick-and-compare as the other hooks.
  const cache = useRef<{ state: unknown; pick: unknown; value: R } | null>(null);
  const getSnapshot = () => {
    const state = useRadioState.getState();
    const c = cache.current;
    if (c && c.state === state && c.pick === pick.current) return c.value;
    const value = read(state);
    if (c && deepEqual(c.value, value)) {
      c.state = state;
      c.pick = pick.current;
      return c.value;
    }
    cache.current = { state, pick: pick.current, value };
    return value;
  };
  return useSyncExternalStore(useRadioState.subscribe, getSnapshot, getSnapshot);
}

// ---------------------------------------------------------------- opt-out

/** The whole session, including what hasn't happened yet at t. Marks the widget as seeing spoilers (H3.4). */
export function useWholeSession<R = WholeSession>(select?: Select<WholeSession, R>): R {
  return useKit((s) => wholeSessionOf(s.session), [], select);
}
