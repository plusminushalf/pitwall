// Client for the dev server's race downloader (/api/ingest, served by devserver/ingestPlugin.ts).

import type { JobsResponse, JobView, RacesResponse } from "./ingestTypes";

const BASE = "/api/ingest";

/**
 * The downloader API isn't there: a static `vite build` / `vite preview`, or a dev server without the plugin.
 * Those answer with the app's HTML (SPA fallback) or a non-JSON 404.
 */
export class IngestUnavailable extends Error {
  override name = "IngestUnavailable";
}

async function call<T>(path: string, method = "GET"): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, { method, headers: { Accept: "application/json" } });
  } catch (e) {
    throw new Error(`Can't reach the dev server (${e instanceof Error ? e.message : e})`);
  }
  if (!res.headers.get("content-type")?.includes("application/json")) {
    throw new IngestUnavailable(`No race downloader at ${BASE} (HTTP ${res.status})`);
  }
  const body = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body;
}

export const fetchRaces = (year: number) => call<RacesResponse>(`/races?year=${year}`);
export const fetchJobs = () => call<JobsResponse>("/jobs");
/** Queue a download (or resume one); `year` lets the server look the session up if it hasn't listed it yet. */
export const startJob = (key: number, year: number) => call<JobView>(`/jobs/${key}?year=${year}`, "POST");
/** Cancel a queued download or pause a running one (downloaded files are kept). */
export const cancelJob = (key: number) => call<JobView>(`/jobs/${key}`, "DELETE");
