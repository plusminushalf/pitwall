// Processed session format written by scripts/ingest.ts and read by the app.
// All times are milliseconds since the session window start (`SessionMeta.t0`).

export type Ms = number;

export interface SessionIndexEntry {
  sessionKey: number;
  meetingName: string;
  sessionName: string;
  year: number;
  circuit: string;
  country: string;
  dateStart: string;
  sessionType?: SessionType; // absent in entries written before qualifying support: "Race"
}

/**
 * OpenF1 session type: races and sprints are "Race", (sprint) qualifying and shootouts "Qualifying", free practice
 * "Practice".
 */
export type SessionType = "Race" | "Qualifying" | "Practice";

export interface DriverInfo {
  number: number;
  acronym: string;
  fullName: string;
  broadcastName: string;
  team: string;
  teamColour: string; // hex without '#'
  headshotUrl: string | null;
}

export interface Lap {
  driver: number;
  lap: number;
  start: Ms;
  end: Ms | null; // start + duration, or next lap's start when duration is missing
  duration: number | null; // seconds
  sectors: [number | null, number | null, number | null]; // seconds
  // Mini-sector status codes per sector (2048 yellow, 2049 green, 2051 purple, 2064 pit).
  segments: [(number | null)[], (number | null)[], (number | null)[]];
  speedTrap: { i1: number | null; i2: number | null; st: number | null };
  pitOut: boolean;
  /** Practice and qualifying: race control deleted the lap time (track limits...), at `t`; it counts until then. */
  deleted?: { t: Ms; reason: string };
}

export interface Stint {
  driver: number;
  stint: number;
  lapStart: number;
  lapEnd: number;
  compound: string; // SOFT | MEDIUM | HARD | INTERMEDIATE | WET | UNKNOWN
  ageAtStart: number | null; // null: not known (a stop OpenF1's stints missed, added from the pit records)
}

export interface PitStop {
  driver: number;
  lap: number;
  entry: Ms; // exit - laneDuration
  exit: Ms;
  laneDuration: number | null; // seconds
  stopDuration: number | null; // seconds stationary, when reported
}

export interface PositionEvent {
  t: Ms;
  driver: number;
  position: number;
}

export interface IntervalEvent {
  t: Ms;
  driver: number;
  gapToLeader: number | string | null; // string for e.g. "+1 LAP"
  interval: number | string | null;
}

export type TrackStatus =
  | "GREEN"
  | "SC"
  | "SC_ENDING"
  | "VSC"
  | "VSC_ENDING"
  | "RED"
  | "CHEQUERED";

export interface TrackStatusEvent {
  t: Ms;
  status: TrackStatus;
}

export interface RaceControlMsg {
  t: Ms;
  lap: number | null;
  category: string;
  flag: string | null;
  scope: string | null;
  sector: number | null;
  driver: number | null;
  message: string;
}

export interface WeatherSample {
  t: Ms;
  airTemp: number;
  trackTemp: number;
  humidity: number;
  pressure: number;
  rainfall: number;
  windSpeed: number;
  windDirection: number;
}

export interface RadioClip {
  t: Ms;
  driver: number;
  url: string;
}

export interface Overtake {
  t: Ms;
  overtaker: number;
  overtaken: number;
  position: number;
}

export interface Result {
  driver: number;
  position: number | null;
  laps: number;
  points: number;
  dnf: boolean;
  dns: boolean;
  dsq: boolean;
  duration: number | null; // seconds
  gapToLeader: number | string | null;
  finish: Ms | null; // when the driver took the flag (end of their final lap)
  retired: Ms | null; // DNF/DNS: when the car last moved (retired cars keep reporting positions)
}

export interface Polyline {
  x: number[];
  y: number[];
  z: number[];
}

