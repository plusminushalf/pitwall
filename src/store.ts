import { create } from "zustand";
import { LiveEdge } from "./data/liveEdge";
import { appendTelemetry, buildSession, withMeta, type Session } from "./data/session";
import { raceStateAt, timeForLap, type RaceState } from "./engine/raceState";
import { connectLive, LIVE_RELAY, type LiveConnection } from "./live/client";
import type { LiveMessage, LiveState, LiveStatus } from "./live/protocol";
import { fetchSession, listPlayable } from "./storage/load";
import type { SessionIndexEntry } from "./types";
import { livePath, readUrl, sessionPath } from "./url";

export const SPEEDS = [1, 2, 4, 8, 16, 32, 64] as const;

/**
 * Per-frame replay time. The rAF loop and the track map read/write this directly;
 * React state (`t`, `race`) is published from it at ~10 Hz to keep renders cheap.
 */
export const clock = { t: 0 };

/** Watching a stored replay, or a session streamed live by the relay (server/live.ts). */
export type Mode = "replay" | "live";

/** The Home page (library + calendar), or the session on screen (a replay, live mode, or the offer to download a linked one). */
export type View = "home" | "replay";

/** Home, unless the link opens a session or live mode. */
const initialView = (): View => {
  if (typeof location === "undefined") return "home";
  const url = readUrl(location.pathname, location.search);
  return url.live || url.session != null ? "replay" : "home";
};

/** History entries opened from Home: the Races button goes back to it rather than stacking another one. */
const pushFromHome = (url: string) => history.pushState({ fromHome: true }, "", url);

/** Where a session was left off (to resume it, and for Home's library order and progress). */
export interface Watched {
  t: number;
  /** Race clock (ms from lights out) and share of the session watched, for display. */
  raceTime: number | null;
  frac: number;
  /** Furthest time watched (no-spoiler mode shows the timeline up to there); absent in older entries. */
  watchedTo?: number;
  /** When it was last watched (ms since epoch). */
  at: number;
}

const WATCHED_KEY = "f1-replay:watched";
const MAX_WATCHED = 200;

