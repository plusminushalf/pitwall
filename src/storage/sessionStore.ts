// The app's only data source: sessions downloaded into the user's own browser. Everything that reads or
// writes race data goes through this interface; `handleStore.ts` implements it on a directory handle
// (the origin-private file system today; a folder on disk picked through the File System Access API
// would be the same code with another root).

import type { DriverLapTraces, DriverTelemetry, SessionIndexEntry, SessionMeta, SessionType } from "../types";

export type Bytes = Uint8Array<ArrayBuffer>;

/**
 * A processed session in the library. Written after all of its files, so its presence means the session
 * is complete.
 */
export interface LibraryEntry extends SessionIndexEntry {
  sessionType: SessionType;
  /** FORMAT_VERSION (scripts/lib/ingestCore.ts) of the app that processed it. */
  format: number;
  /** When it was processed (ISO). */
  processedAt: string;
  /** Stored size of the processed files and of the raw OpenF1 responses kept for re-processing (bytes). */
  processedBytes: number;
  rawBytes: number;
}

/**
 * A FileSystemDirectoryHandle, e.g. from showDirectoryPicker() (typed loosely: the pure parts of the ingest
 * code that import these types are also typechecked without DOM types).
 */
export interface DirectoryHandle {
  readonly kind: "directory";
  readonly name: string;
}

/** Where a store keeps its files; posted to the ingest worker so it opens the same store. */
export type StoreBackend = { kind: "opfs" } | { kind: "folder"; handle: DirectoryHandle };

export interface StorageUsage {
  /** navigator.storage.estimate(): everything this site stores in the browser, in bytes. */
  usage: number | null;
  quota: number | null;
  /** navigator.storage.persisted(): the browser won't clear it to free up space. */
  persisted: boolean | null;
}

export interface SessionStore {
  readonly backend: StoreBackend;

  // ---------------------------------------------------------------- library (the replay reads these)

  /** Complete processed sessions, by start date. */
  list(): Promise<LibraryEntry[]>;
  entry(key: number): Promise<LibraryEntry | undefined>;
  has(key: number): Promise<boolean>;
  readMeta(key: number): Promise<SessionMeta>;
  readDriver(key: number, driver: number): Promise<DriverTelemetry>;
  /** Qualifying lap traces (laps/<driver>.json). */
  readLaps(key: number, driver: number): Promise<DriverLapTraces>;
  /** Remove a session: processed files and raw responses. */
  delete(key: number): Promise<void>;
  usage(): Promise<StorageUsage>;

  // ---------------------------------------------------------------- raw OpenF1 responses (the ingest cache)
  // Gzipped JSON, one file per request, named like the CLI's data/raw/<key>/ (`laps`, `car_data_44`).

  /** Sessions with any raw responses stored. */
  rawSessions(): Promise<number[]>;
  /** Stored raw files of a session: name -> bytes. */
  rawFiles(key: number): Promise<Map<string, number>>;
  readRaw(key: number, name: string): Promise<Bytes | undefined>;
  /** Atomic: an interrupted write never leaves a truncated file. */
  writeRaw(key: number, name: string, gzipped: Bytes): Promise<void>;

  // ---------------------------------------------------------------- processed output (written by ingest)

  /** Drop a session's processed files (before writing new ones). */
  clearProcessed(key: number): Promise<void>;
  /** Write one processed file (`meta.json`, `drivers/44.json`, `laps/44.json`); resolves to its stored size. */
  writeProcessed(key: number, file: string, json: string): Promise<number>;
  /** Publish a fully written session to the library. */
  commit(entry: LibraryEntry): Promise<void>;

  // ---------------------------------------------------------------- small JSON documents (catalogue cache)

  readDoc<T>(name: string): Promise<T | undefined>;
  writeDoc(name: string, value: unknown): Promise<void>;
}
