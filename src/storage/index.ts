// The session store the app uses: the browser's origin-private file system (OPFS).

import { handleStore } from "./handleStore";
import type { SessionStore, StoreBackend } from "./sessionStore";

export type { LibraryEntry, SessionStore, StorageUsage, StoreBackend } from "./sessionStore";

/** Open the store behind `backend` (the ingest worker opens the page's store from its backend). */
export function openStore(backend: StoreBackend): SessionStore {
  return handleStore(backend, async () => (backend.kind === "opfs" ? navigator.storage.getDirectory() : (backend.handle as FileSystemDirectoryHandle)));
}

let current: SessionStore | null = null;

/** The app's store. */
export function sessionStore(): SessionStore {
  return (current ??= openStore({ kind: "opfs" }));
}

/** Browser storage the app can't run without (OPFS needs a secure context: https or localhost). */
export function storageSupported(): boolean {
  return typeof navigator !== "undefined" && typeof navigator.storage?.getDirectory === "function" && typeof DecompressionStream !== "undefined";
}
