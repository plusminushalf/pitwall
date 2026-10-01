import { useEffect, useRef } from "react";
import { useLibrary } from "../library";
import { saveWatched, useReplay } from "../store";

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

/**
 * Show what the URL says: live mode, a session (or the offer to download it), or Home. On startup (once the
 * library is read) and on the browser's Back / Forward; never adds a history entry.
 */
export function applyUrl() {
  const url = readUrlState();
  const library = useLibrary.getState();
  if (!url.live && url.session == null) {
    library.setLink(null);
    return useReplay.getState().showHome();
  }
  // Off Home already, so opening doesn't push an entry.
  useReplay.setState({ view: "replay" });
  const opts = { t: url.t, drivers: url.drivers, focus: url.focus };
  if (url.live) {
    library.setLink(null);
    return useReplay.getState().enterLive({ session: url.session, ...opts });
  }
  // A shared link: open it if it's here, otherwise offer to download it (then open it at `t`).
  if (useReplay.getState().index.some((e) => e.sessionKey === url.session)) library.watchNow(url.session!, opts);
  else library.setLink({ key: url.session!, opts });
}

/** Back / Forward between Home and the replay. */
export function useHistoryNav() {
  useEffect(() => {
    window.addEventListener("popstate", applyUrl);
    return () => window.removeEventListener("popstate", applyUrl);
  }, []);
}

export function useUrlSync() {
  const view = useReplay((s) => s.view);
  const session = useReplay((s) => s.session?.meta.sessionKey);
  const live = useReplay((s) => s.mode === "live");
  // Following live, the link just says live (no time): -1 keeps this from changing every second.
  const second = useReplay((s) => (s.mode === "live" && s.followLive ? -1 : Math.floor(s.t / 1000)));
  const selected = useReplay((s) => s.selected);
  const focused = useReplay((s) => s.focused);
  const lastWrite = useRef(0);

  useEffect(() => {
    // Home's URL is its own (goHome / Back set it).
    if (view !== "replay" || (session == null && !live)) return;
    const write = () => {
      if (useReplay.getState().view !== "replay") return;
      const s = useReplay.getState();
      // (Only into this session's entry: the store may have moved on to another one.)
      if (!live && session != null && s.session?.meta.sessionKey === session) {
        saveWatched(session, {
          t: second * 1000,
          raceTime: s.race?.raceTime ?? null,
          frac: Math.min(1, (second * 1000) / s.session.meta.duration),
          watchedTo: s.watchedTo,
        });
      }
      // Built by hand (all values are numbers) so the driver list keeps readable commas instead of %2C.
      const q = live ? ["live=1"] : [];
      if (session != null && second >= 0) q.push(`session=${session}`, `t=${second}`);
      if (selected.length > 0) q.push(`drivers=${selected.join(",")}`);
      if (focused != null) q.push(`focus=${focused}`);
      const search = `?${q.join("&")}`;
      if (search === location.search) return;
      lastWrite.current = performance.now();
      // Keeps the entry's state (whether it was opened from Home).
      history.replaceState(history.state, "", search);
    };
    // During fast playback `second` changes ~10×/s: write at most once per interval, always ending on the latest state.
    const wait = lastWrite.current + MIN_WRITE_INTERVAL_MS - performance.now();
    if (wait <= 0) {
      write();
      return;
    }
    const id = setTimeout(write, wait);
    return () => clearTimeout(id);
  }, [view, session, live, second, selected, focused]);
}
