// The layout on screen and edit mode (H3.10, H3.11). In normal mode a block's own setting changes (the
// tower's Gap/Int toggle) are saved at once; in edit mode everything is saved on Done.

import { create } from "zustand";
import type { BlockSettings } from "../blockkit/defineBlock";
import { BUILTIN_BLOCKS } from "./builtins";
import { DEFAULT_LAYOUT } from "./defaultLayout";
import type { Slot } from "./edit";
import type { Layout } from "./layout";
import { loadLayout, saveLayout } from "./storage";

interface LayoutState {
  layout: Layout;
  editing: boolean;
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

export const useLayout = create<LayoutState>((set, get) => ({
  layout: loadLayout(BUILTIN_BLOCKS, DEFAULT_LAYOUT),
  editing: false,
  picker: null,
  startEdit: () => set({ editing: true }),
  done: () => {
    saveLayout(get().layout);
    set({ editing: false, picker: null });
  },
  reset: () => set({ layout: DEFAULT_LAYOUT, picker: null }),
  setLayout: (layout) => set({ layout }),
  setSettings: (id, settings) => {
    const { layout, editing } = get();
    const entry = layout.blocks[id];
    if (!entry) return;
    const next = { ...layout, blocks: { ...layout.blocks, [id]: { ...entry, settings } } };
    set({ layout: next });
    if (!editing) saveLayout(next);
  },
  openPicker: (slot) => set({ picker: slot ? { slot } : {} }),
  closePicker: () => set({ picker: null }),
}));
