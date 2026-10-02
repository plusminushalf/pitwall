// Loading downloaded sessions for the replay, from the session store.

import { decodeLapTrace, type DecodedLap } from "../engine/compare";
import { buildSession, type Session } from "../data/session";
import { isCurrentFormat } from "../../scripts/lib/formatVersion";
import { sessionStore, storageSupported, type LibraryEntry } from ".";

/** The library's sessions that the replay can open (processed in this version of the app's format for their type), by date. */
export async function listPlayable(): Promise<LibraryEntry[]> {
  if (!storageSupported()) return [];
  return (await sessionStore().list()).filter(isCurrentFormat);
}

/** Load meta + every driver's telemetry, reporting progress in [0, 1]. */
export async function fetchSession(key: number, onProgress: (p: number) => void): Promise<Session> {
  const store = sessionStore();
  const meta = await store.readMeta(key);
  const total = meta.drivers.length + 1;
  let done = 1;
  onProgress(done / total);
  const telemetry = await Promise.all(
    meta.drivers.map(async (d) => {
      const tel = await store.readDriver(key, d.number);
      onProgress(++done / total);
      return tel;
    }),
  );
  return buildSession(meta, telemetry);
}

const lapCache = new Map<string, Promise<Map<number, DecodedLap>>>();

/** Every traced lap of one driver in a qualifying or finished practice session, by lap number (decoded once per session). */
export function fetchLapTraces(sessionKey: number, driver: number): Promise<Map<number, DecodedLap>> {
  const key = `${sessionKey}:${driver}`;
  let p = lapCache.get(key);
  if (!p) {
    p = sessionStore()
      .readLaps(sessionKey, driver)
      .then((tr) => new Map(tr.laps.map((l) => [l.lap, decodeLapTrace(driver, l)])));
    p.catch(() => lapCache.delete(key));
    lapCache.set(key, p);
  }
  return p;
}

/** Forget decoded lap traces of a session (it was deleted or re-processed). */
export function forgetSession(sessionKey: number): void {
  for (const k of [...lapCache.keys()]) if (k.startsWith(`${sessionKey}:`)) lapCache.delete(k);
}
