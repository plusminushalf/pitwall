// Past races at a circuit, for the circuit widgets (safety cars, strategies): what a race was like, in laps, from four
// small OpenF1 reads (drivers, race control, stints, results: ~40 KB, against ~12 MB for a whole session with its
// telemetry). Fetched by each browser like every other OpenF1 read (PRODUCT.md: nothing of OpenF1's is hosted), and
// kept in this browser (a past race doesn't change). Pure apart from fetchPastRace.

import type { Fetcher } from "../ingest/catalog";

/** Bumped when PastRace's shape changes: a summary kept under another version is fetched again. */
export const PAST_RACE_FORMAT = 1;

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

/** The race as PastRace from OpenF1's rows. */
export function summarize(
  session: { sessionKey: number; year: number; meetingName: string; sessionName: string; dateStart: string },
  raw: { drivers: readonly RawDriver[]; raceControl: readonly RawRaceControl[]; stints: readonly RawStint[]; results: readonly RawResult[] },
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
  return {
    format: PAST_RACE_FORMAT,
    ...session,
    laps,
    neutral: neutralLaps(raw.raceControl, laps),
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

/** A past race from OpenF1: four reads, one after the other (the client spaces them out). */
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
  return summarize(session, { drivers, raceControl, stints, results });
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
