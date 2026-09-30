import { useEffect, useState } from "react";
import { getVault, type LiveTopic } from "../../vault/client";

/** The arrival strip's window: one bucket per second. */
export const STRIP_SECONDS = 120;

export type LiveStats = {
  /** Messages received per topic since the panel mounted. */
  counts: Partial<Record<LiveTopic, number>>;
  total: number;
  /** Messages per second, oldest first, the last STRIP_SECONDS seconds (the current second last). */
  perSecond: number[];
};

/**
 * Counts the live data this tab receives (vault `data` events): per topic, and per second over the last two
 * minutes, so a gap in the stream shows as a hole in the strip. Re-renders once a second.
 */
export function useLiveStats(): LiveStats {
  const [stats, setStats] = useState<LiveStats>(() => ({ counts: {}, total: 0, perSecond: Array(STRIP_SECONDS).fill(0) }));
  useEffect(() => {
    const counts: Partial<Record<LiveTopic, number>> = {};
    let total = 0;
    const buckets = new Map<number, number>();
    const off = getVault().onData((topic, messages) => {
      counts[topic] = (counts[topic] ?? 0) + messages.length;
      total += messages.length;
      const s = Math.floor(Date.now() / 1000);
      buckets.set(s, (buckets.get(s) ?? 0) + messages.length);
    });
    const tick = () => {
      const now = Math.floor(Date.now() / 1000);
      for (const k of buckets.keys()) if (k <= now - STRIP_SECONDS) buckets.delete(k);
      const perSecond = Array.from({ length: STRIP_SECONDS }, (_, i) => buckets.get(now - STRIP_SECONDS + 1 + i) ?? 0);
      setStats({ counts: { ...counts }, total, perSecond });
    };
    const t = setInterval(tick, 1000);
    return () => {
      off();
      clearInterval(t);
    };
  }, []);
  return stats;
}
