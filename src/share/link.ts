// The link that goes with a shared screenshot: the session at this moment, with the drivers picked, and how the screen
// is set up: the dashboard if it's a preset as it ships (by name), else the widget layout itself, or the lap
// comparison's set-up (../url.ts).

import { BUILTIN_WIDGETS } from "../grid/builtins";
import { FIRST, PRESETS } from "../grid/dashboards";
import { COLUMNS, type Layout } from "../grid/layout";
import { parseLayout, type GridKind } from "../grid/storage";
import { useLayout } from "../grid/store";
import { useQuali } from "../qualiStore";
import { comparing, useReplay } from "../store";
import { circuitPath, urlFor, type UrlState } from "../url";
import { encodeLayout } from "./layoutCode";

export const PUBLIC_SITE = "https://pitwall.plusminushalf.com";

/**
 * Where shared links point: this site, or the public one from a local build (`bun run live`'s), which no one else
 * can open. The dev server's links stay local, so they can be tried.
 */
export function siteOrigin(): string {
  const local = /^(localhost|127\.|\[::1\]$)/.test(location.hostname);
  return local && !import.meta.env.DEV ? PUBLIC_SITE : location.origin;
}

/** Whether two layouts are the same once read as a saved one is (versions and settings made current). */
const sameLayout = (a: Layout, b: Layout, kind: GridKind) => {
  const read = (l: Layout) => JSON.stringify(parseLayout(l, BUILTIN_WIDGETS, COLUMNS, kind));
  return read(a) === read(b);
};

/**
 * The link to what's on screen now. Live, it's the session at this moment (to watch back); off a session (Home, a
 * circuit's page, live mode waiting for one), the page.
 */
export async function shareLink(): Promise<string> {
  const s = useReplay.getState();
  if (s.view === "home") return siteOrigin() + "/";
  if (s.view === "circuit" && s.circuit) return siteOrigin() + circuitPath(s.circuit);
  const meta = s.session?.meta;
  if (!meta) return siteOrigin() + location.pathname;
  const compare = comparing(s);
  const state: UrlState = { live: false, session: meta.sessionKey, drivers: s.selected, focus: s.focused };
  if (compare) {
    if (meta.practice) state.view = "laps";
    state.compare = useQuali.getState().link();
  } else {
    state.t = s.t;
    if (s.lapWindow) state.range = [s.lapWindow[0], s.lapWindow[1]];
    const { layout, kind } = useLayout.getState();
    const preset = PRESETS[kind].find((p) => sameLayout(layout, p.layout, kind));
    if (!preset) state.layout = await encodeLayout(kind, layout);
    else if (preset.id !== FIRST) state.dash = preset.id;
  }
  return siteOrigin() + urlFor(state);
}
