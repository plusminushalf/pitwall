// Run plans in free practice: every lap each driver has done so far, on the session clock, sorted into push laps
// (quali simulations), laps at pace (long runs, race simulations) and the rest (out-, in- and cool-down laps, laps
// under a red flag, deleted ones). Pure: the widget feeds it the laps, stints and neutral periods it has so far
// (nothing past t).
//
// A lap is valid when it's timed, isn't an out-lap or an in-lap, wasn't touched by a safety car, VSC or red flag, and
// hasn't been deleted by now. A push lap is a valid lap within PUSH of the driver's best valid lap so far; a valid lap
// within PACE of it is at pace, and slower ones are slow (cool-down laps, traffic).

import type { NeutralPeriod } from "widget-kit";

/** The part of a completed lap this needs; `deleted`: race control has deleted it by t (deletedBy). */
export interface PlanLapInput {
  lap: number;
  start: number;
  end: number | null;
  duration: number | null;
  pitOut: boolean;
  deleted: boolean;
}

/** The part of a stint this needs. */
export interface PlanStint {
  lapStart: number;
  compound: string;
  ageAtStart: number | null;
}

export type LapKind = "push" | "pace" | "slow";

export interface PlanLap {
  lap: number;
  /** ms since t0. */
  start: number;
  end: number;
  /** Seconds; null: untimed. */
  duration: number | null;
  compound: string;
  /** Laps on the set before this one (a new set's first lap is 0); null: no stint holds the lap. */
  age: number | null;
  kind: LapKind;
  /** Why a lap isn't push or pace, for its title: "out-lap", "red flag"... (null for push and pace laps). */
  why: string | null;
}

export interface PlanRow {
  driver: number;
  laps: PlanLap[];
  /** Seconds: the best valid lap so far (null: none yet). */
  best: number | null;
}

/** Within this share of the driver's best valid lap: a push lap. */
export const PUSH = 1.015;
/** Within this share of it (and not a push lap): at pace, a long run's lap. Slower: a cool-down lap or traffic. */
export const PACE = 1.07;

/** Race control has deleted the lap by t (track limits); until then it counts. */
export const deletedBy = (lap: { deleted?: { t: number } }, t: number) => lap.deleted != null && t >= lap.deleted.t;

const NEUTRAL_NAME: Record<NeutralPeriod["status"], string> = { RED: "red flag", SC: "safety car", VSC: "VSC" };

/** One driver's laps so far, each with its tyre and kind, in the order driven. */
export function planRow(driver: number, laps: readonly PlanLapInput[], stints: readonly PlanStint[], neutral: readonly NeutralPeriod[]): PlanRow {
  const sorted = [...laps].sort((a, b) => a.lap - b.lap);
  const starts = [...stints].sort((a, b) => a.lapStart - b.lapStart);
  const stintOf = (lap: number) => {
    let i = -1;
    while (i + 1 < starts.length && starts[i + 1].lapStart <= lap) i++;
    return i;
  };

  const shaped = sorted.flatMap((l, k) => {
    const end = l.end ?? (l.duration != null && l.duration > 0 ? l.start + l.duration * 1000 : null);
    if (end == null) return [];
    const i = stintOf(l.lap);
    const s = starts[i];
    const next = starts[i + 1];
    const timed = l.duration != null && l.duration > 0;
    // The first lap on a later set is its out-lap even when OpenF1 hasn't flagged it.
    const outLap = l.pitOut || (i > 0 && l.lap === s.lapStart);
    const inLap = sorted[k + 1]?.pitOut === true || (next != null && l.lap === next.lapStart - 1);
    const under = neutral.find((p) => p.start < end && l.start < (p.end ?? Infinity));
    const why = outLap ? "out-lap" : inLap ? "in-lap" : !timed ? "untimed" : under ? NEUTRAL_NAME[under.status] : l.deleted ? "deleted" : null;
    return [{ l, end, s, why }];
  });

  const valid = shaped.filter((x) => x.why == null).map((x) => x.l.duration!);
  const best = valid.length ? Math.min(...valid) : null;

  return {
    driver,
    best,
    laps: shaped.map(({ l, end, s, why }): PlanLap => {
      let kind: LapKind = "slow";
      let reason = why;
      if (why == null && best != null) {
        if (l.duration! <= best * PUSH) kind = "push";
        else if (l.duration! <= best * PACE) kind = "pace";
        else reason = "slow";
      }
      return {
        lap: l.lap,
        start: l.start,
        end,
        duration: l.duration,
        compound: s?.compound ?? "UNKNOWN",
        age: s ? (s.ageAtStart ?? 0) + l.lap - s.lapStart : null,
        kind,
        why: reason,
      };
    }),
  };
}

/**
 * Rows grouped by team, teammates together: teams by their best lap so far, and each team's drivers by theirs
 * (drivers and teams with no valid lap yet last, in the order given).
 */
export function byTeam<R extends { driver: number; best: number | null }>(rows: readonly R[], teamOf: (driver: number) => string): R[][] {
  const teams = new Map<string, R[]>();
  for (const r of rows) {
    const team = teamOf(r.driver);
    if (!teams.has(team)) teams.set(team, []);
    teams.get(team)!.push(r);
  }
  const key = (b: number | null) => b ?? Infinity;
  const groups = [...teams.values()].map((g) => [...g].sort((a, b) => key(a.best) - key(b.best)));
  return groups.sort((a, b) => key(a[0].best) - key(b[0].best));
}

/**
 * The x axis: from the green light to the scheduled end, or the end of the last push or paced lap if later (a lap
 * started before the flag). The cool-down laps after the flag are cut off.
 */
export function axisOf(from: number, scheduledEnd: number | null, rows: readonly PlanRow[]): { from: number; to: number; ticks: number[] } {
  const lastEnd = Math.max(...rows.flatMap((r) => r.laps.filter((l) => l.kind !== "slow").map((l) => l.end)), -Infinity);
  const to = Math.max(scheduledEnd ?? from + 60 * 60_000, lastEnd);
  const minutes = (to - from) / 60_000;
  const step = minutes <= 90 ? 15 : 30;
  const ticks: number[] = [];
  for (let m = 0; m <= minutes + 1e-9; m += step) ticks.push(m);
  return { from, to, ticks };
}
