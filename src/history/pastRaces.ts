// Past races at a circuit, for the circuit widgets (safety cars, strategies, overtakes, pace, pit stops): what a race
// was like, in laps, from seven OpenF1 reads (drivers, race control, stints, results, laps, pit, overtakes: ~100 KB
// gzipped, against ~12 MB for a whole session with its telemetry). Fetched by each browser like every other OpenF1 read (PRODUCT.md: nothing of OpenF1's is hosted), and
// kept in this browser (a past race doesn't change). Pure apart from fetchPastRace.

import type { Fetcher } from "../ingest/catalog";

/** Bumped when PastRace's shape changes: a summary kept under another version is fetched again. */
export const PAST_RACE_FORMAT = 2;

export type NeutralKind = "SC" | "VSC" | "RED";

/** Laps run under a safety car, a virtual one, or stopped by a red flag (inclusive). */
export interface NeutralLaps {
  kind: NeutralKind;
  from: number;
  to: number;
}

export interface PastDriver {
  number: number;
  code: string;
  name: string;
  team: string;
  /** Hex without '#', as OpenF1 gives it. */
  color: string;
}

export interface PastFinisher {
  driver: number;
  /** Classified position; null if not classified (DNF, DNS, DSQ). */
  position: number | null;
  laps: number;
  status: "finished" | "dnf" | "dns" | "dsq";
}

export interface PastStint {
  driver: number;
  compound: string;
  from: number;
  to: number;
}

/** An overtake on track (passes at the start, under a neutral phase, from pit stops or retirements are left out). */
export interface PastPass {
  lap: number;
  by: number;
  on: number;
}

/** A pit stop: the time in the pit lane and, from 2024, stationary (seconds). */
export interface PastPit {
  driver: number;
  lap: number;
  lane: number | null;
  stationary: number | null;
  /** Made under a safety car, VSC or red flag (cheaper). */
  neutral: boolean;
}

/** A car's lap times under green (no lap 1, in- or out-laps, neutral laps, or laps slower than 107% of its median), in s. */
export interface PastPace {
  driver: number;
  laps: number[];
}

export interface PastRace {
  format: typeof PAST_RACE_FORMAT;
  sessionKey: number;
  year: number;
  meetingName: string;
  /** "Race" or "Sprint". */
  sessionName: string;
  dateStart: string;
  /** The race distance as run: the winner's laps. */
  laps: number;
  neutral: NeutralLaps[];
  drivers: PastDriver[];
  /** Classified first, by position; then the rest, most laps first. */
  finish: PastFinisher[];
  stints: PastStint[];
  passes: PastPass[];
  pits: PastPit[];
  /** Classified cars' green laps. */
  pace: PastPace[];
  /** The race's fastest lap (lap 1 aside). */
  fastest: { driver: number; lap: number; time: number } | null;
}

// ---------------------------------------------------------------- OpenF1's rows (the fields read here)

export interface RawRaceControl {
  lap_number: number | null;
  category: string;
  flag: string | null;
  scope?: string | null;
  message: string;
}

export interface RawStint {
  driver_number: number;
  lap_start: number | null;
  lap_end: number | null;
  compound: string | null;
}

export interface RawResult {
  driver_number: number;
  position: number | null;
  number_of_laps: number | null;
  dnf?: boolean;
  dns?: boolean;
  dsq?: boolean;
}

export interface RawLap {
  driver_number: number;
  lap_number: number;
  date_start: string | null;
  lap_duration: number | null;
  is_pit_out_lap: boolean | null;
}

export interface RawPit {
  driver_number: number;
  lap_number: number;
  pit_duration?: number | null;
  lane_duration?: number | null;
  stop_duration?: number | null;
}

export interface RawOvertake {
  overtaking_driver_number: number;
  overtaken_driver_number: number;
  date: string;
}

export interface RawDriver {
  driver_number: number;
  name_acronym: string | null;
  full_name?: string | null;
  team_name: string | null;
  team_colour: string | null;
}

/**
 * Neutral periods by lap from race control. As the replay's track status (scripts/lib/normalize.ts) reads it: a
 * safety car runs from DEPLOYED to IN THIS LAP, a VSC from DEPLOYED to ENDING ("VSC ..." from 2026), a red flag
 * from its flag until the session starts again (behind the safety car, if one was called while stopped). A period
 * still open at the flag (or the end) runs to `laps`.
 */
