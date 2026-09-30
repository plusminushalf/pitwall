// Per-block context, provided by BlockHost. Split so a resize or a settings change only re-renders
// what reads it, and the visibility store never changes identity.

import { createContext } from "react";
import type { BlockSettings } from "./defineBlock";

/** Whether the block is on screen; off-screen blocks pause (H3.6). */
export interface Visibility {
  readonly current: boolean;
  set(visible: boolean): void;
  subscribe(listener: () => void): () => void;
}

export function createVisibility(): Visibility {
  const listeners = new Set<() => void>();
  let current = true;
  return {
    get current() {
      return current;
    },
    set(visible) {
      if (visible === current) return;
      current = visible;
      for (const l of listeners) l();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** In layout px (CSS px inside the block). */
export interface BlockSize {
  width: number;
  height: number;
  /** API gap: device pixels per layout px, including the grid's scale, for sharp canvases. */
  pixelRatio: number;
}

export interface SettingsValue {
  settings: BlockSettings;
  update: (patch: Partial<BlockSettings>) => void;
}

export const VisibilityContext = createContext<Visibility | null>(null);
export const SettingsContext = createContext<SettingsValue | null>(null);
export const SizeContext = createContext<BlockSize | null>(null);
/** Screen px per layout px (the grid's zoom). */
export const ScaleContext = createContext(1);
