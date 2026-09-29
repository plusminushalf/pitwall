import { useEffect } from "react";
import { SPEEDS, useReplay } from "../store";

/**
 * hold space: play · p: play/pause (latched) · ←/→: ±5 s (shift: ±30 s) · [ / ]: previous/next lap
 * - / +: slower/faster · esc: clear selection
 */
export function useKeyboard() {
  useEffect(() => {
    // Whether space is being held for playback (so only its own keyup ends the hold).
    let holding = false;
    const release = () => {
      holding = false;
      useReplay.getState().releaseHold();
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
      const s = useReplay.getState();
      if (!s.session) return;
      // Don't let space/arrows also activate whatever button was clicked last.
      if (e.target instanceof HTMLButtonElement) e.target.blur();
      const speedIndex = SPEEDS.indexOf(s.speed as (typeof SPEEDS)[number]);
      switch (e.key) {
        case " ":
          if (!e.repeat) {
            holding = true;
            s.setPlaying(true);
          }
          break;
        case "p":
        case "P":
          // Leave browser shortcuts (e.g. Ctrl/Cmd+P) alone.
          if (e.ctrlKey || e.metaKey || e.altKey) return;
          if (!e.repeat) s.togglePlay();
          break;
        case "ArrowLeft":
          s.seekBy(e.shiftKey ? -30_000 : -5_000);
          break;
        case "ArrowRight":
          s.seekBy(e.shiftKey ? 30_000 : 5_000);
          break;
        case "[":
          s.seekToLap((s.race?.leaderLap ?? 1) - 1);
          break;
        case "]":
          s.seekToLap((s.race?.leaderLap ?? 0) + 1);
          break;
        case "-":
          s.setSpeed(SPEEDS[Math.max(0, speedIndex - 1)]);
          break;
        case "+":
        case "=":
          s.setSpeed(SPEEDS[Math.min(SPEEDS.length - 1, speedIndex + 1)]);
          break;
        case "Escape":
          s.clearSelection();
          break;
        default:
          return;
      }
      e.preventDefault();
    };

    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key !== " " || !holding) return;
      e.preventDefault();
      release();
    };

    // The keyup never arrives if the key is released while the page is unfocused or hidden.
    const onVisibility = () => {
      if (document.visibilityState === "hidden") release();
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", release);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", release);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);
}