export function neutralLaps(messages: readonly RawRaceControl[], laps: number): NeutralLaps[] {
  const out: NeutralLaps[] = [];
  let open: { kind: NeutralKind; from: number } | null = null;
  let scAtRestart = false;
  let lastLap = 1;
  const close = (to: number) => {
    if (open) out.push({ kind: open.kind, from: open.from, to: Math.max(open.from, to) });
    open = null;
  };
  for (const m of messages) {
    const msg = m.message.toUpperCase();
    const lap = Math.max(1, m.lap_number ?? lastLap);
    lastLap = lap;
    if (m.flag === "CHEQUERED") {
      close(lap);
      break;
    }
    const red = m.flag === "RED" || msg.startsWith("RED FLAG");
    if (open?.kind === "RED") {
      if (m.category === "SafetyCar" && msg.includes("DEPLOYED")) scAtRestart = true;
      if (m.category === "SessionStatus" && /STARTED|RESUMED/.test(msg)) {
        // Resumed on this lap: stopped until the one before.
        close(lap - 1);
        if (scAtRestart) open = { kind: "SC", from: lap };
        scAtRestart = false;
      }
      continue;
    }
    if (red) {
      close(lap);
      open = { kind: "RED", from: lap };
      continue;
    }
    if (m.category !== "SafetyCar") continue;
    const virtual = msg.includes("VIRTUAL") || /\bVSC\b/.test(msg);
    if (virtual) {
      if (msg.includes("ENDING") && open?.kind === "VSC") close(lap);
      else if (msg.includes("DEPLOYED") && !open) open = { kind: "VSC", from: lap };
    } else if (msg.includes("IN THIS LAP") && open?.kind === "SC") close(lap);
    else if (msg.includes("DEPLOYED") && open?.kind !== "SC") {
      // A safety car called during a VSC replaces it.
      if (open) close(lap);
      open = { kind: "SC", from: lap };
    }
  }
  close(laps);
  return out.map((p) => ({ ...p, to: Math.min(p.to, Math.max(laps, p.from)) }));
}

/** The lap a car was on at `date` (from its laps' starts); 1 before its first. */
function lapAt(starts: readonly { at: number; lap: number }[] | undefined, at: number): number {
  let lap = 1;
  for (const s of starts ?? []) {
    if (s.at > at) break;
    lap = s.lap;
  }
  return lap;
}

export const median = (xs: readonly number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : NaN;
};

/**
 * OpenF1's overtakes are every swap of positions; the passes made on track are what's left without: lap 1, swaps
 * under a neutral phase, swaps when either car pitted that lap or the one before, swaps with a car retiring, swaps
 * undone within 5 s (timing glitches: on 2023 Singapore's lap 29 every car "passed" Alonso and back in a second), and
 * a car "passed" by three or more within 15 s (it lost the time off track: a spin, a drive-through).
 */
export function onTrackPasses(
  raw: readonly RawOvertake[],
  ctx: { laps: readonly RawLap[]; pits: readonly RawPit[]; neutral: readonly NeutralLaps[]; retiredAfter: ReadonlyMap<number, number> },
): PastPass[] {
  const starts = new Map<number, { at: number; lap: number }[]>();
  for (const l of ctx.laps) if (l.date_start) (starts.get(l.driver_number) ?? starts.set(l.driver_number, []).get(l.driver_number)!).push({ at: Date.parse(l.date_start), lap: l.lap_number });
  for (const s of starts.values()) s.sort((a, b) => a.at - b.at);
  const pitLaps = new Map<number, Set<number>>();
  for (const p of ctx.pits) (pitLaps.get(p.driver_number) ?? pitLaps.set(p.driver_number, new Set()).get(p.driver_number)!).add(p.lap_number);
  const pitted = (d: number, lap: number) => pitLaps.get(d)?.has(lap) || pitLaps.get(d)?.has(lap - 1);
  const neutral = (lap: number) => ctx.neutral.some((p) => lap >= p.from && lap <= p.to);
  const all = raw.map((o) => ({ at: Date.parse(o.date), by: o.overtaking_driver_number, on: o.overtaken_driver_number, lap: lapAt(starts.get(o.overtaking_driver_number), Date.parse(o.date)) }));
  const undone = new Set<number>();
  all.forEach((a, i) => {
    for (let j = i + 1; j < all.length && all[j].at - a.at <= 5_000; j++) {
      if (all[j].by === a.on && all[j].on === a.by) undone.add(i).add(j);
    }
  });
  const swamped = new Set<number>();
  all.forEach((a, i) => {
    const near = all.filter((b) => b.on === a.on && Math.abs(b.at - a.at) <= 15_000);
    if (new Set(near.map((b) => b.by)).size >= 3) swamped.add(i);
  });
  return all
    .filter((o, i) => {
      if (o.lap <= 1 || neutral(o.lap) || undone.has(i) || swamped.has(i)) return false;
      if (pitted(o.by, o.lap) || pitted(o.on, o.lap)) return false;
      const retired = ctx.retiredAfter.get(o.on);
      return retired == null || o.lap < retired - 1;
    })
    .map(({ lap, by, on }) => ({ lap, by, on }));
}

