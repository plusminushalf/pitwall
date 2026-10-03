// Team radio playback for widgets: the core plays clips, one at a time app-wide (H3.1: widgets don't
// fetch media themselves). Stops when the session changes or the replay screen is left.

import { create } from "zustand";
import { useReplay } from "../store";

interface RadioState {
  /** The clip playing (its url), if any. */
  playing: string | null;
  /** Clips that failed to load. */
  unavailable: ReadonlySet<string>;
}

export const useRadioState = create<RadioState>(() => ({ playing: null, unavailable: new Set() }));

let current: { audio: HTMLAudioElement; url: string } | null = null;

export function stopRadio(): void {
  current?.audio.pause();
  current = null;
  if (useRadioState.getState().playing != null) useRadioState.setState({ playing: null });
}

/** Plays a clip, stopping any other. */
export function playRadio(url: string): void {
  stopRadio();
  const audio = new Audio(url);
  const entry = { audio, url };
  current = entry;
  useRadioState.setState({ playing: url });

  const release = () => {
    if (current !== entry) return;
    current = null;
    useRadioState.setState({ playing: null });
  };
  const fail = () => {
    release();
    useRadioState.setState((s) => ({ unavailable: new Set(s.unavailable).add(url) }));
  };
  audio.addEventListener("ended", release);
  audio.addEventListener("error", fail);
  audio.play().catch((e: unknown) => {
    // AbortError: stopped (or another clip started) before playback began; not a failure.
    if (e instanceof DOMException && e.name === "AbortError") return;
    if (current === entry) fail();
  });
}

const sessionKey = (s: ReturnType<typeof useReplay.getState>) => s.session?.meta?.sessionKey;

useReplay.subscribe((s, prev) => {
  const left = prev.view === "replay" && s.view !== "replay";
  if (left || sessionKey(s) !== sessionKey(prev)) stopRadio();
});
