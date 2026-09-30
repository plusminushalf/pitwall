import { useEffect, useState } from "react";
import { getVault, type LiveTopic, type SimStatus } from "../../vault/client";

/** The coverage strips' window: one bucket per second of message time (sim time in simulate mode). */
export const COVERAGE_SECONDS = 180;

export type Coverage = {
  /** The strip's right edge (ms): the sim clock in simulate mode, else the wall clock. */
  now: number;
  /** Per topic: messages per second of their own `date` (or `date_start`), oldest first, COVERAGE_SECONDS long. */
  perTopic: Partial<Record<LiveTopic, number[]>>;
};

const dateOf = (m: Record<string, unknown>) => {
  const d = typeof m.date === "string" ? m.date : typeof m.date_start === "string" ? m.date_start : null;
  return d ? Date.parse(d) : NaN;
};

/** The sim clock (ms) at wall time `wall`. */
export const simTime = (sim: SimStatus, wall = Date.now()) => sim.anchorWall + (wall - sim.anchorWall) * sim.speed;

/**
 * Coverage in message time: each message this tab received counts in the bucket of its own date, so a gap in
 * the stream is a hole in the strip, and a gap-fill closes it (the late rows land where they belong). In
 * simulate mode the window follows the sim clock. Re-renders once a second.
 */
export function useCoverage(sim: SimStatus | undefined): Coverage {
  const [cov, setCov] = useState<Coverage>({ now: Date.now(), perTopic: {} });
  const speed = sim?.speed;
  const anchor = sim?.anchorWall;
  useEffect(() => {
    const clock = () => (speed !== undefined && anchor !== undefined ? anchor + (Date.now() - anchor) * speed : Date.now());
    const buckets = new Map<LiveTopic, Map<number, number>>();
    const off = getVault().onData((topic, messages) => {
      let b = buckets.get(topic);
      if (!b) buckets.set(topic, (b = new Map()));
      for (const m of messages) {
        const t = dateOf(m);
        if (Number.isNaN(t)) continue;
        const s = Math.floor(t / 1000);
        b.set(s, (b.get(s) ?? 0) + 1);
      }
    });
    const tick = () => {
      const now = clock();
      const end = Math.floor(now / 1000);
      const perTopic: Coverage["perTopic"] = {};
      for (const [topic, b] of buckets) {
        for (const k of b.keys()) if (k <= end - COVERAGE_SECONDS * 4) b.delete(k);
        perTopic[topic] = Array.from({ length: COVERAGE_SECONDS }, (_, i) => b.get(end - COVERAGE_SECONDS + 1 + i) ?? 0);
      }
      setCov({ now, perTopic });
    };
    const t = setInterval(tick, 1000);
    return () => {
      off();
      clearInterval(t);
    };
  }, [speed, anchor]);
  return cov;
}
