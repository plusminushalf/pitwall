// The block hooks (H3.3), built on the replay store and its shared 10 Hz race state.
// Every hook reads through useKit(): the hook's spoiler-free value, an optional `select` from the block
// on top, and an equality check, so a block re-renders only when what it selected changed, and not at
// all while it's off screen.

import { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from "react";
import type { Session } from "../data/session";
import { raceDistanceAt } from "../engine/raceDistance";
import { telemetryAt, type DriverState, type RaceState, type SectorFlag, type Telemetry } from "../engine/raceState";
import { SPEEDS, useReplay } from "../store";
import type { DriverInfo, Lap, TrackStatus, WeatherSample } from "../types";
import { SettingsContext, SizeContext, VisibilityContext, type BlockSize, type Visibility } from "./context";
import type { BlockSettings } from "./defineBlock";
import { deepEqual } from "./equal";
import { addFrameCallback, type DrawFn } from "./frame";
import { playRadio, stopRadio, useRadioState } from "./radio";
import {
  bestSectorsAt,
  driversOf,
  feedEndAt,
  feedUpTo,
  historyOf,
  historyRange,
  lapsAt,
  orderOf,
  positionsOf,
  selectedDriverOf,
  sessionInfoOf,
  stintsAt,
  trackOf,
  wholeSessionOf,
  type CarHistory,
  type FeedEntry,
  type SessionInfo,
  type StintView,
  type Track,
  type WholeSession,
} from "./select";

type ReplayState = ReturnType<typeof useReplay.getState>;
/** The store with a race loaded: blocks are only mounted then (BlockHost). */
type Loaded = ReplayState & { session: Session; race: RaceState };

/** A block's optional pick from a hook's value: the block re-renders only when the pick changes. */
export type Select<T, R> = (value: T) => R;

const ALWAYS_VISIBLE: Visibility = { current: true, set() {}, subscribe: () => () => {} };
const IDENTITY = <T,>(v: T) => v;

/**
 * `base` over the store (the hook's own, spoiler-free value; `deps` are what it depends on), then the
 * block's `pick`, kept while deepEqual says the result is unchanged. The pick lives in a ref: an inline
 * arrow neither resubscribes nor defeats the cache. Store updates are ignored while the block is off
 * screen (it catches up when it's back). With no race loaded (a block about to unmount) the last value stays.
 */
function useKit<T, R = T>(base: (s: Loaded) => T, deps: readonly unknown[], pick?: Select<T, R>): R {
  const visibility = useContext(VisibilityContext) ?? ALWAYS_VISIBLE;
  // `base` is a new closure every render; `deps` say when it actually reads something else.
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
      throw new Error("block-kit hooks need a loaded race: render blocks inside a BlockHost");
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
 * coarsen it (e.g. t => Math.floor(t / 1000)) so the block re-renders only when that changes.
 */
export function useTime<R = number>(select?: Select<number, R>): R {
  return useKit((s) => s.t, [], select);
}

/**
 * Calls `draw` every animation frame with the exact time, without re-rendering. The latest `draw` is
 * used each frame. Paused while the block is off screen; a slow draw skips its own frames.
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
// One hook per thing, so a block re-renders only for what it reads (H3.2).

/** The lap the leader is on (0 before the start). */
export function useLeaderLap<R = number>(select?: Select<number, R>): R {
  return useKit((s) => s.race.leaderLap, [], select);
}

/**
 * Race distance in laps as known at t: the scheduled distance until race control takes laps off or the
 * chequered flag ends a shortened race (live: estimated until it's known, see useSessionInfo().totalLapsEstimated).
 */
export function useTotalLaps<R = number>(select?: Select<number, R>): R {
  return useKit((s) => raceDistanceAt(s.session.meta, s.race.t).totalLaps, [], select);
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

/** Telemetry samples shared by every block this 10 Hz tick. */
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

/** Race feed items up to t, newest first (race control, overtakes, pits, retirements, radio). */
export function useFeed<R = readonly FeedEntry[]>(select?: Select<readonly FeedEntry[], R>): R {
  // Entries keep their identity across live rebuilds, so an unchanged feed compares equal cheaply.
  return useKit((s) => feedUpTo(s.session, feedEndAt(s.session, s.t)), [], select);
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
 * The driver a driver block shows: the one pinned by the block's `driver` setting (a car number), else
 * the focused driver, else the best-placed selected one, else the leader.
 */
export function useSelectedDriver(): number | null {
  const setting = useContext(SettingsContext)?.settings.driver;
  const pinned = typeof setting === "number" ? setting : null;
  return useKit((s) => selectedDriverOf(orderOf(s.race), s.selected, s.focused, pinned), [pinned]);
}

// ---------------------------------------------------------------- the block itself

/** This block's settings (definition defaults under the layout's values), and a setter for some of them. */
export function useSettings<S extends BlockSettings = BlockSettings>(): [S, (patch: Partial<S>) => void] {
  const ctx = useContext(SettingsContext);
  if (!ctx) throw new Error("useSettings() must be used inside a BlockHost");
  return [ctx.settings as S, ctx.update as (patch: Partial<S>) => void];
}

/** The block's size in CSS px, and the display's pixel ratio. */
export function useBlockSize(): BlockSize {
  const size = useContext(SizeContext);
  if (!size) throw new Error("useBlockSize() must be used inside a BlockHost");
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

/** The whole session, including what hasn't happened yet at t. Marks the block as seeing spoilers (H3.4). */
export function useWholeSession<R = WholeSession>(select?: Select<WholeSession, R>): R {
  return useKit((s) => wholeSessionOf(s.session), [], select);
}
