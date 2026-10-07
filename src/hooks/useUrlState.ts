import { useEffect, useRef } from "react";
import { rowForKey, rowState, useLibrary } from "../library";
import { comparing, saveWatched, useReplay } from "../store";
import { FIRST } from "../grid/dashboards";
import { useLayout } from "../grid/store";
import { useQuali } from "../qualiStore";
import { decodeLayout } from "../share/layoutCode";
import { readUrl, upgradeUrl, urlFor } from "../url";

/** Browsers rate-limit history.replaceState (Safari throws past ~100 calls per 30 s). */
const MIN_WRITE_INTERVAL_MS = 1_000;

/**
 * Show what the URL says (addresses in ../url.ts): live mode, a session (or the offer to watch it), a circuit, or Home. On
 * startup (once the library is read) and on the browser's Back / Forward; never adds a history entry.
 */
export function applyUrl() {
  // A link from before paths, or to a path the app doesn't have: today's address, in place.
  const upgraded = upgradeUrl(location.pathname, location.search);
  if (upgraded != null) history.replaceState(history.state, "", upgraded);
  const url = readUrl(location.pathname, location.search);
  const library = useLibrary.getState();
  if (!url.live && url.session == null) {
    library.setLink(null);
    return url.circuit ? useReplay.getState().showCircuit(url.circuit) : useReplay.getState().showHome();
  }
  // Off Home already, so opening doesn't push an entry.
  useReplay.setState({ view: "replay" });
  const opts = { t: url.t, drivers: url.drivers, focus: url.focus, view: url.view, range: url.range };
  if (url.live) {
    library.setLink(null);
    return useReplay.getState().enterLive({ session: url.session, ...opts });
  }
  // A shared link's set-up: shown when its session is (the address bar drops it once the session's open).
  if (url.compare) useQuali.getState().applyLink(url.session!, url.compare);
  if (url.layout) void decodeLayout(url.layout).then((shared) => shared && useLayout.getState().showShared(shared.kind, shared.layout));
  else if (url.dash) useLayout.getState().requestDashboard(url.dash, url.live ? null : url.session);
  // A shared link: open it if it's here; carry on streaming it if its download is under way (a reload); otherwise
  // offer to watch it (downloading it, from `t`).
  const key = url.session!;
  if (useReplay.getState().index.some((e) => e.sessionKey === key)) return library.watchNow(key, opts);
  const row = rowForKey(key, library);
  const state = row ? rowState(row, library) : null;
  if (row && (state?.kind === "job" || state?.kind === "partial") && !(state.kind === "job" && state.job.phase === "failed")) {
    return library.stream(row, opts);
  }
  library.setLink({ key, opts });
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
  // Practice's Fastest laps (qualifying is always the comparison: nothing to say).
  const laps = useReplay((s) => comparing(s) && s.session?.meta.practice != null);
  const lapWindow = useReplay((s) => s.lapWindow);
  // The dashboard, where there's one on screen and it isn't the first (a shared link's layout isn't one).
  const dash = useLayout((s) => (s.shared || s.dashboard === FIRST ? undefined : s.dashboard));
  const grid = useReplay((s) => !comparing(s));
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
      const url = urlFor({ live, session: session ?? null, t: second >= 0 ? second * 1000 : undefined, drivers: selected, focus: focused, view: laps ? "laps" : undefined, range: lapWindow ? [lapWindow[0], lapWindow[1]] : undefined, dash: grid ? dash : undefined });
      if (url === location.pathname + location.search) return;
      lastWrite.current = performance.now();
      // Keeps the entry's state (whether it was opened from Home).
      history.replaceState(history.state, "", url);
    };
    // During fast playback `second` changes ~10×/s: write at most once per interval, always ending on the latest state.
    const wait = lastWrite.current + MIN_WRITE_INTERVAL_MS - performance.now();
    if (wait <= 0) {
      write();
      return;
    }
    const id = setTimeout(write, wait);
    return () => clearTimeout(id);
  }, [view, session, live, second, selected, focused, laps, lapWindow, dash, grid]);
}
