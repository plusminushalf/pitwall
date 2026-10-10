// Which circuit history file (src/history/types.ts) goes with an OpenF1 session, and fetching it.

import { CIRCUIT_HISTORY_FORMAT, type CircuitHistory, type CircuitHistoryIndex } from "./types";

export { fetchHistoryFile };

/**
 * F1DB's circuit id for each OpenF1 circuit_key. Keyed by circuit, not by Grand Prix: the 2026 Bahrain Grand Prix,
 * held at Sepang, is circuit_key 12 and gets Sepang's history. A circuit OpenF1 adds needs a line here.
 */
export const F1DB_CIRCUIT: Readonly<Record<number, string>> = {
  2: "silverstone",
  4: "hungaroring",
  6: "imola",
  7: "spa-francorchamps",
  9: "austin",
  10: "melbourne",
  12: "sepang", // "Kuala Lumpur"
  14: "interlagos",
  15: "catalunya",
  19: "spielberg",
  22: "monaco",
  23: "montreal",
  39: "monza",
  46: "suzuka",
  49: "shanghai",
  55: "zandvoort",
  61: "marina-bay",
  63: "bahrain", // Sakhir
  65: "mexico-city",
  70: "yas-marina",
  144: "baku",
  149: "jeddah",
  150: "lusail",
  151: "miami",
  152: "las-vegas",
  153: "madring",
};

/** Where the build puts the files (scripts/circuit-history.ts), relative to the site root. */
export const HISTORY_DIR = "/history/circuits";

export const circuitHistoryPath = (f1dbId: string) => `${HISTORY_DIR}/${f1dbId}.json`;

/**
 * A static file, or null if there isn't one: the site answers a missing path with index.html (wrangler.jsonc's
 * single-page-application fallback), and a deploy whose history step failed has no files at all.
 */
async function fetchHistoryFile<T extends { format: number }>(path: string, signal?: AbortSignal, format = CIRCUIT_HISTORY_FORMAT): Promise<T | null> {
  const res = await fetch(path, { signal });
  if (!res.ok || !res.headers.get("content-type")?.includes("application/json")) return null;
  const body = (await res.json()) as T;
  return body.format === format ? body : null;
}

/** The history of an OpenF1 circuit, or null if it isn't mapped or wasn't built. */
export function fetchCircuitHistory(circuitKey: number, signal?: AbortSignal): Promise<CircuitHistory | null> {
  const id = F1DB_CIRCUIT[circuitKey];
  return id ? fetchHistoryFile<CircuitHistory>(circuitHistoryPath(id), signal) : Promise.resolve(null);
}

export const fetchCircuitHistoryIndex = (signal?: AbortSignal) =>
  fetchHistoryFile<CircuitHistoryIndex>(`${HISTORY_DIR}/index.json`, signal);