/** Every session watched in this browser, by session key. */
export function watchHistory(): Record<number, Watched> {
  try {
    // Before per-session history only the last session was kept.
    const old = localStorage.getItem("f1-replay:last");
    if (old && !localStorage.getItem(WATCHED_KEY)) {
      const { key, ...v } = JSON.parse(old);
      if (typeof key === "number") localStorage.setItem(WATCHED_KEY, JSON.stringify({ [key]: { ...v, at: Date.now() } }));
    }
    localStorage.removeItem("f1-replay:last");
    const v = JSON.parse(localStorage.getItem(WATCHED_KEY) ?? "{}") as Record<number, Watched> | null;
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

export function saveWatched(key: number, v: Omit<Watched, "at">) {
  const all = { ...watchHistory(), [key]: { ...v, at: Date.now() } };
  const keep = Object.entries(all)
    .sort((a, b) => b[1].at - a[1].at)
    .slice(0, MAX_WATCHED);
  try {
    localStorage.setItem(WATCHED_KEY, JSON.stringify(Object.fromEntries(keep)));
  } catch {}
}

/** What happens when a race opens: ask whether to hide spoilers, or a remembered answer. */
export type SpoilerPref = "ask" | "hide" | "show";

const SPOILERS_KEY = "f1-replay:spoilers";

function readSpoilerPref(): SpoilerPref {
  try {
    const v = localStorage.getItem(SPOILERS_KEY);
    return v === "hide" || v === "show" ? v : "ask";
  } catch {
    return "ask";
  }
}

/** No-spoiler mode for a race being opened: the saved answer, or null to ask. */
const spoilerChoice = (pref: SpoilerPref): boolean | null => (pref === "ask" ? null : pref === "hide");

export interface LiveInfo {
  /** The relay's state; null until its first status message. */
  state: LiveState | null;
  source: LiveStatus["source"] | null;
  sessionKey: number | null;
  detail: string | null;
  next: LiveStatus["next"];
  /** The socket to the relay is open. */
  connected: boolean;
  /** The last connection attempt failed or the socket dropped: the relay isn't reachable (it keeps retrying). */
  offline: boolean;
}

const NO_LIVE: LiveInfo = { state: null, source: null, sessionKey: null, detail: null, next: null, connected: false, offline: false };

/** The relay's live edge (per-message, extrapolated per frame); the replay clock follows it while `followLive`. */
export const liveEdge = new LiveEdge();

/** Where the clock sits while following live right now (the very end once the live session has ended). */
export function liveTarget(wall = performance.now()): number {
  return liveEdge.target(wall, useReplay.getState().live.state === "ended");
}

/** Seeking at least this close to the follow position (in session ms) means following live again. */
const followSnap = () => liveEdge.buffer() / 3;

/** Latest time that can be shown: the live edge in live mode, the end of the replay otherwise. */
function endOf(s: { mode: Mode; session: Session | null }): number {
  if (!s.session) return 0;
  return s.mode === "live" ? Math.max(liveEdge.now, s.session.meta.duration) : s.session.meta.duration;
}

let live: LiveConnection | null = null;
/** The replay being watched when live mode was entered, brought back by exitLive(). */
let replayStash: { session: Session; t: number; watchedTo: number; noSpoilers: boolean | null; selected: number[]; focused: number | null } | null = null;
/** Live mode was entered from Home: leaving it goes back there. */
let liveFromHome = false;
/** From a shared live link: applied to the first live snapshot (`t` only if it's the same session). */
let liveOpts: LiveOpts | null = null;
/** Bumped by every session load / mode switch, so a load that finishes late doesn't clobber a newer choice. */
let loadToken = 0;

export interface LiveOpts {
  session?: number | null;
  t?: number;
  drivers?: number[];
  focus?: number | null;
}

interface ReplayState {
  /** Sessions in the library that can be opened (downloaded into this browser), by date. */
  index: SessionIndexEntry[];
  session: Session | null;
  loading: { key: number; progress: number } | null;
  error: string | null;
  t: number;
  race: RaceState | null;
  playing: boolean;
  /** Playback latched on with P or the play button: ending a space hold doesn't pause it. */
  latched: boolean;
  speed: number;
  /** Drivers picked by the user, in the order picked. When non-empty, the track map shows only these. */
  selected: number[];
  /**
   * The driver explicitly focused (a driver-panel chip or an event click): ringed on the map and shown in
   * the driver panel. Never set implicitly by selecting; when null the panel shows the best-placed selected
   * driver, or the leader.
   */
  focused: number | null;
  mode: Mode;
  view: View;
  live: LiveInfo;
  /** Latest live edge from the relay (ms since meta.t0), updated with every message. */
  liveEdge: number;
  /** Live mode: the clock tracks the live edge (a few seconds behind). False while watching back (DVR). */
  followLive: boolean;
  /** Saved in this browser: whether opening a race asks about spoilers, or hides / shows them. */
  spoilerPref: SpoilerPref;
  /**
   * No-spoiler mode for the race on screen: its timeline shows only what has been watched. Null until
   * chosen (the spoiler prompt asks over the blurred replay, which hides them meanwhile).
   */
  noSpoilers: boolean | null;
  /** Furthest time watched in this session, kept across visits (in watch history). */
  watchedTo: number;

  loadIndex: () => Promise<void>;
  loadSession: (key: number, opts?: { t?: number; drivers?: number[]; focus?: number | null }) => Promise<void>;
  /** Stop showing the current session (it was deleted); back to Home if it was on screen. */
  closeSession: () => void;
  /**
   * Show a downloaded session: instantly if it's the one loaded (left for Home), else loaded (at `opts`, or where
   * it was last watched). From Home it's a new history entry, so the browser's Back returns there.
   */
  openSession: (key: number, opts?: { t?: number; drivers?: number[]; focus?: number | null }) => void;
  /** Back to Home (and in history): playback stops, the replay stays loaded; live mode is left. */
  goHome: () => void;
  /** goHome() without touching history (Back / Forward already moved it). */
  showHome: () => void;
  publish: () => void;
  seek: (t: number) => void;
  seekBy: (dt: number) => void;
  seekToLap: (lap: number) => void;
  setPlaying: (playing: boolean) => void;
  /** P and the play button: latch playback on, or pause if it's latched (or following live). */
  togglePlay: () => void;
  /** End of a hold-to-play gesture: pauses unless playback is latched. */
  releaseHold: () => void;
  setSpeed: (speed: number) => void;
  /** Adds a driver to the selection, or removes it (clearing focus if it was the focused driver). Never focuses. */
  toggleSelected: (driver: number) => void;
  focus: (driver: number | null) => void;
  clearSelection: () => void;
  /** Switch to live mode: connect to the relay and follow whatever it streams. */
  enterLive: (opts?: LiveOpts) => void;
  /** Back to replays: disconnect and bring back the replay watched before (or Home). */
  exitLive: () => void;
  /** Jump to the live edge and follow it. */
  goLive: () => void;
  setNoSpoilers: (on: boolean) => void;
  setSpoilerPref: (pref: SpoilerPref) => void;
}

export const useReplay = create<ReplayState>((set, get) => {
  /** Leave live mode without choosing a replay (the caller loads one). */
  const disconnect = () => {
    live?.close();
    live = null;
    liveOpts = null;
    set({ mode: "replay", live: NO_LIVE, liveEdge: 0, followLive: false });
  };

  /** Leave live mode, bringing back the replay watched before it (if any). Whether there was one. */
  const restoreReplay = (): boolean => {
    disconnect();
    const stash = replayStash;
    replayStash = null;
    loadToken++;
    if (!stash) {
      set({ session: null, race: null, selected: [], focused: null, playing: false, latched: false, watchedTo: 0 });
      return false;
    }
    clock.t = stash.t;
    set({ session: stash.session, watchedTo: stash.watchedTo, noSpoilers: stash.noSpoilers, selected: stash.selected, focused: stash.focused, playing: false, latched: false, error: null });
    get().publish();
    return true;
  };

  const onLiveMessage = (msg: LiveMessage) => {
    const s = get();
    if (s.mode !== "live") return;
    const wall = performance.now();
    switch (msg.type) {
      case "status":
        set({
          live: {
            ...s.live,
            state: msg.state,
            source: msg.source,
            sessionKey: msg.sessionKey,
            detail: msg.detail ?? null,
            next: msg.next ?? null,
          },
        });
        return;
      case "snapshot": {
        const session = buildSession(msg.meta, msg.telemetry, { live: true });
        liveEdge.update(msg.now, wall, true);
        if (s.session?.meta.sessionKey === session.meta.sessionKey) {
          // Reconnected to the same session: carry on (following or watching back) with the fresh data.
          clock.t = Math.min(clock.t, endOf({ mode: "live", session }));
          set({ session, liveEdge: msg.now });
        } else {
          // A new live session: start following it, keeping only what a shared link asked for.
          const opts = liveOpts;
          liveOpts = null;
          const selected = [...new Set(opts?.drivers ?? [])].filter((n) => session.drivers.has(n));
          const focused = opts?.focus != null && session.drivers.has(opts.focus) ? opts.focus : null;
          const target = liveTarget(wall);
          const dvr = opts?.t != null && opts.session === session.meta.sessionKey && opts.t < target - followSnap();
          clock.t = dvr ? Math.max(0, opts!.t!) : target;
          set({ session, liveEdge: msg.now, followLive: !dvr, playing: false, latched: false, selected, focused, watchedTo: 0 });
        }
        get().publish();
        return;
      }
      case "meta": {
        if (!s.session || s.session.meta.sessionKey !== msg.meta.sessionKey) return; // a snapshot comes first
        liveEdge.update(msg.now, wall);
        set({ session: withMeta(s.session, msg.meta), liveEdge: msg.now });
        get().publish();
        return;
      }
      case "tel": {
        if (!s.session) return;
        liveEdge.update(msg.now, wall);
        const session = appendTelemetry(s.session, msg.chunks);
        set(session !== s.session ? { session, liveEdge: msg.now } : { liveEdge: msg.now });
        if (session !== s.session) get().publish();
        return;
      }
    }
  };

  return {
    index: [],
    session: null,
    loading: null,
    error: null,
    t: 0,
    race: null,
    playing: false,
    latched: false,
    speed: 1,
    selected: [],
    focused: null,
    mode: "replay",
    view: initialView(),
    live: NO_LIVE,
    liveEdge: 0,
    followLive: false,
    spoilerPref: readSpoilerPref(),
    noSpoilers: false,
    watchedTo: 0,

    loadIndex: async () => {
      try {
        set({ index: await listPlayable() });
      } catch (e) {
        set({ error: `Couldn't read the races stored in this browser (${e})` });
      }
    },

    loadSession: async (key, opts = {}) => {
      // Picking a replay (e.g. from the session picker) leaves live mode.
      if (get().mode === "live") {
        disconnect();
        replayStash = null;
      }
      const token = ++loadToken;
      set({ loading: { key, progress: 0 }, error: null, playing: false, latched: false });
      const last = watchHistory()[key];
      if (opts.t == null && last) opts = { ...opts, t: last.t };
      try {
        const session = await fetchSession(key, (progress) => {
          if (token === loadToken) set({ loading: { key, progress } });
        });
        if (token !== loadToken) return;
        const t = opts.t ?? Math.max(0, session.meta.lightsOut - 10_000);
        clock.t = Math.min(Math.max(t, 0), session.meta.duration);
        // Drop drivers (e.g. from a shared link) who aren't in this session.
        const selected = [...new Set(opts.drivers ?? [])].filter((n) => session.drivers.has(n));
        const focus = opts.focus != null && session.drivers.has(opts.focus) ? opts.focus : null;
        // Spoilers: asked about for each race opened (unless an answer is saved); a reload keeps the choice.
        const prev = get();
        const noSpoilers = session.meta.quali ? false : prev.session?.meta.sessionKey === key ? prev.noSpoilers : spoilerChoice(prev.spoilerPref);
        set({ session, loading: null, selected, focused: focus, watchedTo: last?.watchedTo ?? 0, noSpoilers });
        get().publish();
      } catch (e) {
        if (token === loadToken) set({ loading: null, error: `Failed to load session ${key}: ${e}` });
      }
    },

    closeSession: () => {
      loadToken++;
      set({ session: null, race: null, loading: null, selected: [], focused: null, playing: false, latched: false, watchedTo: 0 });
      get().goHome();
    },

    openSession: (key, opts) => {
      const s = get();
      if (s.view === "home") pushFromHome(sessionPath(key));
      set({ view: "replay" });
      const loaded = s.mode === "replay" && (s.loading ? s.loading.key === key : s.session?.meta.sessionKey === key && !s.error);
      if (!loaded) void get().loadSession(key, opts);
    },

    goHome: () => {
      if (get().view === "home") return;
      get().showHome();
      // Back to the Home entry this was opened from, or a new one (it was opened from a link).
      if (history.state?.fromHome) history.back();
      else history.pushState(null, "", "/");
    },

    showHome: () => {
      if (get().mode === "live") restoreReplay();
      set({ view: "home", playing: false, latched: false });
    },

    publish: () => {
      const { session, watchedTo } = get();
      if (session) set({ t: clock.t, race: raceStateAt(session, clock.t), watchedTo: Math.max(watchedTo, clock.t) });
    },

    seek: (t) => {
      const s = get();
      if (!s.session) return;
      if (s.mode === "live") {
        // Scrubbing back watches back (DVR); scrubbing up to the live edge follows it again.
        const target = liveTarget();
        const follow = t >= target - followSnap();
        clock.t = follow ? target : Math.max(t, 0);
        if (follow !== s.followLive) set(follow ? { followLive: true, playing: false, latched: false } : { followLive: false });
      } else {
        clock.t = Math.min(Math.max(t, 0), s.session.meta.duration);
      }
      get().publish();
    },

    seekBy: (dt) => get().seek(clock.t + dt),

    seekToLap: (lap) => {
      const { session, mode } = get();
      if (!session) return;
      // Live: a lap that hasn't started yet is ahead of the live edge.
      const n = Math.max(1, Math.min(lap, session.meta.totalLaps));
      if (mode === "live" && lap >= 1 && session.lapStartTimes[n] === undefined) return get().goLive();
      get().seek(timeForLap(session, lap));
    },

    setPlaying: (playing) => {
      const { session, mode } = get();
      if (!session) return;
      // Pressing play at the end restarts from lights out (live: the end is the live edge, which playback follows).
      if (playing && mode === "replay" && clock.t >= session.meta.duration) clock.t = Math.max(0, session.meta.lightsOut - 10_000);
      set(playing ? { playing } : { playing, latched: false });
      get().publish();
    },

    togglePlay: () => {
      const s = get();
      // Following live: P freezes the picture (and stops following).
      if (s.mode === "live" && s.followLive) {
        if (!s.session) return;
        set({ followLive: false, playing: false, latched: false });
        return get().publish();
      }
      if (s.latched) return s.setPlaying(false);
      s.setPlaying(true);
      if (get().playing) set({ latched: true });
    },

    releaseHold: () => {
      const { playing, latched, setPlaying } = get();
      if (playing && !latched) setPlaying(false);
    },

    setSpeed: (speed) => set({ speed }),

    toggleSelected: (driver) => {
      const { selected, focused } = get();
      if (!selected.includes(driver)) {
        set({ selected: [...selected, driver] });
        return;
      }
      set({ selected: selected.filter((n) => n !== driver), focused: focused === driver ? null : focused });
    },

    focus: (driver) => set({ focused: driver }),
    clearSelection: () => set({ selected: [], focused: null }),

    enterLive: (opts = {}) => {
      const s = get();
      if (s.mode === "live") return;
      liveFromHome = s.view === "home";
      if (liveFromHome) pushFromHome(livePath);
      loadToken++; // a replay still loading is no longer wanted
      if (s.session) replayStash = { session: s.session, t: clock.t, watchedTo: s.watchedTo, noSpoilers: s.noSpoilers, selected: s.selected, focused: s.focused };
      liveOpts = opts;
      liveEdge.update(0, performance.now(), true);
      set({
        mode: "live",
        view: "replay",
        live: NO_LIVE,
        liveEdge: 0,
        followLive: true,
        session: null,
        race: null,
        loading: null,
        error: null,
        playing: false,
        latched: false,
        selected: [],
        focused: null,
        watchedTo: 0,
        noSpoilers: false,
      });
      // No relay behind this site (a static build): LiveScreen explains, nothing to connect to.
      if (!LIVE_RELAY) return;
      live = connectLive({
        onOpen: () => set({ live: { ...get().live, connected: true, offline: false } }),
        onDown: () => set({ live: { ...get().live, connected: false, offline: true } }),
        onMessage: onLiveMessage,
      });
    },

    exitLive: () => {
      if (get().mode !== "live") return;
      if (liveFromHome || !restoreReplay()) get().goHome();
    },

    goLive: () => {
      const { mode, session } = get();
      if (mode !== "live" || !session) return;
      clock.t = liveTarget();
      set({ followLive: true, playing: false, latched: false });
      get().publish();
    },

    setNoSpoilers: (on) => set({ noSpoilers: on }),

    setSpoilerPref: (pref) => {
      try {
        localStorage.setItem(SPOILERS_KEY, pref);
      } catch {}
      set({ spoilerPref: pref });
    },
  };
});
