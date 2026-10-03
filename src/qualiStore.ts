// State of the lap comparison view (qualifying, and finished practice's Fastest laps). The compared drivers are
// the replay store's selection (`useReplay.selected`, so links and Esc work as in the race view) and ghost
// playback follows its play state (space / P); everything specific to comparing laps lives here.

import { create } from "zustand";
import type { LapPreset } from "./data/quali";
import { fetchLapTraces } from "./storage/load";
import type { DecodedLap } from "./engine/compare";
import type { CompareLink } from "./url";

export const MAX_COMPARE = 4;
export const GHOST_SPEEDS = [0.25, 0.5, 1, 2, 4] as const;
export const MINI_SECTOR_COUNTS = [12, 25, 50] as const;
const MINI_SECTORS = 25;

/** Per-frame ghost time (ms since the compared laps started); published to React at ~10 Hz. */
export const ghost = { t: 0 };

export type BoardTab = "result" | number; // the classification, or one segment's standings

interface QualiState {
  sessionKey: number | null;
  traces: Map<number, Map<number, DecodedLap>>; // driver -> lap -> trace
  traceErrors: Map<number, string>;
  /** Laps picked by hand, per driver; others use the preset. */
  laps: Record<number, number>;
  preset: LapPreset;
  board: BoardTab;
  /** Distance (m) under the pointer on the charts or map, shared by all of them. */
  hover: number | null;
  /** Distance window of the charts (m), or null for the whole lap. */
  zoom: [number, number] | null;
  /** Mini-sectors on the map (one of MINI_SECTOR_COUNTS). */
  miniCount: number;
  /** Corner names on the map and charts instead of numbers. */
  cornerNames: boolean;
  ghostT: number;
  ghostSpeed: number;
  /**
   * The drivers the view picked itself because nobody was selected (the two fastest): practice's replay goes back
   * to no selection if they're still the ones compared.
   */
  autoPicked: number[] | null;

  reset: (sessionKey: number) => void;
  ensureTraces: (driver: number) => void;
  setLap: (driver: number, lap: number | null) => void;
  setPreset: (preset: LapPreset) => void;
  setBoard: (tab: BoardTab) => void;
  setHover: (d: number | null) => void;
  setZoom: (zoom: [number, number] | null) => void;
  setMiniCount: (n: number) => void;
  setCornerNames: (on: boolean) => void;
  /** A shared link's set-up for session `key`: now if it's the one compared, else when it is (reset()). */
  applyLink: (key: number, link: CompareLink) => void;
  /** The set-up as a shared link says it (the defaults left out). */
  link: () => CompareLink;
  seekGhost: (t: number) => void;
  setGhostSpeed: (speed: number) => void;
}

/** A shared link's set-up waiting for its session to be compared. */
let pendingLink: { key: number; link: CompareLink } | null = null;

export const useQuali = create<QualiState>((set, get) => ({
  sessionKey: null,
  traces: new Map(),
  traceErrors: new Map(),
  laps: {},
  preset: "best",
  board: "result",
  hover: null,
  zoom: null,
  miniCount: MINI_SECTORS,
  cornerNames: false,
  ghostT: 0,
  ghostSpeed: 1,
  autoPicked: null,

  reset: (sessionKey) => {
    if (get().sessionKey === sessionKey) return;
    ghost.t = 0;
    set({ sessionKey, traces: new Map(), traceErrors: new Map(), laps: {}, preset: "best", board: "result", hover: null, zoom: null, miniCount: MINI_SECTORS, cornerNames: false, ghostT: 0, autoPicked: null });
    if (pendingLink?.key === sessionKey) get().applyLink(sessionKey, pendingLink.link);
    pendingLink = null;
  },

  ensureTraces: (driver) => {
    const { sessionKey, traces } = get();
    if (sessionKey == null || traces.has(driver)) return;
    fetchLapTraces(sessionKey, driver).then(
      (laps) => {
        if (get().sessionKey !== sessionKey) return;
        set({ traces: new Map(get().traces).set(driver, laps) });
      },
      (e) => {
        if (get().sessionKey !== sessionKey) return;
        set({ traceErrors: new Map(get().traceErrors).set(driver, String(e)) });
      },
    );
  },

  setLap: (driver, lap) => {
    const laps = { ...get().laps };
    if (lap == null) delete laps[driver];
    else laps[driver] = lap;
    set({ laps });
  },
  // A preset applies to everyone: hand-picked laps are dropped.
  setPreset: (preset) => set({ preset, laps: {} }),
  setBoard: (board) => set({ board }),
  setHover: (hover) => {
    if (get().hover !== hover) set({ hover });
  },
  setZoom: (zoom) => set({ zoom }),
  setMiniCount: (miniCount) => set({ miniCount }),
  setCornerNames: (cornerNames) => set({ cornerNames }),
  applyLink: (key, link) => {
    if (get().sessionKey !== key) {
      pendingLink = { key, link };
      return;
    }
    set({
      zoom: link.zoom ?? null,
      preset: link.preset ?? "best",
      laps: link.laps ?? {},
      miniCount: MINI_SECTOR_COUNTS.find((n) => n === link.mini) ?? MINI_SECTORS,
      cornerNames: link.names ?? false,
    });
  },
  link: () => {
    const { zoom, preset, laps, miniCount, cornerNames } = get();
    return {
      ...(zoom ? { zoom } : {}),
      ...(preset !== "best" ? { preset } : {}),
      ...(Object.keys(laps).length > 0 ? { laps } : {}),
      ...(miniCount !== MINI_SECTORS ? { mini: miniCount } : {}),
      ...(cornerNames ? { names: true as const } : {}),
    };
  },
  seekGhost: (t) => {
    ghost.t = Math.max(0, t);
    set({ ghostT: ghost.t });
  },
  setGhostSpeed: (ghostSpeed) => set({ ghostSpeed }),
}));
