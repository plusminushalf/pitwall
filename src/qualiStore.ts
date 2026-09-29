// State of the qualifying compare view. The compared drivers are the replay store's selection
// (`useReplay.selected`, so links and Esc work as in the race view) and ghost playback follows its
// play state (space / P); everything specific to comparing laps lives here.

import { create } from "zustand";
import type { LapPreset } from "./data/quali";
import { fetchLapTraces } from "./storage/load";
import type { DecodedLap } from "./engine/compare";

export const MAX_COMPARE = 4;
export const GHOST_SPEEDS = [0.25, 0.5, 1, 2, 4] as const;

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
  ghostT: number;
  ghostSpeed: number;

  reset: (sessionKey: number) => void;
  ensureTraces: (driver: number) => void;
  setLap: (driver: number, lap: number | null) => void;
  setPreset: (preset: LapPreset) => void;
  setBoard: (tab: BoardTab) => void;
  setHover: (d: number | null) => void;
  setZoom: (zoom: [number, number] | null) => void;
  seekGhost: (t: number) => void;
  setGhostSpeed: (speed: number) => void;
}

export const useQuali = create<QualiState>((set, get) => ({
  sessionKey: null,
  traces: new Map(),
  traceErrors: new Map(),
  laps: {},
  preset: "best",
  board: "result",
  hover: null,
  zoom: null,
  ghostT: 0,
  ghostSpeed: 1,

  reset: (sessionKey) => {
    if (get().sessionKey === sessionKey) return;
    ghost.t = 0;
    set({ sessionKey, traces: new Map(), traceErrors: new Map(), laps: {}, preset: "best", board: "result", hover: null, zoom: null, ghostT: 0 });
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
  seekGhost: (t) => {
    ghost.t = Math.max(0, t);
    set({ ghostT: ghost.t });
  },
  setGhostSpeed: (ghostSpeed) => set({ ghostSpeed }),
}));
