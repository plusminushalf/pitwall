// Messages between the page (src/ingest/runner.ts) and the ingest worker (worker.ts). One worker per job:
// it's terminated when the job ends or is cancelled, which also frees normalize's memory.

import type { IngestTimings } from "../../scripts/lib/ingestCore";
import type { LibraryEntry, StoreBackend } from "../storage/sessionStore";

/** download: fetch what's missing from OpenF1, then process. reprocess: raw responses already stored, no network. */
export type JobMode = "download" | "reprocess";

export interface IngestRequest {
  type: "ingest";
  key: number;
  mode: JobMode;
  backend: StoreBackend;
}

/** Why a job stopped without finishing. */
export type FailureKind =
  /** OpenF1 locks the free tier out while a session is live: wait for the window to end. */
  | "live-window"
  /** Re-processing found raw responses missing: download again. */
  | "raw-missing"
  /** Browser storage is full. */
  | "quota"
  | "error";

export type FromWorker =
  /** Raw files already stored when the job started (name -> bytes), and the driver list if known. */
  | { type: "start"; cached: Record<string, number>; drivers: number[] | null }
  /** A request is about to be sent (after the rate-limit wait). */
  | { type: "fetch"; file: string; endpoint: string; params: Record<string, string | number> }
  /** A response arrived (or a cached file was read). */
  | { type: "fetched"; file: string; source: "cache" | "network"; ms: number }
  /** A downloaded response was written to the raw cache. */
  | { type: "stored"; file: string; bytes: number }
  | { type: "drivers"; numbers: number[] }
  /** A request will be retried after `waitMs` (rate limit / server error). */
  | { type: "retry"; status: number; waitMs: number }
  | { type: "phase"; phase: "download" | "normalize" | "write" }
  | { type: "log"; line: string; warn?: boolean }
  | { type: "done"; entry: LibraryEntry; timings: IngestTimings; requests: number; status429: number }
  | { type: "failed"; kind: FailureKind; message: string; detail?: string };
