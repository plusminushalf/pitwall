// A circuit's forecast, fetched once per circuit and kept for half an hour (Open-Meteo's models update every hour
// or few): Home's header and the circuit page share it.

import { useEffect, useState } from "react";
import { CIRCUIT_COORDS, fetchForecast, type Forecast } from "./forecast";

const TTL_MS = 30 * 60_000;
const cache = new Map<number, Promise<Forecast>>();

function load(circuitKey: number): Promise<Forecast> {
  const hit = cache.get(circuitKey);
  if (hit) return hit;
  const p = fetchForecast(CIRCUIT_COORDS[circuitKey]);
  cache.set(circuitKey, p);
  // A failure is tried again next time; a forecast, after the TTL.
  p.then(
    () => setTimeout(() => cache.get(circuitKey) === p && cache.delete(circuitKey), TTL_MS),
    () => cache.get(circuitKey) === p && cache.delete(circuitKey),
  );
  return p;
}

export type ForecastState = { status: "loading" } | { status: "ready"; forecast: Forecast } | { status: "error" };

/** The forecast at a circuit; null if there's nothing to fetch (no circuit, or one without coordinates, or `skip`). */
export function useForecast(circuitKey: number | null, skip = false): ForecastState | null {
  const key = circuitKey != null && CIRCUIT_COORDS[circuitKey] && !skip ? circuitKey : null;
  const [state, setState] = useState<{ key: number; s: ForecastState } | null>(null);
  useEffect(() => {
    if (key == null) return;
    let live = true;
    load(key).then(
      (forecast) => live && setState({ key, s: { status: "ready", forecast } }),
      () => live && setState({ key, s: { status: "error" } }),
    );
    return () => {
      live = false;
    };
  }, [key]);
  if (key == null) return null;
  return state?.key === key ? state.s : { status: "loading" };
}
