// Which laps show a driver's pace, and the trend of each stint. Pure: the block feeds it the laps,
// stints and race control messages it has so far (nothing past t).

/** The part of a completed lap this needs. */
export interface PaceLap {
  lap: number;
  start: number;
  end: number | null;
  duration: number | null;
  pitOut: boolean;
}

/** The part of a stint this needs; `open` is the one the car is on. */
export interface PaceStint {
  stint: number;
  lapStart: number;
  lapEnd: number;
  compound: string;
  ageAtStart: number;
  open: boolean;
}

/** A safety car or VSC period, in ms; `to` is Infinity while it's still out. */
export interface Neutral {
  from: number;
  to: number;
  kind: "SC" | "VSC";
}

/** Why a lap doesn't count towards pace. */
export type Excluded = "lap-1" | "pit-in" | "pit-out" | "SC" | "VSC" | "slow";

export interface PacePoint {
  lap: number;
  /** When the lap started (ms), to seek to. */
  start: number;
  /** Seconds. */
  time: number;
  stint: number;
  compound: string;
  /** Laps on the set before this one, as the tyre badge counts them (a new set's first lap is 0). */
  age: number;
  excluded: Excluded | null;
}

/** A straight line through a stint's clean laps: time = intercept + slope * age. */
export interface StintFit {
  stint: number;
  compound: string;
  /** Clean laps in the fit. */
  laps: number;
  fromLap: number;
  toLap: number;
  fromAge: number;
  toAge: number;
  /** Seconds per lap: positive is getting slower. Fuel burning off is in it too. */
  slope: number;
  intercept: number;
  /** The stint the car is on now. */
  open: boolean;
}

/** Slower than this share of the driver's median clean lap: traffic, a mistake, a red flag. */
export const SLOW = 1.07;
/** Fewer clean laps than this and a stint gets no trend: a line through a few laps on a fresh set is noise. */
export const MIN_FIT_LAPS = 5;

/**
 * Safety car and VSC periods from race control's safety car messages (oldest first). A period starts at
 * DEPLOYED and ends at "IN THIS LAP" (SC) or ENDING (VSC), or when the other kind is deployed.
 */
export function neutralPeriods(messages: readonly { t: number; text: string }[]): Neutral[] {
  const out: Neutral[] = [];
  let open: { from: number; kind: Neutral["kind"] } | null = null;
  for (const { t, text } of messages) {
    const msg = text.toUpperCase();
    // "VIRTUAL SAFETY CAR DEPLOYED" until 2025, "VSC DEPLOYED" from 2026.
    const kind = msg.includes("VIRTUAL") || /\bVSC\b/.test(msg) ? "VSC" : "SC";
    if (msg.includes("DEPLOYED")) {
      if (open) out.push({ from: open.from, to: t, kind: open.kind });
      open = { from: t, kind };
    } else if (open && (msg.includes("ENDING") || msg.includes("IN THIS LAP"))) {
      out.push({ from: open.from, to: t, kind: open.kind });
      open = null;
    }
  }
  if (open) out.push({ from: open.from, to: Infinity, kind: open.kind });
  return out;
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * One point per timed lap, each marked with why it doesn't show pace, if it doesn't: lap 1, the laps
 * into and out of the pits, laps touched by a safety car or VSC, and laps slower than 107% of the
 * driver's median of the rest.
 */
export function pacePoints(laps: readonly PaceLap[], stints: readonly PaceStint[], neutral: readonly Neutral[]): PacePoint[] {
  const out: PacePoint[] = [];
  for (const l of laps) {
    if (l.duration == null || !(l.duration > 0)) continue;
    const i = stints.findIndex((s, k) => s.lapStart <= l.lap && (s.open || l.lap < (stints[k + 1]?.lapStart ?? Infinity)));
    const s = stints[i];
    if (!s) continue;
    const next = stints[i + 1];
    const end = l.end ?? l.start + l.duration * 1000;
    const flag = neutral.find((p) => p.from < end && l.start < p.to);
    const excluded: Excluded | null =
      l.lap === 1
        ? "lap-1"
        : l.pitOut || (i > 0 && l.lap === s.lapStart)
          ? "pit-out"
          : next && l.lap === next.lapStart - 1
            ? "pit-in"
            : flag
              ? flag.kind
              : null;
    out.push({ lap: l.lap, start: l.start, time: l.duration, stint: s.stint, compound: s.compound, age: s.ageAtStart + l.lap - s.lapStart, excluded });
  }
  const clean = out.filter((p) => p.excluded == null);
  if (clean.length > 0) {
    const limit = median(clean.map((p) => p.time)) * SLOW;
    for (const p of clean) if (p.time > limit) p.excluded = "slow";
  }
  return out;
}

/** A least-squares line through each stint's clean laps (time against tyre age), for stints with enough of them. */
export function stintFits(points: readonly PacePoint[], stints: readonly PaceStint[], minLaps = MIN_FIT_LAPS): StintFit[] {
  const out: StintFit[] = [];
  for (const s of stints) {
    const ps = points.filter((p) => p.stint === s.stint && p.excluded == null);
    if (ps.length < Math.max(minLaps, 2)) continue;
    const n = ps.length;
    const mx = ps.reduce((a, p) => a + p.age, 0) / n;
    const my = ps.reduce((a, p) => a + p.time, 0) / n;
    let sxy = 0;
    let sxx = 0;
    for (const p of ps) {
      sxy += (p.age - mx) * (p.time - my);
      sxx += (p.age - mx) ** 2;
    }
    if (sxx === 0) continue;
    const slope = sxy / sxx;
    out.push({
      stint: s.stint,
      compound: s.compound,
      laps: n,
      fromLap: ps[0].lap,
      toLap: ps[n - 1].lap,
      fromAge: ps[0].age,
      toAge: ps[n - 1].age,
      slope,
      intercept: my - slope * mx,
      open: s.open,
    });
  }
  return out;
}

/** 0.0834 -> "+0.08 s/lap". */
export const trendText = (slope: number) => `${slope >= 0 ? "+" : "−"}${Math.abs(slope).toFixed(2)} s/lap`;

export const EXCLUDED_TEXT: Record<Excluded, string> = {
  "lap-1": "Lap 1",
  "pit-in": "In lap",
  "pit-out": "Out lap",
  SC: "Safety car",
  VSC: "VSC",
  slow: "Over 107% of median",
};
