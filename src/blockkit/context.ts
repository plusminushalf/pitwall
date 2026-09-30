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

/** The block's size in CSS px (whole px, rounded down). */
export interface BlockSize {
  width: number;
  height: number;
  /** API gap: the display's device px per CSS px, for sharp canvases (changes with browser zoom and screens). */
  pixelRatio: number;
}

export interface SettingsValue {
  settings: BlockSettings;
  update: (patch: Partial<BlockSettings>) => void;
}

export const VisibilityContext = createContext<Visibility | null>(null);
export const SettingsContext = createContext<SettingsValue | null>(null);
export const SizeContext = createContext<BlockSize | null>(null);
