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

// ---------------------------------------------------------------- drivers

/** Bumped when the driver files' shape changes. */
export const DRIVER_HISTORY_FORMAT = 1;

/** What a driver did over some seasons: Grands Prix only (sprints aren't counted), points all included. */
export interface DriverTotals {
  starts: number;
  wins: number;
  podiums: number;
  poles: number;
  fastestLaps: number;
  points: number;
  /** Drivers' championships. */
  titles: number;
}

/** A driver's season. */
export interface DriverSeason extends DriverTotals {
  year: number;
  /** The teams raced for, in the order raced for them. */
  teams: string[];
  /** Championship position; null if not classified. */
  position: number | null;
}

export interface DriverBio {
  /** F1DB's driver id ("max-verstappen"): the file's name. */
  id: string;
  name: string; // "Max Verstappen"
  firstName: string;
  lastName: string;
  abbreviation: string; // "VER"
  /** Permanent car number, since 2014. */
  number: string | null;
  dateOfBirth: string; // "1997-09-30"
  dateOfDeath: string | null;
  placeOfBirth: string;
  countryOfBirth: string; // "Belgium"
  nationality: string; // "Netherlands"
  /** ISO 3166 alpha-2 of the nationality ("NL"), for its flag. */
  nationalityCode: string;
}

/** One car's Grand Prix: where it qualified, started and finished. Absent fields are null / false. */
export interface CarResult {
  driverId: string;
  constructorId: string;
  number?: string;
  /** Qualifying and starting grid position. */
  quali?: number;
  grid?: number;
  /** Finishing position; absent when not classified (`text` says why). */
  pos?: number;
  /** "1", "DNF", "DSQ", "NC". */
  text: string;
  /** F1DB's order of the result sheet, the unclassified last: who finished ahead of whom. */
  order: number;
  points?: number;
  pole?: true;
  fastestLap?: true;
  /** Why it retired ("Engine", "Collision"). */
  reason?: string;
}

/** A Grand Prix (sprints aren't counted). */
export interface RaceRef {
  raceId: number;
  year: number;
  round: number;
  date: string;
  /** Grand Prix and circuit ids: names in the file's `names`. */
  gp: string;
  circuit: string;
}

/** The names a file's races mention, by id. */
export interface HistoryNames {
  gps: Record<string, { name: string; short: string; code: string }>;
  circuits: Record<string, string>;
  teams: Record<string, string>;
  drivers: Record<string, { name: string; lastName: string }>;
}

/** A Grand Prix the driver started, with their teammates' results there. */
export interface DriverRace extends RaceRef {
  car: CarResult;
  mates: CarResult[];
}

/** public/history/drivers/<id>.json */
export interface DriverHistory {
  format: typeof DRIVER_HISTORY_FORMAT;
  source: HistorySource;
  driver: DriverBio;
  /** Every season with a race entry, oldest first. */
  seasons: DriverSeason[];
  /** Every Grand Prix started, oldest first. */
  races: DriverRace[];
  names: HistoryNames;
}

/** A driver of the season on Home's board. */
export interface SeasonDriver {
  id: string;
  name: string;
  lastName: string;
  abbreviation: string;
  /** The number raced with at the driver's latest race this season. */
  number: string | null;
  nationality: string;
  nationalityCode: string;
  /** The team of the driver's latest race this season, and its F1DB id. */
  team: string;
  teamId: string;
  /** The rounds raced this season. */
  rounds: number[];
  /** Raced the season's latest round: one of today's grid, not a stand-in or a driver replaced. */
  current: boolean;
  /** Up to the end of last season: history, never a spoiler. */
  before: DriverTotals;
  /** This season so far (the rounds F1DB has): spoilers. */
  season: DriverTotals & { position: number | null };
}

/** public/history/drivers/index.json: the season's drivers. */
export interface DriverIndex {
  format: typeof DRIVER_HISTORY_FORMAT;
  source: HistorySource;
  year: number;
  /** The latest round with results in F1DB, and its Grand Prix; null before the season's first race. */
  throughRound: number | null;
  throughGrandPrix: string | null;
  drivers: SeasonDriver[];
}

// ---------------------------------------------------------------- teams

/** What a team did over some seasons: Grands Prix only, points all included. */
export interface TeamTotals {
  starts: number;
  wins: number;
  /** Podium places: two cars on it count twice. */
  podiums: number;
  /** Races its cars finished first and second. */
  oneTwos: number;
  poles: number;
  fastestLaps: number;
  points: number;
  /** Constructors' championships. */
  titles: number;
}

export interface TeamSeason extends TeamTotals {
  year: number;
  /** Championship position; null where not classified. */
  position: number | null;
  /** The drivers who raced for it, most races first. */
  drivers: string[];
  /** Its drivers' champion, if it drove for the team. */
  driversTitle: string | null;
}

export interface TeamBio {
  /** F1DB's constructor id ("red-bull"): the file's name. */
  id: string;
  name: string; // "Red Bull"
  fullName: string; // "Red Bull Racing"
  nationality: string;
  nationalityCode: string;
  /** Its engine in its latest season ("Honda RBPT"). */
  engine: string | null;
}

/** A Grand Prix the team raced in: every car of its. */
export interface TeamRace extends RaceRef {
  cars: CarResult[];
}

/** public/history/teams/<id>.json */
export interface TeamHistory {
  format: typeof DRIVER_HISTORY_FORMAT;
  source: HistorySource;
  team: TeamBio;
  /** Oldest first. */
  seasons: TeamSeason[];
  /** Every Grand Prix started, oldest first. */
  races: TeamRace[];
  names: HistoryNames;
}

/** A team of the season on Home's board. */
export interface SeasonTeam {
  id: string;
  name: string;
  nationality: string;
  nationalityCode: string;
  engine: string | null;
  /** Its drivers this season, the latest round's first. */
  drivers: { id: string; lastName: string; current: boolean }[];
  /** Up to the end of last season: history. */
  before: TeamTotals;
  /** This season so far: spoilers. */
  season: TeamTotals & { position: number | null };
}

/** public/history/teams/index.json: the season's teams. */
export interface TeamIndex {
  format: typeof DRIVER_HISTORY_FORMAT;
  source: HistorySource;
  year: number;
  throughRound: number | null;
  throughGrandPrix: string | null;
  teams: SeasonTeam[];
}
