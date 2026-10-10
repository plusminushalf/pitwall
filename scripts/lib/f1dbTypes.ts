// The F1DB tables circuit and driver history are built from (f1db-json-splitted.zip, schema v6.5): only the fields read.
// Each table is a JSON array in its own file, f1db-<table>.json. https://github.com/f1db/f1db

export interface F1dbCircuit {
  id: string;
  name: string;
  fullName: string;
  previousNames: string[] | null;
  type: "RACE" | "ROAD" | "STREET";
  direction: "CLOCKWISE" | "ANTI_CLOCKWISE";
  placeName: string;
  countryId: string;
  latitude: number;
  longitude: number;
  length: number; // km
  turns: number;
  totalRacesHeld: number;
}

export interface F1dbCircuitLayout {
  id: string;
  circuitId: string;
  /** The layout in use now (or last). */
  effective: boolean;
  length: number;
  turns: number;
}

export interface F1dbCountry {
  id: string;
  alpha2Code: string;
  name: string;
}

export interface F1dbGrandPrix {
  id: string;
  fullName: string; // "Italian Grand Prix"
}

export interface F1dbDriver {
  id: string;
  name: string; // "Lando Norris"
  firstName: string;
  lastName: string;
  abbreviation: string;
  permanentNumber: string | null;
  dateOfBirth: string;
  dateOfDeath: string | null;
  placeOfBirth: string;
  countryOfBirthCountryId: string;
  nationalityCountryId: string;
}

export interface F1dbConstructor {
  id: string;
  name: string;
}

export interface F1dbRace {
  id: number;
  year: number;
  round: number;
  date: string;
  grandPrixId: string;
  circuitId: string;
  circuitLayoutId: string;
  laps: number;
  distance: number; // km
  sprintRaceDate: string | null;
  driversChampionshipDecider: boolean | null;
  constructorsChampionshipDecider: boolean | null;
}

/** Fields every per-driver race table has. */
interface F1dbRaceRow {
  raceId: number;
  positionDisplayOrder: number;
  /** Null when not classified (DNF, DSQ, ...: positionText says which). */
  positionNumber: number | null;
  positionText: string;
  driverNumber: string | null;
  driverId: string;
  constructorId: string;
}

export interface F1dbRaceResult extends F1dbRaceRow {
  laps: number | null;
  time: string | null;
  gap: string | null;
  gridPositionNumber: number | null;
  polePosition: boolean;
  fastestLap: boolean;
}

export interface F1dbQualifyingResult extends F1dbRaceRow {
  /** The time that set the position (single-session formats); null in knockout years, which have q1..q3. */
  time: string | null;
  timeMillis: number | null;
  q1: string | null;
  q1Millis: number | null;
  q2: string | null;
  q2Millis: number | null;
  q3: string | null;
  q3Millis: number | null;
}

export interface F1dbFastestLap extends F1dbRaceRow {
  lap: number | null;
  time: string | null;
  timeMillis: number | null;
}

export type F1dbDriverOfTheDay = F1dbRaceRow;

/** A driver's season: Grand Prix totals, and the championship position. */
export interface F1dbSeasonDriver {
  year: number;
  driverId: string;
  positionNumber: number | null;
  totalRaceStarts: number;
  totalRaceWins: number;
  totalPodiums: number;
  totalPoints: number;
  totalPolePositions: number;
  totalFastestLaps: number;
}

export interface F1dbSeasonDriverStanding {
  year: number;
  driverId: string;
  /** Champion (only once the season's settled). */
  championshipWon: boolean;
}

/** A driver entered for a team in a season; test drivers have no rounds. */
export interface F1dbSeasonEntrantDriver {
  year: number;
  constructorId: string;
  driverId: string;
  rounds: number[];
  testDriver: boolean;
}

/** The tables the history builds read (circuitHistory.ts, driverHistory.ts), as parsed from the release. */
export interface F1db {
  circuits: F1dbCircuit[];
  circuitLayouts: F1dbCircuitLayout[];
  countries: F1dbCountry[];
  grandsPrix: F1dbGrandPrix[];
  drivers: F1dbDriver[];
  constructors: F1dbConstructor[];
  races: F1dbRace[];
  raceResults: F1dbRaceResult[];
  qualifyingResults: F1dbQualifyingResult[];
  fastestLaps: F1dbFastestLap[];
  driverOfTheDay: F1dbDriverOfTheDay[];
  seasonsDrivers: F1dbSeasonDriver[];
  seasonsDriverStandings: F1dbSeasonDriverStanding[];
  seasonsEntrantsDrivers: F1dbSeasonEntrantDriver[];
}

/** The file each table is read from, inside the zip. */
export const F1DB_FILES: Readonly<Record<keyof F1db, string>> = {
  circuits: "f1db-circuits.json",
  circuitLayouts: "f1db-circuits-layouts.json",
  countries: "f1db-countries.json",
  grandsPrix: "f1db-grands-prix.json",
  drivers: "f1db-drivers.json",
  constructors: "f1db-constructors.json",
  races: "f1db-races.json",
  raceResults: "f1db-races-race-results.json",
  qualifyingResults: "f1db-races-qualifying-results.json",
  fastestLaps: "f1db-races-fastest-laps.json",
  driverOfTheDay: "f1db-races-driver-of-the-day-results.json",
  seasonsDrivers: "f1db-seasons-drivers.json",
  seasonsDriverStandings: "f1db-seasons-driver-standings.json",
  seasonsEntrantsDrivers: "f1db-seasons-entrants-drivers.json",
};
