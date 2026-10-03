// A widget layout in a link (`layout=…`, ../url.ts): its kind and the layout as JSON, deflated and base64url'd. The
// default race layout comes to ~300 characters. Read back, it's checked and repaired like a saved one
// (grid/storage.ts's parseLayout), so a link made with widgets this build doesn't have still opens.

import { BUILTIN_WIDGETS } from "../grid/builtins";
import type { Layout } from "../grid/layout";
import { parseLayout, type GridKind } from "../grid/storage";

const KINDS: GridKind[] = ["race", "practice"];

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Response(new Blob([bytes as BlobPart]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}

const toBase64Url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromBase64Url = (code: string) => Uint8Array.from(atob(code.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

export async function encodeLayout(kind: GridKind, layout: Layout): Promise<string> {
  const json = JSON.stringify({ k: kind, l: layout });
  return toBase64Url(await pipe(new TextEncoder().encode(json), new CompressionStream("deflate-raw")));
}

/** The layout a link carries, repaired against the widgets this build has; null if it isn't one. */
export async function decodeLayout(code: string): Promise<{ kind: GridKind; layout: Layout } | null> {
  try {
    const json = new TextDecoder().decode(await pipe(fromBase64Url(code), new DecompressionStream("deflate-raw")));
    const raw = JSON.parse(json) as { k?: unknown; l?: unknown };
    const kind = KINDS.find((k) => k === raw.k);
    const layout = kind ? parseLayout(raw.l, BUILTIN_WIDGETS, undefined, kind) : null;
    return kind && layout ? { kind, layout } : null;
  } catch {
    return null;
  }
}
