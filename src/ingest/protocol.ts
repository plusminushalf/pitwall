// Messages between the page (src/ingest/runner.ts) and the ingest worker (worker.ts). One worker per job:
// it's terminated when the job ends or is cancelled, which also frees normalize's memory.

import type { IngestTimings } from "../../scripts/lib/ingestCore";
import type { LibraryEntry, StoreBackend } from "../storage/sessionStore";
import type { SessionMeta } from "../types";

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
  /** Being watched from the start (see the `watch` message). */
  watch?: { playhead: number | null };
  /** When this browser's last OpenF1 requests started (ms since epoch, the last minute): the pace counts them. */
  recentRequests?: number[];
}

/** Page -> worker after the request. */
export type ToWorker =
  | IngestRequest
  /** The page couldn't get a vault port after all (no vault, or it refused): go direct at once. */
  | { type: "no-vault"; reason: string }
  /** The job is being cancelled: tell the vault (its queued requests are dropped) before the worker goes. */
  | { type: "cancel" }
  /**
   * The race is being watched (stream.ts): stream it to the page, its telemetry fetched from `playhead` on (ms since
   * the replay's t0, as the replay's clock; null: from lights out). Sent again as the replay moves.
   */
  | { type: "watch"; playhead: number | null }
  /** Nobody's watching any more: just download. */
  | { type: "unwatch" };

/** One driver's telemetry over a span, as the replay keeps it (src/data/session.ts): times in ms since meta.t0. */
export interface StreamChunk {
  driver: number;
  /** Every sample of the driver in [from, to) (ms since meta.t0) is here. */
  from: number;
  to: number;
  loc: { t: Float64Array; x: Float32Array; y: Float32Array };
  car: {
    t: Float64Array;
    speed: Float32Array;
    rpm: Float32Array;
    gear: Uint8Array;
    throttle: Float32Array;
    brake: Float32Array;
    drs: Uint8Array | null;
  };
}

/** A race being watched while it downloads: what's new in its provisional replay. */
export interface StreamUpdate {
  type: "stream";
  key: number;
  /** The provisional meta when it changed (always in the first update), else null. */
  meta: SessionMeta | null;
  /** Telemetry of spans completed since the last update. */
  chunks: StreamChunk[];
  /** Every span with telemetry so far (ms since meta.t0), in order. */
  spans: [number, number][];
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
  /** Which way requests go: "vault" (signed in: the vault's budget, fast) or "direct" (free tier), and why. */
  | { type: "path"; path: "vault" | "direct"; reason: string }
  /** A request will be retried after `waitMs` (rate limit / server error). */
  | { type: "retry"; status: number; waitMs: number }
  | { type: "phase"; phase: "download" | "normalize" | "write" }
  | { type: "log"; line: string; warn?: boolean }
  | StreamUpdate
  /** A request straight to OpenF1 started then (ms since epoch): the free tier's pace counts it across workers. */
  | { type: "request"; at: number }
  /** How much of a race's telemetry is in (0-1), once its slices are planned. */
  | { type: "telemetry"; progress: number }
  | { type: "done"; entry: LibraryEntry; timings: IngestTimings; requests: number; status429: number }
  | { type: "failed"; kind: FailureKind; message: string; detail?: string };
