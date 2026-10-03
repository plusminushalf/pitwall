// The link that goes with a shared screenshot: the session at this moment, with the drivers picked, and what the
// address bar doesn't carry: the widget layout (if it isn't the default) or the lap comparison's set-up (../url.ts).

import { BUILTIN_WIDGETS } from "../grid/builtins";
import { DEFAULT_LAYOUTS } from "../grid/defaultLayout";
import { COLUMNS, type Layout } from "../grid/layout";
import { parseLayout, type GridKind } from "../grid/storage";
import { useLayout } from "../grid/store";
import { useQuali } from "../qualiStore";
import { comparing, useReplay } from "../store";
import { urlFor, type UrlState } from "../url";
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

/** The link to what's on screen now; null on Home. Live, it's the session at this moment (to watch back). */
export async function shareLink(): Promise<string | null> {
  const s = useReplay.getState();
  const meta = s.session?.meta;
  if (!meta) return null;
  const compare = comparing(s);
  const state: UrlState = { live: false, session: meta.sessionKey, drivers: s.selected, focus: s.focused };
  if (compare) {
    if (meta.practice) state.view = "laps";
    state.compare = useQuali.getState().link();
  } else {
    state.t = s.t;
    const { layout, kind } = useLayout.getState();
    if (!sameLayout(layout, DEFAULT_LAYOUTS[kind], kind)) state.layout = await encodeLayout(kind, layout);
  }
  return siteOrigin() + urlFor(state);
}
