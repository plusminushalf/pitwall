// OpenF1's stints sometimes miss a stop: the pit records and the pit-out lap are there, but the stint
// before it runs on to the flag (2026 Kuala Lumpur: VER's stops on laps 33 and 43). Split a stint at
// each stop with no stint starting after it. What went on is unknown: the new stint's compound is
// UNKNOWN and its age at the start null (teams fit used sets, so it isn't 0).

import type { Lap, PitStop, RaceControlMsg, Stint } from "../../src/types";

/** Drive-throughs and stop-go penalties go through the pit lane with no tyre change. */
const NO_TYRES = /DRIVE[ -]THROUGH|STOP\s*\/\s*GO|STOP[ -]AND[ -]GO|STOP-GO/i;

/** Races only: in practice and qualifying cars come in without changing tyres. */
export function repairStints(
  stints: readonly Stint[],
  pits: readonly PitStop[],
  laps: readonly Lap[],
  raceControl: readonly Pick<RaceControlMsg, "t" | "message" | "driver">[],
): { stints: Stint[]; added: number } {
  const byDriver = new Map<number, Stint[]>();
  for (const s of stints) {
    const own = byDriver.get(s.driver);
    if (own) own.push({ ...s });
    else byDriver.set(s.driver, [{ ...s }]);
  }
  const penalties = raceControl.flatMap((m) => {
    if (!m.message.includes("PENALTY") || !NO_TYRES.test(m.message) || /SERVED/i.test(m.message)) return [];
    const car = Number(/CAR (\d+)/.exec(m.message)?.[1] ?? m.driver);
    return Number.isFinite(car) ? [{ t: m.t, driver: car }] : [];
  });

  let added = 0;
  for (const [driver, own] of byDriver) {
    own.sort((a, b) => a.stint - b.stint);
    const ownLaps = laps.filter((l) => l.driver === driver).sort((a, b) => a.lap - b.lap);
    const unserved = penalties.filter((p) => p.driver === driver).map((p) => p.t);
    for (const p of pits.filter((q) => q.driver === driver).sort((a, b) => a.entry - b.entry)) {
      // The car crosses the line in the pit lane: the lap after the one it came in on is the out lap.
      const inLap = ownLaps.filter((l) => l.start <= p.entry).at(-1)?.lap ?? p.lap;
      const outLap = inLap + 1;
      if (outLap <= 1 || own.some((s) => Math.abs(s.lapStart - outLap) <= 1)) continue;
      // A penalty given before this stop is served at it: no tyres.
      const penalty = unserved.findIndex((t) => t < p.entry);
      if (penalty >= 0) {
        unserved.splice(penalty, 1);
        continue;
      }
      let i = own.length - 1;
      while (i >= 0 && own[i].lapStart >= outLap) i--;
      if (i < 0) continue;
      const before = own[i];
      own.splice(i + 1, 0, { driver, stint: 0, lapStart: outLap, lapEnd: Math.max(before.lapEnd, outLap), compound: "UNKNOWN", ageAtStart: null });
      before.lapEnd = Math.min(before.lapEnd, outLap - 1);
      added++;
    }
    own.forEach((s, k) => (s.stint = k + 1));
  }
  return { stints: [...byDriver.values()].flat().sort((a, b) => a.driver - b.driver || a.stint - b.stint), added };
}
