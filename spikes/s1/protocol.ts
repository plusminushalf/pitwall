// Messages between the spike page (main.ts) and the ingest worker (worker.ts).

import type { IngestEvent, IngestTimings } from "../../scripts/lib/ingestCore";

/** network: fetch from OpenF1 (free tier). compute: copy data/raw/<key> from the dev server into OPFS, then ingest from that cache. */
export type Mode = "network" | "compute";

export type ToWorker =
  | { type: "run"; key: number; mode: Mode; rawBase: string }
  | { type: "hashes"; key: number }
  | { type: "usage"; key: number }
  | { type: "clear" };

export interface RunResult {
  key: number;
  mode: Mode;
  ok: boolean;
  error?: string;
  /** Wall time of the whole run in the worker (seed + ingest), ms. */
  totalMs: number;
  /** compute mode: copying the raw .json.gz files from the dev server into OPFS. */
  seedMs: number;
  seedBytes: number;
  timings: IngestTimings;
  requests: number;
  status429: number;
  otherErrors: number;
  outputFiles: number;
  outputJsonBytes: number;
  outputGzBytes: number;
  writeApi: string;
  /** network mode: the live-window check before the run. */
  liveCheck?: string;
}

export type FromWorker =
  | { type: "log"; line: string; warn?: boolean }
  | { type: "event"; e: IngestEvent }
  | { type: "request"; status: number; ms: number; requests: number; status429: number }
  | { type: "seed"; done: number; total: number }
  | { type: "done"; result: RunResult }
  | { type: "hashes"; files: Record<string, { sha256: string; bytes: number }> }
  | { type: "usage"; raw: number; processed: number; rawFiles: number; processedFiles: number }
  | { type: "cleared" }
  | { type: "error"; message: string };
