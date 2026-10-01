// The app's addresses. The path says what's on screen, the query where in it you are (t in seconds of replay time):
//   /                                                Home
//   /session/11377?t=3725&drivers=1,63,55&focus=63   a session: its replay, or the offer to download it
//   /live?drivers=1,63&focus=63                      live mode; watching back a live session adds session=…&t=…
// Links from before paths (`/?session=11377&t=…`, `/?live=1`, the single `driver=63`) still open, and are upgraded.

/** What a URL asks for. `t` is in ms of replay time. */
export interface UrlState {
  live: boolean;
  session: number | null;
  t?: number;
  drivers: number[];
  focus: number | null;
}

const SESSION_PATH = /^\/session\/(\d+)\/?$/;
const LIVE_PATH = /^\/live\/?$/;
/** The query parameters this file owns; others (`?vault=debug`, `?now=`) are left alone. */
const OWN = new Set(["session", "live", "t", "drivers", "driver", "focus"]);

export const sessionPath = (key: number) => `/session/${key}`;
export const livePath = "/live";

export function readUrl(pathname: string, search: string): UrlState {
  const q = new URLSearchParams(search);
  const num = (k: string) => (q.has(k) && !Number.isNaN(Number(q.get(k))) ? Number(q.get(k)) : null);
  const path = SESSION_PATH.exec(pathname);
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
    live: LIVE_PATH.test(pathname) || q.get("live") === "1",
    session: path ? Number(path[1]) : num("session"),
    t: t != null ? t * 1000 : undefined,
    drivers,
    focus: num("focus") ?? legacy,
  };
}

/** The address of a view. Built by hand (all values are numbers) so the driver list keeps readable commas instead of %2C. */
export function urlFor(v: UrlState): string {
  if (!v.live && v.session == null) return "/";
  const q: string[] = [];
  if (v.session != null && v.t != null) q.push(...(v.live ? [`session=${v.session}`] : []), `t=${Math.floor(v.t / 1000)}`);
  if (v.drivers.length > 0) q.push(`drivers=${v.drivers.join(",")}`);
  if (v.focus != null) q.push(`focus=${v.focus}`);
  const path = v.live ? livePath : sessionPath(v.session!);
  return q.length > 0 ? `${path}?${q.join("&")}` : path;
}

/** Today's address for a link from before paths, or to a path the app doesn't have (Home); null if it's fine as it is. */
export function upgradeUrl(pathname: string, search: string): string | null {
  const q = new URLSearchParams(search);
  const live = LIVE_PATH.test(pathname);
  const known = pathname === "/" || live || SESSION_PATH.test(pathname);
  const legacy = q.has("live") || q.has("driver") || (q.has("session") && !live);
  if (known && !legacy) return null;
  const url = urlFor(readUrl(pathname, search));
  const rest = new URLSearchParams([...q].filter(([k]) => !OWN.has(k))).toString();
  return rest === "" ? url : `${url}${url.includes("?") ? "&" : "?"}${rest}`;
}
