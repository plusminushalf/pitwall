// The app's addresses. The path says what's on screen, the query where in it you are (t in seconds of replay time):
//   /                                                Home
//   /session/11377?t=3725&drivers=1,63,55&focus=63   a session: its replay, or the offer to download it
//   /session/11228?view=laps&drivers=1,63            finished practice's Fastest laps (the lap comparison)
//   /session/11730?view=replay&t=1200                qualifying's replay (it opens on its laps compared)
//   /session/11731?t=3725&range=12-30                the lap charts zoomed to laps 12 to 30 (the timeline's zoom rail)
//   /live?drivers=1,63&focus=63                      live mode; watching back a live session adds session=…&t=…
//   /circuit/singapore                               a circuit: every session there, and its history (../circuit.ts)
//   /session/11377?dash=strategy                     a dashboard other than the first (grid/dashboards.ts); live too
// Shared links (share/ShareShot.tsx) can also say how the screen was set up:
//   layout=…                                         the widget layout (share/layoutCode.ts), if it isn't a preset's
//   zoom=120-560&preset=2&laps=1:14,63:12&mini=50&names=1   the lap comparison: its charts' distance window (m), the
//                                                    segment its laps come from, hand-picked laps, mini-sectors, corner names
// Links from before paths (`/?session=11377&t=…`, `/?live=1`, the single `driver=63`) still open, and are upgraded.

/** What a URL asks for. `t` is in ms of replay time. */
export interface UrlState {
  live: boolean;
  session: number | null;
  t?: number;
  drivers: number[];
  focus: number | null;
  /** The screen, when it isn't the one the session opens on: practice's Fastest laps, qualifying's replay. */
  view?: "laps" | "replay";
  /** The lap charts' lap window: first and last lap. Absent: the whole race. */
  range?: [number, number];
  /** A shared link's lap comparison set-up. Absent: the comparison's own defaults. */
  compare?: CompareLink;
  /** A shared link's widget layout, encoded (share/layoutCode.ts). Absent: the browser's own. */
  layout?: string;
  /** The dashboard (grid/dashboards.ts). Absent: the one the browser last showed. */
  dash?: string;
  /** A circuit's page (no session open): its slug (../circuit.ts). */
  circuit?: string;
}

/** How a shared link sets up the lap comparison (qualifying, practice's Fastest laps). */
export interface CompareLink {
  /** The charts' distance window, in m. */
  zoom?: [number, number];
  /** The segment the laps come from (Q1 = 1); absent, each driver's fastest. */
  preset?: number;
  /** Laps picked by hand, by driver. */
  laps?: Record<number, number>;
  /** Mini-sectors on the map. */
  mini?: number;
  /** Corner names on the map instead of numbers. */
  names?: true;
}

const SESSION_PATH = /^\/session\/(\d+)\/?$/;
const LIVE_PATH = /^\/live\/?$/;
const CIRCUIT_PATH = /^\/circuit\/([a-z0-9]+(?:-[a-z0-9]+)*)\/?$/;
/** The query parameters this file owns; others (`?vault=debug`, `?now=`) are left alone. */
const OWN = new Set(["session", "live", "t", "drivers", "driver", "focus", "view", "zoom", "preset", "laps", "mini", "names", "layout", "range"]);
const LAYOUT_CODE = /^[A-Za-z0-9_-]+$/;
/** A dashboard id, as grid/dashboards.ts checks it. */
const DASHBOARD_ID = /^[a-z0-9-]{1,40}$/;

export const sessionPath = (key: number) => `/session/${key}`;
export const livePath = "/live";
export const circuitPath = (slug: string) => `/circuit/${slug}`;

export function readUrl(pathname: string, search: string): UrlState {
  const q = new URLSearchParams(search);
  const num = (k: string) => (q.has(k) && !Number.isNaN(Number(q.get(k))) ? Number(q.get(k)) : null);
  const path = SESSION_PATH.exec(pathname);
  const circuit = CIRCUIT_PATH.exec(pathname)?.[1];
  const t = num("t");
  const legacy = num("driver");
  const range = /^(\d+)-(\d+)$/.exec(q.get("range") ?? "");
  const drivers = q.has("drivers")
    ? (q.get("drivers") ?? "")
        .split(",")
        .filter((v) => v.trim() !== "")
        .map(Number)
        .filter(Number.isInteger)
    : legacy != null
      ? [legacy]
      : [];
  const live = LIVE_PATH.test(pathname) || q.get("live") === "1";
  const session = path ? Number(path[1]) : num("session");
  return {
    live,
    session,
    t: t != null ? t * 1000 : undefined,
    drivers,
    focus: num("focus") ?? legacy,
    ...(path && (q.get("view") === "laps" || q.get("view") === "replay") ? { view: q.get("view") as "laps" | "replay" } : {}),
    ...(path && range && Number(range[1]) >= 1 && Number(range[1]) < Number(range[2]) ? { range: [Number(range[1]), Number(range[2])] as [number, number] } : {}),
    ...(path ? readShared(q) : {}),
    ...(DASHBOARD_ID.test(q.get("dash") ?? "") ? { dash: q.get("dash")! } : {}),
    ...(circuit && !live && session == null ? { circuit } : {}),
  };
}

