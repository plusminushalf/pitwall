// Minimal OpenF1 client for Bun: rate-limited to stay under OpenF1's limits, retries on 429/5xx, and
// caches raw responses on disk so re-runs never re-download. The HTTP client itself is platform-agnostic
// (lib/openf1Http.ts), as is the cache format (lib/rawCache.ts); this file adds process.env and files.
//
// Without credentials it uses the free tier (30 req/min, 3 req/s). With OPENF1_USERNAME and
// OPENF1_PASSWORD set (paid "sponsor" tier, needed for live sessions) requests carry an OAuth
// bearer token and may go faster (60 req/min, 6 req/s). Credentials and tokens never leave the server.

import { rename } from "node:fs/promises";
import { setCredentialSource, type Credentials } from "./lib/openf1Http";
import { readCache as readCacheWith, writeCache as writeCacheWith, type RawCacheIO } from "./lib/rawCache";

// The HTTP client (throttling, retries, tokens) is platform-agnostic and shared with the browser worker.
export {
  AuthError,
  TOKEN_URL,
  accessToken,
  fetchCircuit,
  fetchEndpoint,
  invalidateToken,
  setRequestInterval,
  tokenExpiresAt,
  type Credentials,
} from "./lib/openf1Http";

/** OPENF1_USERNAME / OPENF1_PASSWORD from the environment (Bun loads `.env`), or null. */
export function credentials(): Credentials | null {
  const username = process.env.OPENF1_USERNAME?.trim();
  const password = process.env.OPENF1_PASSWORD;
  return username && password ? { username, password } : null;
}
setCredentialSource(credentials);

/** The raw cache on disk (data/raw/<key>/), paths relative to the working directory. */
export const bunCacheIO: RawCacheIO = {
  async readFile(path) {
    const file = Bun.file(path);
    return (await file.exists()) ? file.bytes() : undefined;
  },
  async writeFileAtomic(path, bytes) {
    const tmp = `${path}.tmp`;
    await Bun.write(tmp, bytes);
    await rename(tmp, path);
  },
  gzip: async (bytes) => Bun.gzipSync(bytes),
  gunzip: async (bytes) => Bun.gunzipSync(bytes),
};

// The raw cache is gzip-compressed (`<file>.gz`, ~10x smaller: a race is ~220 MB of JSON).
// An uncompressed legacy `<file>` is still read if present.

/** Read a cached JSON value for `cacheFile` (`.gz` first, then legacy plain), or undefined. */
export const readCache = <T>(cacheFile: string): Promise<T | undefined> => readCacheWith<T>(bunCacheIO, cacheFile);

/** Write `data` to `<cacheFile>.gz` atomically, so an interrupted run never leaves a truncated cache entry. */
export const writeCache = (cacheFile: string, data: unknown): Promise<void> => writeCacheWith(bunCacheIO, cacheFile, data);

// Raw OpenF1 record shapes (only the fields we use), shared with the browser.
export type * from "./lib/openf1Types";