export interface TrackGeometry {
  outline: Polyline; // location trace of one clean green-flag lap
  pitLane: Polyline | null;
  sectorMarks: { x: number; y: number }[]; // start of sector 2 and 3; finish line is outline[0]
  bounds: { minX: number; maxX: number; minY: number; maxY: number };
  referenceLap: { driver: number; lap: number; duration: number };
  // From the MultiViewer circuit API when available (rotation 0 / empty lists otherwise). Loading a session fills
  // in the circuits the API doesn't have, and corner names (src/data/circuits.ts).
  rotation: number; // degrees, counter-clockwise, to show the track in its usual orientation
  // `angle`: degrees, from the corner to where its number goes (usually out of the bend). `letter`: "A" in turn 5A.
  corners: { number: number; letter?: string; name?: string; x: number; y: number; angle: number }[];
  // Marshal sectors as outline index ranges; `to` < `from` wraps past the finish line.
  // Race control sector flags ("YELLOW IN TRACK SECTOR 15") refer to these numbers.
  marshalSectors: { number: number; from: number; to: number }[];
  pitLoss: { normal: number; sc: number; vsc: number } | null; // seconds lost by a pit stop
}

export interface SessionMeta {
  version: 1;
  sessionKey: number;
  meetingKey: number;
  meetingName: string;
  sessionName: string;
  year: number;
  circuit: string;
  country: string;
  gmtOffset: string; // local time at the track, e.g. "04:00:00"
  t0: string; // ISO UTC timestamp of t = 0
  duration: Ms;
  lightsOut: Ms;
  chequered: Ms | null;
  totalLaps: number;
  drivers: DriverInfo[];
  grid: { driver: number; position: number }[];
  laps: Lap[];
  stints: Stint[];
  pits: PitStop[];
  positions: PositionEvent[];
  intervals: IntervalEvent[];
  trackStatus: TrackStatusEvent[];
  raceControl: RaceControlMsg[]; // may extend past `duration` (post-race stewards' decisions)
  weather: WeatherSample[];
  radio: RadioClip[];
  overtakes: Overtake[];
  results: Result[];
  track: TrackGeometry;
  // Live sessions only (absent in replays):
  totalLapsEstimated?: boolean; // race distance not known yet: estimated from the lap length
  lightsOutEstimated?: boolean; // lap 1 hasn't started: `lightsOut` is a guess (>= the live edge)
  // Qualifying sessions only (lightsOut = Q1 green light, chequered = the final segment's flag):
  quali?: QualiData;
  // Qualifying timed as on the timing screen (lightsOut = Q1's green light): live, and a finished session stored since
  // Qualifying format 3 (with `quali`):
  qualiLive?: LiveQualiData;
  // Free practice only (lightsOut = the green light, chequered = the flag):
  practice?: PracticeData;
}

/**
 * Free practice, written by normalize() (scripts/lib/practice.ts). There's no race order: `positions` and
 * `intervals` are the timing screen's, by best lap so far (deleted laps count until race control deletes them), the
 * gaps in seconds to the fastest and to the car ahead. In-laps and out-laps get no lap time (OpenF1's include the time
 * in the garage), and an in-lap ends at the pit entry: the car is in the garage until the out-lap starts.
 */
export interface PracticeData {
  /** The scheduled end (ms since t0): the session clock counts down to it (it keeps running under a red flag). */
  scheduledEnd: Ms;
  // A finished session, as ingest stores it (the live relay and a download being watched have none of these):
  // distance-aligned traces of the laps at pace (within 107% of the driver's best) in laps/<driver>.json, to
  // compare laps as in qualifying.
  /** Metres, timing line to timing line (median speed-integrated lap). */
  lapLength?: number;
  /** Metres from the timing line to the sector 2 and 3 boundaries. */
  sectorDistances?: [number, number];
  /** The laps with a trace, by driver (in driver number order). */
  traced?: { driver: number; laps: number[] }[];
}

