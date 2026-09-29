import type { DriverTelemetry, SessionIndexEntry, SessionMeta } from "../types";
import { buildSession, type Session } from "./session";

const base = `${import.meta.env.BASE_URL}sessions`;

// Spike S1: `?source=opfs` reads sessions from browser storage (src/data/opfs.ts) instead of HTTP, and
// `?source=` (opfs or http) records a `s1:fetchSession` performance measure. Read once at startup,
// because the URL sync rewrites the query string.
const search = (globalThis as { location?: { search: string } }).location?.search ?? "";
export const source = new URLSearchParams(search).get("source");
const fromOpfs = source === "opfs";

async function getJson<T>(url: string): Promise<T> {
  if (fromOpfs) return (await import("./opfs")).opfsJson<T>(url);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} loading ${url}`);
  return res.json() as Promise<T>;
}

export const fetchIndex = () => getJson<SessionIndexEntry[]>(`${base}/index.json`);

/** Load meta + every driver's telemetry, reporting progress in [0, 1]. */
export async function fetchSession(key: number, onProgress: (p: number) => void): Promise<Session> {
  const start = source ? performance.now() : 0;
  const meta = await getJson<SessionMeta>(`${base}/${key}/meta.json`);
  const total = meta.drivers.length + 1;
  let done = 1;
  onProgress(done / total);
  const telemetry = await Promise.all(
    meta.drivers.map(async (d) => {
      const tel = await getJson<DriverTelemetry>(`${base}/${key}/drivers/${d.number}.json`);
      onProgress(++done / total);
      return tel;
    }),
  );
  const session = buildSession(meta, telemetry);
  if (source) performance.measure("s1:fetchSession", { start, detail: { source, key } });
  return session;
}
