// A circuit's past: every Grand Prix held there, from F1DB (https://github.com/f1db/f1db, CC BY 4.0). Built at
// deploy time by scripts/circuit-history.ts into static files the app fetches (src/history/circuits.ts). Facts only:
// "last 5 poles", lap records and the like are worked out from them in src/history/insights.ts.

/** Bumped when the files' shape changes, so a browser never reads one it doesn't understand. */
export const CIRCUIT_HISTORY_FORMAT = 1;

/** Where the data comes from, for the credit line CC BY needs. */
export interface HistorySource {
  name: "F1DB";
  /** F1DB release the files were built from, e.g. "v2026.16.0" (updated after every race). */
  release: string;
  url: string;
  license: "CC BY 4.0";
  licenseUrl: string;
  /** When the files were built (ISO 8601). */
  generatedAt: string;
}

export type CircuitType = "RACE" | "ROAD" | "STREET";
export type CircuitDirection = "CLOCKWISE" | "ANTI_CLOCKWISE";

export interface HistoryCircuit {
  /** F1DB's circuit id ("monza", "spa-francorchamps"): the file's name. */
  id: string;
  name: string; // "Monza"
  fullName: string; // "Autodromo Nazionale Monza"
  previousNames: string[];
  type: CircuitType;
  /** Of the current (or last used) layout. */
  direction: CircuitDirection;
  place: string; // "Monza"
  country: string; // "Italy"
  countryId: string; // F1DB's: "italy"
  lat: number;
  lng: number;
  /** Of the current (or last used) layout, in km. */
  lengthKm: number;
  turns: number;
  racesHeld: number;
}

/**
 * One version of the track. Lap times are only comparable within a layout: a lap record is the fastest lap on the
 * layout raced now, not the fastest ever at the circuit.
 */
export interface HistoryLayout {
  id: string; // "monza-7"
  /** The layout raced now (or last). */
  current: boolean;
  lengthKm: number;
  turns: number;
  /** First and last year a Grand Prix was held on it. */
  firstYear: number;
  lastYear: number;
}

/** A driver in a race, with the team and car number they raced with that day. */
export interface HistoryEntry {
  driverId: string;
  constructorId: string;
  number: string | null;
}

export interface Timed extends HistoryEntry {
  /** As F1DB prints it ("1:20.901"), null where it isn't known (early years). */
  time: string | null;
  ms: number | null;
}

export interface Finisher extends HistoryEntry {
  position: number;
  /** Starting grid position, null for a pit-lane start or where it isn't known. */
  grid: number | null;
  /** The winner's race time; for the others, their gap ("+1.234", "+1 lap"). */
  time: string | null;
  laps: number | null;
}

export interface FastestLap extends Timed {
  /** The lap it was set on. */
  lap: number | null;
}

/** One Grand Prix at the circuit (sprints aren't included). */
export interface HistoryRace {
  /** F1DB's race id. */
  raceId: number;
  year: number;
  round: number;
  date: string; // "2025-09-07"
  grandPrixId: string; // F1DB's: "italy", "bahrain"
  grandPrix: string; // "Italian Grand Prix"
  layoutId: string;
  laps: number;
  distanceKm: number;
  /** The weekend had a sprint. */
  sprint: boolean;
  /** Fastest in qualifying, with the time that put them there. Null if no record of it. */
  pole: Timed | null;
  /** First three, in order: fewer where fewer were classified. */
  podium: Finisher[];
  fastestLap: FastestLap | null;
  /** Fan vote, since 2016. */
  driverOfTheDay: HistoryEntry | null;
  /** The race settled the drivers' or constructors' title. */
  decider: { drivers: boolean; constructors: boolean };
}

export interface HistoryDriver {
  name: string; // "Lando Norris"
  lastName: string;
  abbreviation: string; // "NOR"
  nationalityId: string; // F1DB's country id
}

export interface HistoryConstructor {
  name: string; // "McLaren"
}

/** public/history/circuits/<id>.json */
export interface CircuitHistory {
  format: typeof CIRCUIT_HISTORY_FORMAT;
  source: HistorySource;
  circuit: HistoryCircuit;
  /** The layouts Grands Prix were held on, oldest first. */
  layouts: HistoryLayout[];
  /** Oldest first. */
  races: HistoryRace[];
  /** Every driver and team the races mention, by id. */
  drivers: Record<string, HistoryDriver>;
  constructors: Record<string, HistoryConstructor>;
}

/** public/history/circuits/index.json: every circuit with a file. */
export interface CircuitHistoryIndex {
  format: typeof CIRCUIT_HISTORY_FORMAT;
  source: HistorySource;
  circuits: {
    id: string;
    name: string;
    place: string;
    country: string;
    racesHeld: number;
    firstYear: number;
    lastYear: number;
  }[];
}
