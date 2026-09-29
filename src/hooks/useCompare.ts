import { useEffect, useMemo } from "react";
import { defaultLap } from "../data/quali";
import type { DecodedLap } from "../engine/compare";
import { compareStyles, type CompareStyle } from "../lib/compareColors";
import { MAX_COMPARE, useQuali } from "../qualiStore";
import { useReplay } from "../store";
import type { DriverInfo, Lap, QualiLap } from "../types";

export interface CompareEntry {
  driver: number;
  info: DriverInfo;
  lapNo: number | null;
  picked: boolean; // lap chosen by hand (else the preset's)
  lap: Lap | null;
  qlap: QualiLap | null;
  trace: DecodedLap | null; // null while loading, or when the lap has no trace
  loading: boolean;
  style: CompareStyle;
}

const NO_TRACES = new Map<number, Map<number, DecodedLap>>();

/** The compared drivers (the replay selection, first = reference) with their laps and traces. */
export function useCompare(): CompareEntry[] {
  const session = useReplay((s) => s.session);
  const selected = useReplay((s) => s.selected);
  const laps = useQuali((s) => s.laps);
  const preset = useQuali((s) => s.preset);
  const storeKey = useQuali((s) => s.sessionKey);
  const allTraces = useQuali((s) => s.traces);
  const key = session?.meta.sessionKey ?? null;
  // Traces of a previous session (before the store has been reset for this one) don't count.
  const traces = storeKey === key ? allTraces : NO_TRACES;
  const drivers = useMemo(() => selected.slice(0, MAX_COMPARE), [selected]);

  useEffect(() => {
    if (key == null) return;
    const q = useQuali.getState();
    q.reset(key);
    for (const n of drivers) q.ensureTraces(n);
  }, [key, drivers]);

  return useMemo(() => {
    const meta = session?.meta;
    if (!meta?.quali) return [];
    const q = meta.quali;
    const infos = drivers.map((n) => session!.drivers.get(n)?.info);
    const styles = compareStyles(infos);
    return drivers.flatMap((n, i) => {
      const info = infos[i];
      if (!info) return [];
      const picked = laps[n] != null;
      const lapNo = laps[n] ?? defaultLap(meta, n, preset);
      const byLap = traces.get(n);
      return [
        {
          driver: n,
          info,
          lapNo,
          picked,
          lap: lapNo != null ? (meta.laps.find((l) => l.driver === n && l.lap === lapNo) ?? null) : null,
          qlap: lapNo != null ? (q.laps.find((l) => l.driver === n && l.lap === lapNo) ?? null) : null,
          trace: lapNo != null ? (byLap?.get(lapNo) ?? null) : null,
          loading: !byLap,
          style: styles[i],
        },
      ];
    });
  }, [session, drivers, laps, preset, traces]);
}
