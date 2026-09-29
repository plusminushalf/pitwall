// Raw OpenF1 response cache, independent of where files live. The cache is gzip-compressed
// (`<file>.gz`, ~10x smaller: a race is ~220 MB of JSON); an uncompressed legacy `<file>` is still read.
// Bun keeps it in data/raw/<key>/ (scripts/openf1.ts), the browser worker in OPFS (spikes/s1).

export type Bytes = Uint8Array<ArrayBuffer>;

/** File and gzip primitives a cache (and ingest) runs on. Paths are `/`-separated. */
export interface RawCacheIO {
  /** A file's bytes, or undefined if it doesn't exist. */
  readFile(path: string): Promise<Bytes | undefined>;
  /** Write a file so an interrupted run never leaves a truncated one. */
  writeFileAtomic(path: string, bytes: Bytes): Promise<void>;
  gzip(bytes: Bytes): Promise<Bytes>;
  gunzip(bytes: Bytes): Promise<Bytes>;
}

const decoder = new TextDecoder();
const encoder = new TextEncoder();

/** Read a cached JSON value for `cacheFile` (`.gz` first, then legacy plain), or undefined. */
export async function readCache<T>(io: RawCacheIO, cacheFile: string): Promise<T | undefined> {
  const gz = await io.readFile(`${cacheFile}.gz`);
  if (gz) return JSON.parse(decoder.decode(await io.gunzip(gz))) as T;
  const plain = await io.readFile(cacheFile);
  if (plain) return JSON.parse(decoder.decode(plain)) as T;
  return undefined;
}

/** Write `data` to `<cacheFile>.gz` atomically. */
export async function writeCache(io: RawCacheIO, cacheFile: string, data: unknown): Promise<void> {
  await io.writeFileAtomic(`${cacheFile}.gz`, await io.gzip(encoder.encode(JSON.stringify(data))));
}
