// Which lap of each compared driver is shown. Pure, over the laps the hooks say are completed at t (no spoilers).
//
// Linked (the default): one lap number for everyone, the way two cars fighting share a lap. Nothing picked, it
// follows the replay: the latest lap every compared car has completed, so the widget shows the lap just finished
// as the race plays. Picking a lap pins it. Unlinked: each driver has their own lap (their pick, else their latest),
// to set one driver's lap 30 against another's lap 32.

export interface Picks {
  linked: boolean;
  /** Linked: the pinned lap, or null to follow the replay. */
  shared: number | null;
  /** Unlinked: each driver's pinned lap. */
  own: Readonly<Record<number, number>>;
}

export const FOLLOWING: Picks = { linked: true, shared: null, own: {} };

export interface LapChoice {
  driver: number;
  /** The lap shown, or null when the driver hasn't completed the lap asked for (or any lap). */
  lap: number | null;
}

/** The latest lap every car has completed (the one just finished by the car furthest back); null if any has none. */
export function latestCommonLap(completed: readonly (readonly number[])[]): number | null {
  if (!completed.length) return null;
  let best = Infinity;
  for (const laps of completed) {
    if (!laps.length) return null;
    best = Math.min(best, laps[laps.length - 1]);
  }
  return Number.isFinite(best) ? best : null;
}

/** The lap each driver shows for `picks`; `completed` is each driver's completed lap numbers, in order. */
export function resolveLaps(drivers: readonly number[], completed: ReadonlyMap<number, readonly number[]>, picks: Picks): LapChoice[] {
  const of = (n: number) => completed.get(n) ?? [];
  if (picks.linked) {
    const lap = picks.shared ?? latestCommonLap(drivers.map(of));
    return drivers.map((driver) => ({ driver, lap: lap != null && of(driver).includes(lap) ? lap : null }));
  }
  return drivers.map((driver) => {
    const own = of(driver);
    const pick = picks.own[driver];
    return { driver, lap: pick != null && own.includes(pick) ? pick : (own[own.length - 1] ?? null) };
  });
}

/** Whether the picks follow the replay (nothing pinned). */
export const isFollowing = (p: Picks) => (p.linked ? p.shared == null : Object.keys(p.own).length === 0);

/** The picks after choosing `lap` for `driver`: the shared lap when linked, that driver's own otherwise. */
export function pick(p: Picks, driver: number, lap: number): Picks {
  return p.linked ? { ...p, shared: lap } : { ...p, own: { ...p.own, [driver]: lap } };
}

/**
 * The picks after flipping the link. Linking keeps the reference's lap for everyone; unlinking pins each driver to
 * the lap they were showing, so nothing moves on the screen.
 */
export function toggleLink(p: Picks, choices: readonly LapChoice[]): Picks {
  if (p.linked) {
    const own: Record<number, number> = {};
    for (const c of choices) if (c.lap != null) own[c.driver] = c.lap;
    return { linked: false, shared: null, own };
  }
  return { linked: true, shared: choices[0]?.lap ?? null, own: {} };
}

/** The completed lap after (dir 1) or before (dir -1) `lap`, or null when there's none that way. */
export function stepLap(completed: readonly number[], lap: number | null, dir: 1 | -1): number | null {
  if (lap == null) return completed[dir > 0 ? 0 : completed.length - 1] ?? null;
  if (dir > 0) return completed.find((l) => l > lap) ?? null;
  for (let i = completed.length - 1; i >= 0; i--) if (completed[i] < lap) return completed[i];
  return null;
}
