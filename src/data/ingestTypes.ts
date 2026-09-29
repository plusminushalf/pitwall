// Wire format of the dev server's race downloader API (/api/ingest, devserver/ingestPlugin.ts).
// Types only: shared by the Vite plugin (node) and the app.

/** OpenF1 access tier of the dev server: "sponsor" when OPENF1_USERNAME / OPENF1_PASSWORD are set. */
export type Tier = "sponsor" | "free";

/**
 * ready: processed and in public/sessions/index.json · partial: some raw files cached in data/raw/<key>
 * none: nothing downloaded · not-run: the session hasn't finished yet · cancelled: called off by F1
 */
export type RaceStatus = "ready" | "partial" | "none" | "not-run" | "cancelled";

export interface Estimate {
  /** Remaining download + processing time. */
  seconds: number;
  /** Remaining download size (gzipped raw cache). */
  mb: number;
}

export interface RaceRow {
  sessionKey: number;
  sessionName: string; // "Race" | "Sprint" | ...
  sessionType: string; // OpenF1 session_type
  meetingKey: number;
  meetingName: string; // "Australian Grand Prix"
  /** Championship round (meetings with a race that went ahead, in date order), null if cancelled. */
  round: number | null;
  dateStart: string;
  dateEnd: string;
  circuit: string;
  country: string;
  location: string;
  status: RaceStatus;
  /** Raw files cached so far (partial rows). */
  cachedFiles?: number;
  expectedFiles?: number;
  cachedBytes?: number;
  /** For rows that can still be downloaded (none / partial). */
  estimate?: Estimate;
}

export interface RacesResponse {
  year: number;
  tier: Tier;
  rows: RaceRow[];
}

export type JobPhase = "queued" | "downloading" | "processing" | "done" | "failed" | "cancelled";

export interface JobView {
  key: number;
  year: number;
  /** "Australian Grand Prix · Race" */
  label: string;
  phase: JobPhase;
  /** 1-based position in the queue (queued jobs only). */
  queuePosition: number | null;
  /** 1 on the first run, 2-3 on automatic retries after a failure. */
  attempt: number;
  cachedFiles: number;
  expectedFiles: number;
  /** Size of the cached raw files (gzipped), including earlier runs. */
  cachedBytes: number;
  /** Bytes cached by this run. */
  bytesThisRun: number;
  /** Estimated raw cache size once complete. */
  totalBytes: number;
  /** What's being fetched, e.g. "Car telemetry · #44 (12/22)". */
  step: string | null;
  /** e.g. "Rate-limited, retrying in 10s". */
  retryNotice: string | null;
  /** 0-1, weighted by expected time per file and processing. */
  progress: number;
  startedAt: number | null;
  finishedAt: number | null;
  etaSeconds: number | null;
  error: string | null;
}

export interface JobsResponse {
  tier: Tier | null;
  jobs: JobView[];
}
