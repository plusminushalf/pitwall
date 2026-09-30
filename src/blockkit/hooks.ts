// The block hooks (H3.3), built on the replay store and its shared 10 Hz race state.
// Every hook reads through useKit(): a selector plus an equality check, so a block re-renders only
// when its own data changed, and not at all while it's off screen.

import { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from "react";
import type { FeedItem, Session } from "../data/session";
import { telemetryAt, type DriverState, type RaceState, type Telemetry } from "../engine/raceState";
import { SPEEDS, useReplay } from "../store";
import type { DriverInfo, Lap } from "../types";
import { SettingsContext, SizeContext, VisibilityContext, type BlockSize, type Visibility } from "./context";
import type { BlockSettings } from "./defineBlock";
import { deepEqual, shallowEqual } from "./equal";
import { addFrameCallback, type DrawFn } from "./frame";
import {
  driversOf,
  feedEndAt,
  feedUpTo,
  historyRange,
  historySlice,
  lapsAt,
  raceViewOf,
  selectedDriverOf,
  sessionInfoOf,
  stintsAt,
  trackOf,
  wholeSessionOf,
  type CarHistory,
  type RaceView,
  type SessionInfo,
  type StintView,
  type Track,
  type WholeSession,
} from "./select";

type ReplayState = ReturnType<typeof useReplay.getState>;
/** The store with a race loaded: blocks are only mounted then (BlockHost). */
type Loaded = ReplayState & { session: Session; race: RaceState };

const ALWAYS_VISIBLE: Visibility = { current: true, set() {}, subscribe: () => () => {} };

/**
 * `select` over the store, kept while `equal` says it's unchanged. Store updates are ignored while the
 * block is off screen (it catches up when it's back). With no race loaded (a block about to unmount)
 * the last value stays.
 */
function useKit<T>(select: (s: Loaded) => T, equal: (a: T, b: T) => boolean = Object.is): T {
  const visibility = useContext(VisibilityContext) ?? ALWAYS_VISIBLE;
  const cache = useRef<{ state: ReplayState; select: unknown; value: T } | null>(null);
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
  const getSnapshot = () => {
    const state = useReplay.getState();
    const c = cache.current;
    if (c && c.state === state && c.select === select) return c.value;
    if (!state.session || !state.race) {
      if (c) return c.value;
      throw new Error("block-kit hooks need a loaded race: render blocks inside a BlockHost");
    }
    const value = select(state as Loaded);
    if (c && equal(c.value, value)) {
      c.state = state;
      c.select = select;
      return c.value;
    }
    cache.current = { state, select, value };
    return value;
  };
  return useSyncExternalStore(subscribe, getSnapshot);
}

// ---------------------------------------------------------------- time and playback

/** Replay time (ms since the session window start), updated at most 10 times a second. */
export function useTime(): number {
  return useKit((s) => s.t);
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

export function usePlayback(): Playback {
  const state = useKit((s) => ({ playing: s.playing || (s.mode === "live" && s.followLive), speed: s.speed }), shallowEqual);
  return useMemo(() => ({ ...state, speeds: SPEEDS, ...playbackActions }), [state]);
}

// ---------------------------------------------------------------- session info (fixed for the session)

/** Drivers in the session (names, teams, colours, headshots), in session order. */
export function useDrivers(): readonly DriverInfo[] {
  return useKit((s) => driversOf(s.session), deepEqual);
}

/** Circuit outline, pit lane, corners, sector marks and marshal sectors. */
export function useTrack(): Track {
  return useKit((s) => trackOf(s.session.meta.track), deepEqual);
}

export function useSessionInfo(): SessionInfo {
  return useKit((s) => sessionInfoOf(s.session.meta), deepEqual);
}

// ---------------------------------------------------------------- the race at t (spoiler-free)

/** Track status, sector flags, weather, fastest lap so far and the running order. */
export function useRace(): RaceView {
  return useKit((s) => raceViewOf(s.race), deepEqual);
}

/** Position, gaps, tyres, laps and status of car n at t; null if it isn't in the session. */
export function useDriver(n: number | null): DriverState | null {
  return useKit((s) => (n == null ? null : (s.race.drivers.find((d) => d.driver === n) ?? null)), deepEqual);
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
export function useCar(n: number | null): Telemetry | null {
  return useKit((s) => (n == null ? null : telemetryOf(s.session, n, s.t)), deepEqual);
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
export function useCarHistory(n: number | null, windowMs: number): CarHistory {
  const range = useKit((s) => {
    const car = n == null ? undefined : s.session.drivers.get(n)?.car;
    return car ? { car, ...historyRange(car, s.t, windowMs) } : null;
  }, shallowEqual);
  return useMemo(() => (range ? historySlice(range.car, range.from, range.to) : NO_HISTORY), [range]);
}

const NO_LAPS: readonly Lap[] = [];
const NO_STINTS: readonly StintView[] = [];

/** Laps car n has completed by t, in lap order. */
export function useLaps(n: number | null): readonly Lap[] {
  return useKit((s) => {
    const d = n == null ? undefined : s.session.drivers.get(n);
    return d ? lapsAt(d, s.t) : NO_LAPS;
  }, shallowEqual);
}

/** Car n's stints started by t; the current one is `open`, cut at the current lap. */
export function useStints(n: number | null): readonly StintView[] {
  return useKit((s) => {
    const d = n == null ? undefined : s.session.drivers.get(n);
    const state = s.race.drivers.find((x) => x.driver === n);
    return d && state ? stintsAt(d, state.lap) : NO_STINTS;
  }, deepEqual);
}

/** Race feed items up to t, newest first (race control, overtakes, pits, retirements, radio). */
export function useFeed(): readonly FeedItem[] {
  const at = useKit((s) => ({ session: s.session, end: feedEndAt(s.session, s.t) }), shallowEqual);
  return useMemo(() => feedUpTo(at.session, at.end), [at]);
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

export function useSelection(): Selection {
  const state = useKit((s) => ({ selected: s.selected, focused: s.focused }), shallowEqual);
  return useMemo(() => ({ ...state, ...selectionActions }), [state]);
}

/**
 * The driver a driver block shows: the one pinned by the block's `driver` setting (a car number), else
 * the focused driver, else the best-placed selected one, else the leader.
 */
export function useSelectedDriver(): number | null {
  const setting = useContext(SettingsContext)?.settings.driver;
  const pinned = typeof setting === "number" ? setting : null;
  return useKit((s) => selectedDriverOf(raceViewOf(s.race).order, s.selected, s.focused, pinned));
}

// ---------------------------------------------------------------- the block itself

/** This block's settings (definition defaults under the layout's values), and a setter for some of them. */
export function useSettings<S extends BlockSettings = BlockSettings>(): [S, (patch: Partial<S>) => void] {
  const ctx = useContext(SettingsContext);
  if (!ctx) throw new Error("useSettings() must be used inside a BlockHost");
  return [ctx.settings as S, ctx.update as (patch: Partial<S>) => void];
}

/** The block's size in CSS pixels. */
export function useBlockSize(): BlockSize {
  const size = useContext(SizeContext);
  if (!size) throw new Error("useBlockSize() must be used inside a BlockHost");
  return size;
}

// ---------------------------------------------------------------- opt-out

/** The whole session, including what hasn't happened yet at t. Marks the block as seeing spoilers (H3.4). */
export function useWholeSession(): WholeSession {
  return useKit((s) => wholeSessionOf(s.session));
}
