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
  /**
   * A port the credential vault serves (the page asked for it with `openPort` and transferred it here), for
   * signed-in downloads: requests go worker <-> vault directly. Data only: no token ever comes over it.
   */
  vault?: MessagePort;
}

/** Page -> worker after the request. */
export type ToWorker =
  | IngestRequest
  /** The page couldn't get a vault port after all (no vault, or it refused): go direct at once. */
  | { type: "no-vault"; reason: string }
  /** The job is being cancelled: tell the vault (its queued requests are dropped) before the worker goes. */
  | { type: "cancel" };

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
  /** Which way requests go: "vault" (signed in: the vault's budget, fast) or "direct" (free tier), and why. */
  | { type: "path"; path: "vault" | "direct"; reason: string }
  /** A request will be retried after `waitMs` (rate limit / server error). */
  | { type: "retry"; status: number; waitMs: number }
  | { type: "phase"; phase: "download" | "normalize" | "write" }
  | { type: "log"; line: string; warn?: boolean }
  | { type: "done"; entry: LibraryEntry; timings: IngestTimings; requests: number; status429: number }
  | { type: "failed"; kind: FailureKind; message: string; detail?: string };
