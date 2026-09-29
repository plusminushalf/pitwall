import { useEffect, useRef } from "react";
import { useReplay } from "../store";

/** Browsers rate-limit history.replaceState (Safari throws past ~100 calls per 30 s). */
const MIN_WRITE_INTERVAL_MS = 1_000;

/**
 * Shareable links: ?session=11377&t=3725&drivers=1,63,55&focus=63 (t in seconds of replay time).
 * The older single `driver=63` form is read as that driver selected and focused.
 * Live mode: ?live=1 (plus drivers/focus); watching back a live session adds its session and t.
 */
export function readUrlState() {
  const q = new URLSearchParams(location.search);
  const num = (k: string) => (q.has(k) && !Number.isNaN(Number(q.get(k))) ? Number(q.get(k)) : null);
  const t = num("t");
  const legacy = num("driver");
  const drivers = q.has("drivers")
    ? (q.get("drivers") ?? "")
        .split(",")
        .filter((v) => v.trim() !== "")
        .map(Number)
        .filter(Number.isInteger)
    : legacy != null
      ? [legacy]
      : [];
  return {
    live: q.get("live") === "1",
    session: num("session"),
    t: t != null ? t * 1000 : undefined,
    drivers,
    focus: num("focus") ?? legacy,
  };
}

export function useUrlSync() {
  const session = useReplay((s) => s.session?.meta.sessionKey);
  const live = useReplay((s) => s.mode === "live");
  // Following live, the link just says live (no time): -1 keeps this from changing every second.
  const second = useReplay((s) => (s.mode === "live" && s.followLive ? -1 : Math.floor(s.t / 1000)));
  const selected = useReplay((s) => s.selected);
  const focused = useReplay((s) => s.focused);
  const lastWrite = useRef(0);
  const wasLive = useRef(false);

  useEffect(() => {
    // Left live mode with no replay to show (none downloaded): don't leave a link that goes live again.
    if (wasLive.current && !live && session == null) history.replaceState(null, "", location.pathname);
    wasLive.current = live;
  }, [live, session]);

  useEffect(() => {
    if (session == null && !live) return;
    const write = () => {
      // Built by hand (all values are numbers) so the driver list keeps readable commas instead of %2C.
      const q = live ? ["live=1"] : [];
      if (session != null && second >= 0) q.push(`session=${session}`, `t=${second}`);
      if (selected.length > 0) q.push(`drivers=${selected.join(",")}`);
      if (focused != null) q.push(`focus=${focused}`);
      const search = `?${q.join("&")}`;
      if (search === location.search) return;
      lastWrite.current = performance.now();
      history.replaceState(null, "", search);
    };
    // During fast playback `second` changes ~10×/s: write at most once per interval, always ending on the latest state.
    const wait = lastWrite.current + MIN_WRITE_INTERVAL_MS - performance.now();
    if (wait <= 0) {
      write();
      return;
    }
    const id = setTimeout(write, wait);
    return () => clearTimeout(id);
  }, [session, live, second, selected, focused]);
}
