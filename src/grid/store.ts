// The layout on screen and edit mode (H3.10, H3.11). In normal mode a block's own setting changes (the
// tower's Gap/Int toggle) are saved at once; in edit mode everything is saved on Done. Playback pauses
// in edit mode (dragging with the race playing janks) and resumes on Done, unless the user pressed play
// meanwhile, in which case it's left as they set it. Races and free practice each have a layout: opening a
// session of the other kind shows (and edits) that one.

import { create } from "zustand";
import type { BlockSettings } from "../blockkit/defineBlock";
import type { Session } from "../data/session";
import { useReplay } from "../store";
import { BUILTIN_BLOCKS } from "./builtins";
import { DEFAULT_LAYOUTS } from "./defaultLayout";
import type { Slot } from "./edit";
import type { Layout } from "./layout";
import { loadLayout, saveLayout, type GridKind } from "./storage";

/** Which layout a session is shown with. */
const gridKindOf = (session: Session | null): GridKind | null => (session ? (session.meta.practice ? "practice" : "race") : null);

interface LayoutState {
  /** The kind of session the layout is for. */
  kind: GridKind;
  layout: Layout;
  editing: boolean;
  /** Edit mode paused the race, and Done will resume it. */
  pausedPlayback: boolean;
  /** The block picker, open for a free slot or (without one) wherever the block fits. */
  picker: { slot?: Slot } | null;
  startEdit: () => void;
  /** Saves the layout and leaves edit mode. */
  done: () => void;
  /** The default layout, saved on Done. */
  reset: () => void;
  setLayout: (layout: Layout) => void;
  setSettings: (id: string, settings: Partial<BlockSettings>) => void;
  openPicker: (slot?: Slot) => void;
  closePicker: () => void;
}

/** While edit mode has the race paused: the watch for the user pressing play. */
let stopWatching: (() => void) | null = null;

/** The kind on screen when this store is made (a hot reload can make it with a session open); "race" before one is. */
const initialKind = gridKindOf(useReplay.getState().session) ?? "race";

export const useLayout = create<LayoutState>((set, get) => ({
  kind: initialKind,
  layout: loadLayout(BUILTIN_BLOCKS, DEFAULT_LAYOUTS[initialKind], initialKind),
  editing: false,
  pausedPlayback: false,
  picker: null,
  startEdit: () => {
    const replay = useReplay.getState();
    // Playing on a held space isn't resumed: its release would have paused it anyway.
    const resume = replay.playing && replay.latched;
    if (replay.playing) replay.setPlaying(false);
    set({ editing: true, pausedPlayback: resume });
    if (!resume) return;
    // Pressing play (or opening another race) while editing hands playback back to the user.
    const session = replay.session;
    const unsubscribe = useReplay.subscribe((s) => {
      if (!get().editing || s.playing || s.session !== session) {
        unsubscribe();
        stopWatching = null;
        if (get().editing) set({ pausedPlayback: false });
      }
    });
    stopWatching = unsubscribe;
  },
  done: () => {
    saveLayout(get().layout, get().kind);
    const resume = get().pausedPlayback;
    stopWatching?.();
    stopWatching = null;
    set({ editing: false, pausedPlayback: false, picker: null });
    // Paused and unlatched, toggling plays and latches again, as before edit mode.
    if (resume && !useReplay.getState().playing) useReplay.getState().togglePlay();
  },
  reset: () => set({ layout: DEFAULT_LAYOUTS[get().kind], picker: null }),
  setLayout: (layout) => set({ layout }),
  setSettings: (id, settings) => {
    const { layout, editing, kind } = get();
    const entry = layout.blocks[id];
    if (!entry) return;
    const next = { ...layout, blocks: { ...layout.blocks, [id]: { ...entry, settings } } };
    set({ layout: next });
    if (!editing) saveLayout(next, kind);
  },
  openPicker: (slot) => set({ picker: slot ? { slot } : {} }),
  closePicker: () => set({ picker: null }),
}));

// A session of the other kind: its layout. Editing the one on screen ends as Done would (saved), so nothing's lost.
useReplay.subscribe((s) => {
  const kind = gridKindOf(s.session);
  const state = useLayout.getState();
  if (kind == null || kind === state.kind) return;
  if (state.editing) {
    saveLayout(state.layout, state.kind);
    stopWatching?.();
    stopWatching = null;
  }
  useLayout.setState({ kind, layout: loadLayout(BUILTIN_BLOCKS, DEFAULT_LAYOUTS[kind], kind), editing: false, pausedPlayback: false, picker: null });
});
