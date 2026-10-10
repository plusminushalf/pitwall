// Per-widget context, provided by WidgetHost. Split so a resize or a settings change only re-renders
// what reads it, and the visibility store never changes identity.

import { createContext } from "react";
import type { WidgetSettings } from "./defineWidget";

/** Whether the widget is on screen; off-screen widgets pause (H3.6). */
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

/** The widget's size in CSS px (whole px, rounded down). */
export interface WidgetSize {
  width: number;
  height: number;
  /** API gap: the display's device px per CSS px, for sharp canvases (changes with browser zoom and screens). */
  pixelRatio: number;
}

export interface SettingsValue {
  settings: WidgetSettings;
  update: (patch: Partial<WidgetSettings>) => void;
}

/**
 * What a widget is showing that isn't in its settings (the point hovered, a zoom, the laps picked): useCardState()'s
 * values. `live` is the widget's now, by key, for a share card to read; `seed` is what a widget mounted again on a card
 * starts with.
 */
export interface CardStateValue {
  live: Map<string, unknown>;
  seed: Readonly<Record<string, unknown>> | null;
}

export const VisibilityContext = createContext<Visibility | null>(null);
export const CardStateContext = createContext<CardStateValue | null>(null);
export const SettingsContext = createContext<SettingsValue | null>(null);
export const SizeContext = createContext<WidgetSize | null>(null);