// Per-driver high-frequency streams (~4 Hz), columnar.
// `t` is delta-encoded: t[0] is ms since window start, t[i] is ms since t[i - 1].
export interface DriverTelemetry {
  driver: number;
  loc: { t: number[]; x: number[]; y: number[]; z: number[] };
  car: {
    t: number[];
    speed: number[];
    rpm: number[];
    gear: number[];
    throttle: number[];
    brake: number[];
    drs?: number[]; // absent from 2026 (no DRS)
  };
}

// ---------------------------------------------------------------- qualifying
// Written by scripts/lib/quali.ts for (sprint) qualifying sessions, on top of the race format above.

export interface QualiSegment {
  number: number; // 1, 2, 3
  name: string; // "Q1".."Q3", or "SQ1".."SQ3" for sprint qualifying / shootouts
  start: Ms; // green light (pit exit open)
  end: Ms; // chequered flag: laps started before it still count
  advance: number | null; // cars through to the next segment (null for the last one)
}

export interface QualiLap {
  driver: number;
  lap: number;
  segment: number | null; // segment running when the lap started (after its flag: that segment, `afterFlag`)
  afterFlag: boolean; // started after the segment's chequered flag, so it can't count
  kind: "out" | "in" | "push" | "cool"; // push: within 107% of the session's fastest lap
  deleted: string | null; // race control's reason when the lap time was deleted, e.g. "TRACK LIMITS AT TURN 15"
  best: boolean; // the driver's counting (fastest valid) lap of its segment
  trace: boolean; // has a distance-aligned trace in laps/<driver>.json
}

export interface QualiResult {
  driver: number;
  position: number | null;
  times: (number | null)[]; // official best lap per segment, seconds
  laps: (number | null)[]; // the laps that set `times`
  eliminated: number | null; // segment the driver was knocked out in; null: reached the final segment
}

export interface QualiData {
  segments: QualiSegment[];
  laps: QualiLap[];
  results: QualiResult[]; // classification order
  lapLength: number; // metres, timing line to timing line (median speed-integrated flying lap)
  sectorDistances: [number, number]; // metres from the timing line to the sector 2 and 3 boundaries
}

/**
 * Qualifying as the timing screen has it: live, written by normalize() (scripts/lib/qualiLive.ts), the segments
 * started so far; a finished session, by quali.ts from its segments. The timing
 * screen's order and gaps are in `positions` and `intervals`: by best lap in the segment running, the cars knocked
 * out below in the order they went out in, with their gaps in that segment.
 */
export interface LiveQualiData {
  segments: LiveQualiSegment[];
}

export interface LiveQualiSegment {
  number: number; // 1, 2, 3
  name: string; // "Q1".."Q3", or "SQ1".."SQ3"
  start: Ms; // green light (pit exit open)
  end: Ms | null; // chequered flag (laps started before it still count); null while it runs
  advance: number | null; // cars through to the next segment (null for the last one)
  /** Its scheduled running time: the clock stops under a red flag. */
  length: Ms;
  /** Red flags: the clock stopped from `from` until the restart (`to`; null while it's out). */
  stopped: { from: Ms; to: Ms | null }[];
}

// Per-driver lap traces (laps/<number>.json, qualifying and finished free practice; scripts/lib/lapTraces.ts):
// full timed laps from the timing line to the timing line, with distance aligned across laps and drivers so
// laps can be overlaid.
// Columnar: one sample per car-data sample, plus exact samples on the line at both ends.
export interface LapTrace {
  lap: number;
  t: number[]; // ms since the lap start, delta-encoded (t[0] = 0, the last sample is the lap time)
  d: number[]; // decimetres from the timing line, delta-encoded (d[0] = 0, the last sample is lapLength)
  speed: number[]; // km/h
  throttle: number[]; // %
  brake: number[]; // 0-100 (OpenF1 reports 0 or 100)
  gear: number[];
  x: number[]; // track position (location units, decimetres) at each sample
  y: number[];
}

export interface DriverLapTraces {
  driver: number;
  laps: LapTrace[];
}