/** A shared link's set-up (session paths only); what doesn't parse is left out. */
function readShared(q: URLSearchParams): Pick<UrlState, "compare" | "layout"> {
  const out: Pick<UrlState, "compare" | "layout"> = {};
  const compare: CompareLink = {};
  const positive = (v: string | null) => (v != null && /^\d+$/.test(v) && Number(v) > 0 ? Number(v) : null);
  const zoom = /^(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)$/.exec(q.get("zoom") ?? "");
  if (zoom && Number(zoom[1]) < Number(zoom[2])) compare.zoom = [Number(zoom[1]), Number(zoom[2])];
  const preset = positive(q.get("preset"));
  if (preset != null) compare.preset = preset;
  const laps = (q.get("laps") ?? "")
    .split(",")
    .map((pair) => /^(\d+):(\d+)$/.exec(pair))
    .filter((m) => m != null);
  if (laps.length > 0) compare.laps = Object.fromEntries(laps.map((m) => [Number(m[1]), Number(m[2])]));
  const mini = positive(q.get("mini"));
  if (mini != null) compare.mini = mini;
  if (q.get("names") === "1") compare.names = true;
  if (Object.keys(compare).length > 0) out.compare = compare;
  const layout = q.get("layout");
  if (layout && LAYOUT_CODE.test(layout)) out.layout = layout;
  return out;
}

/** The address of a view. Built by hand (all values are numbers) so the driver list keeps readable commas instead of %2C. */
export function urlFor(v: UrlState): string {
  if (!v.live && v.session == null) return v.circuit ? circuitPath(v.circuit) : "/";
  const q: string[] = [];
  if (!v.live && v.view) q.push(`view=${v.view}`);
  if (v.session != null && v.t != null) q.push(...(v.live ? [`session=${v.session}`] : []), `t=${Math.floor(v.t / 1000)}`);
  if (v.drivers.length > 0) q.push(`drivers=${v.drivers.join(",")}`);
  if (v.focus != null) q.push(`focus=${v.focus}`);
  if (v.dash) q.push(`dash=${v.dash}`);
  if (!v.live && v.range) q.push(`range=${v.range[0]}-${v.range[1]}`);
  if (!v.live) {
    const c = v.compare ?? {};
    if (c.zoom) q.push(`zoom=${Math.round(c.zoom[0])}-${Math.round(c.zoom[1])}`);
    if (c.preset != null) q.push(`preset=${c.preset}`);
    if (c.laps && Object.keys(c.laps).length > 0) q.push(`laps=${Object.entries(c.laps).map(([d, l]) => `${d}:${l}`).join(",")}`);
    if (c.mini != null) q.push(`mini=${c.mini}`);
    if (c.names) q.push("names=1");
    if (v.layout) q.push(`layout=${v.layout}`);
  }
  const path = v.live ? livePath : sessionPath(v.session!);
  return q.length > 0 ? `${path}?${q.join("&")}` : path;
}

/** Today's address for a link from before paths, or to a path the app doesn't have (Home); null if it's fine as it is. */
export function upgradeUrl(pathname: string, search: string): string | null {
  const q = new URLSearchParams(search);
  const live = LIVE_PATH.test(pathname);
  const known = pathname === "/" || live || SESSION_PATH.test(pathname) || CIRCUIT_PATH.test(pathname);
  const legacy = q.has("live") || q.has("driver") || (q.has("session") && !live);
  if (known && !legacy) return null;
  const url = urlFor(readUrl(pathname, search));
  const rest = new URLSearchParams([...q].filter(([k]) => !OWN.has(k))).toString();
  return rest === "" ? url : `${url}${url.includes("?") ? "&" : "?"}${rest}`;
}
