// Spike S1 (docs/modular-hypotheses.md): processed sessions in the browser's origin-private file system
// (OPFS), written by the in-browser ingest worker (spike-s1.html). Only used with `?source=opfs`.
// Every file is stored gzipped: `/sessions/11377/meta.json` lives at OPFS `sessions/11377/meta.json.gz`.

export type Bytes = Uint8Array<ArrayBuffer>;

// The slice of the File System API used for reading, declared here because src/data is also
// typechecked without DOM types (scripts/tsconfig.json).
interface Dir {
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<Dir>;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<{ getFile(): Promise<Blob> }>;
}
const opfsRoot = () => (navigator as unknown as { storage: { getDirectory(): Promise<Dir> } }).storage.getDirectory();

/** The directory holding `path`'s last segment, creating parents if asked. */
export async function opfsParent(path: string, create = false): Promise<[Dir, string]> {
  const parts = path.split("/").filter(Boolean);
  const name = parts.pop();
  if (!name) throw new Error(`Bad OPFS path "${path}"`);
  let dir = await opfsRoot();
  for (const p of parts) dir = await dir.getDirectoryHandle(p, { create });
  return [dir, name];
}

/** A file's contents, or undefined if it (or a parent directory) doesn't exist. */
export async function opfsFile(path: string): Promise<Blob | undefined> {
  try {
    const [dir, name] = await opfsParent(path);
    return await (await dir.getFileHandle(name)).getFile();
  } catch (e) {
    const name = (e as { name?: string }).name;
    if (name === "NotFoundError" || name === "TypeMismatchError") return undefined;
    throw e;
  }
}

const pipe = (data: Blob | Bytes, t: CompressionStream | DecompressionStream) =>
  new Response((data instanceof Blob ? data : new Blob([data])).stream().pipeThrough(t));

export const gzipBytes = async (b: Bytes): Promise<Bytes> => new Uint8Array(await pipe(b, new CompressionStream("gzip")).arrayBuffer());
export const gunzipBytes = async (b: Blob | Bytes): Promise<Bytes> =>
  new Uint8Array(await pipe(b, new DecompressionStream("gzip")).arrayBuffer());

/** Parse the gzipped JSON stored for `path` (a `/sessions/...` URL path, without `.gz`). */
export async function opfsJson<T>(path: string): Promise<T> {
  const file = await opfsFile(`${path}.gz`);
  if (!file) throw new Error(`not in browser storage (OPFS): ${path}`);
  return (await pipe(file, new DecompressionStream("gzip")).json()) as T;
}