/** The race as PastRace from OpenF1's rows. */
export function summarize(
  session: { sessionKey: number; year: number; meetingName: string; sessionName: string; dateStart: string },
  raw: {
    drivers: readonly RawDriver[];
    raceControl: readonly RawRaceControl[];
    stints: readonly RawStint[];
    results: readonly RawResult[];
    laps?: readonly RawLap[];
    pits?: readonly RawPit[];
    overtakes?: readonly RawOvertake[];
  },
): PastRace {
  const status = (r: RawResult): PastFinisher["status"] => (r.dsq ? "dsq" : r.dns ? "dns" : r.dnf ? "dnf" : r.position != null ? "finished" : "dnf");
  const finish = raw.results
    .map((r): PastFinisher => ({ driver: r.driver_number, position: status(r) === "finished" ? r.position : null, laps: r.number_of_laps ?? 0, status: status(r) }))
    .sort((a, b) => (a.position ?? Infinity) - (b.position ?? Infinity) || b.laps - a.laps);
  const laps = Math.max(0, ...finish.filter((f) => f.position === 1).map((f) => f.laps), 0) || Math.max(0, ...finish.map((f) => f.laps));
  const lapsOf = new Map(finish.map((f) => [f.driver, f.laps]));
  const stints = raw.stints
    .filter((s) => s.lap_start != null)
    .map((s) => ({
      driver: s.driver_number,
      compound: (s.compound ?? "UNKNOWN").toUpperCase(),
      from: s.lap_start!,
      to: s.lap_end ?? lapsOf.get(s.driver_number) ?? laps,
    }))
    .filter((s) => s.to >= s.from)
    .sort((a, b) => a.driver - b.driver || a.from - b.from);
  const neutral = neutralLaps(raw.raceControl, laps);
  const isNeutral = (lap: number) => neutral.some((p) => lap >= p.from && lap <= p.to);
  const rawLaps = raw.laps ?? [];
  const rawPits = raw.pits ?? [];
  const retiredAfter = new Map(finish.filter((f) => f.status === "dnf").map((f) => [f.driver, f.laps]));
  const pits: PastPit[] = rawPits
    .map((p) => ({ driver: p.driver_number, lap: p.lap_number, lane: p.lane_duration ?? p.pit_duration ?? null, stationary: p.stop_duration ?? null, neutral: isNeutral(p.lap_number) }))
    // A minute or more in the lane is a car repaired or stopped under a red flag, not a pit stop.
    .filter((p) => p.lane == null || p.lane < 60)
    .sort((a, b) => a.lap - b.lap || a.driver - b.driver);
  const inLaps = new Set(rawPits.map((p) => `${p.driver_number}:${p.lap_number}`));
  const classified = new Set(finish.filter((f) => f.position != null).map((f) => f.driver));
  const pace: PastPace[] = [];
  for (const d of classified) {
    const own = rawLaps.filter(
      (l) => l.driver_number === d && l.lap_number > 1 && l.lap_duration != null && !l.is_pit_out_lap && !inLaps.has(`${d}:${l.lap_number}`) && !isNeutral(l.lap_number),
    );
    const mid = median(own.map((l) => l.lap_duration!));
    const kept = own.filter((l) => l.lap_duration! <= mid * 1.07).map((l) => l.lap_duration!);
    if (kept.length) pace.push({ driver: d, laps: kept });
  }
  let fastest: PastRace["fastest"] = null;
  for (const l of rawLaps) if (l.lap_number > 1 && l.lap_duration != null && (!fastest || l.lap_duration < fastest.time)) fastest = { driver: l.driver_number, lap: l.lap_number, time: l.lap_duration };
  return {
    format: PAST_RACE_FORMAT,
    ...session,
    laps,
    neutral,
    passes: onTrackPasses(raw.overtakes ?? [], { laps: rawLaps, pits: rawPits, neutral, retiredAfter }),
    pits,
    pace,
    fastest,
    drivers: raw.drivers.map((d) => ({
      number: d.driver_number,
      code: d.name_acronym ?? String(d.driver_number),
      name: d.full_name ?? d.name_acronym ?? String(d.driver_number),
      team: d.team_name ?? "",
      color: d.team_colour ?? "71717a",
    })),
    finish,
    stints,
  };
}

/** A past race from OpenF1: seven reads, one after the other (the client spaces them out). */
export async function fetchPastRace(
  session: { sessionKey: number; year: number; meetingName: string; sessionName: string; dateStart: string },
  get: Fetcher,
): Promise<PastRace> {
  const q = { session_key: session.sessionKey };
  const drivers = await get<RawDriver>("drivers", q);
  const raceControl = await get<RawRaceControl>("race_control", q);
  const stints = await get<RawStint>("stints", q);
  const results = await get<RawResult>("session_result", q);
  if (!results.length) throw new Error(`OpenF1 has no results for ${session.year} ${session.meetingName} yet.`);
  const laps = await get<RawLap>("laps", q);
  const pits = await get<RawPit>("pit", q);
  const overtakes = await get<RawOvertake>("overtakes", q);
  return summarize(session, { drivers, raceControl, stints, results, laps, pits, overtakes });
}

/** The cars' stints in the order they finished: what a strategy widget lists. */
export function strategies(race: PastRace): { finisher: PastFinisher; driver: PastDriver | undefined; stints: PastStint[] }[] {
  const drivers = new Map(race.drivers.map((d) => [d.number, d]));
  return race.finish
    .filter((f) => f.status !== "dns")
    .map((finisher) => ({ finisher, driver: drivers.get(finisher.driver), stints: race.stints.filter((s) => s.driver === finisher.driver) }));
}

/** "1 stop", "2 stops": how many times a car changed tyres. */
export const stopsOf = (stints: readonly PastStint[]) => Math.max(0, stints.length - 1);
