// Called It (/predictions): a fan's call of who leads into Turn 1 at the next race, from the top five in its
// qualifying, locked before lights out with the server's clock, and revealed after the start. Shared by the page (src/predictions/) and
// the Worker (worker/), so both read a call, a race, a team and a driver the same way.

export const TEAMS = [
  { id: "mclaren", name: "McLaren", colour: "#F47600" },
  { id: "ferrari", name: "Ferrari", colour: "#ED1131" },
  { id: "redbull", name: "Red Bull", colour: "#4781D7" },
  { id: "mercedes", name: "Mercedes", colour: "#00D7B6" },
  { id: "aston", name: "Aston Martin", colour: "#229971" },
  { id: "alpine", name: "Alpine", colour: "#00A1E8" },
  { id: "williams", name: "Williams", colour: "#1868DB" },
  { id: "rb", name: "Racing Bulls", colour: "#6C98FF" },
  { id: "haas", name: "Haas", colour: "#9C9FA2" },
  { id: "audi", name: "Audi", colour: "#F50537" },
  { id: "cadillac", name: "Cadillac", colour: "#909090" },
] as const;
// Colours: OpenF1's team_colour for 2026 (the broadcast's).

export type TeamId = (typeof TEAMS)[number]["id"];
export type Team = (typeof TEAMS)[number];

const TEAM_BY_ID = new Map<string, Team>(TEAMS.map((t) => [t.id, t]));
export const team = (id: TeamId): Team => TEAM_BY_ID.get(id)!;
export const isTeamId = (v: unknown): v is TeamId => typeof v === "string" && TEAM_BY_ID.has(v);

export interface Race {
  /** OpenF1's session key of the race, so a pit-stop feed can find it later. */
  id: number;
  name: string;
  /** For tight spaces: "Singapore GP". */
  short: string;
  place: string;
  /** Lights out, ms since the epoch (UTC). Calls lock until then. */
  start: number;
}

const race = (id: number, name: string, place: string, start: string): Race => ({
  id,
  name,
  short: name.replace(/ Grand Prix$/, " GP"),
  place,
  start: Date.parse(start),
});

/** The 2026 season's races (OpenF1 sessions, cancelled ones left out). */
export const RACES: Race[] = [
  race(11234, "Australian Grand Prix", "Melbourne", "2026-03-08T04:00:00Z"),
  race(11245, "Chinese Grand Prix", "Shanghai", "2026-03-15T07:00:00Z"),
  race(11253, "Japanese Grand Prix", "Suzuka", "2026-03-29T05:00:00Z"),
  race(11280, "Miami Grand Prix", "Miami", "2026-05-03T17:00:00Z"),
  race(11291, "Canadian Grand Prix", "Montréal", "2026-05-24T20:00:00Z"),
  race(11299, "Monaco Grand Prix", "Monte Carlo", "2026-06-07T13:00:00Z"),
  race(11307, "Barcelona Grand Prix", "Barcelona", "2026-06-14T13:00:00Z"),
  race(11315, "Austrian Grand Prix", "Spielberg", "2026-06-28T13:00:00Z"),
  race(11326, "British Grand Prix", "Silverstone", "2026-07-05T14:00:00Z"),
  race(11334, "Belgian Grand Prix", "Spa", "2026-07-19T13:00:00Z"),
  race(11342, "Hungarian Grand Prix", "Budapest", "2026-07-26T13:00:00Z"),
  race(11353, "Dutch Grand Prix", "Zandvoort", "2026-08-23T13:00:00Z"),
  race(11361, "Italian Grand Prix", "Monza", "2026-09-06T13:00:00Z"),
  race(11369, "Spanish Grand Prix", "Madrid", "2026-09-13T13:00:00Z"),
  race(11377, "Azerbaijan Grand Prix", "Baku", "2026-09-26T11:00:00Z"),
  // The Bahrain GP moved to Sepang (meeting 1308); the April one at Sakhir was cancelled.
  race(11731, "Bahrain Grand Prix", "Sepang", "2026-10-04T07:00:00Z"),
  race(11388, "Singapore Grand Prix", "Marina Bay", "2026-10-11T12:00:00Z"),
  race(11396, "United States Grand Prix", "Austin", "2026-10-25T20:00:00Z"),
  race(11404, "Mexico City Grand Prix", "Mexico City", "2026-11-01T20:00:00Z"),
  race(11412, "São Paulo Grand Prix", "Interlagos", "2026-11-08T17:00:00Z"),
  race(11420, "Las Vegas Grand Prix", "Las Vegas", "2026-11-22T04:00:00Z"),
  race(11428, "Qatar Grand Prix", "Lusail", "2026-11-29T16:00:00Z"),
  race(11436, "Abu Dhabi Grand Prix", "Yas Marina", "2026-12-06T13:00:00Z"),
];

const RACE_BY_ID = new Map(RACES.map((r) => [r.id, r]));
export const raceById = (id: number): Race | undefined => RACE_BY_ID.get(id);
/** The next race: the one calls are for (open once its qualifying's top five are in QUALI_TOP5). */
export const nextRace = (now: number): Race | undefined => RACES.find((r) => r.start > now);

export interface Driver {
  number: number;
  first: string;
  last: string;
  code: string;
  team: TeamId;
  /** Where they qualified. */
  quali: number;
}

const driver = (quali: number, number: number, first: string, last: string, code: string, team: TeamId): Driver => ({ number, first, last, code, team, quali });

/**
 * The top five from each race's qualifying (OpenF1's session_result), the drivers a call picks from. Calls for a race
 * open once its five are here: add them after each qualifying.
 */
export const QUALI_TOP5: Record<number, Driver[]> = {
  // Qualifying 11730, 2026-10-03.
  11731: [
    driver(1, 3, "Max", "Verstappen", "VER", "redbull"),
    driver(2, 44, "Lewis", "Hamilton", "HAM", "ferrari"),
    driver(3, 6, "Isack", "Hadjar", "HAD", "redbull"),
    driver(4, 12, "Kimi", "Antonelli", "ANT", "mercedes"),
    driver(5, 16, "Charles", "Leclerc", "LEC", "ferrari"),
  ],
};

export const topFive = (race: number): Driver[] => QUALI_TOP5[race] ?? [];
export const driverIn = (race: number, number: number): Driver | undefined => topFive(race).find((d) => d.number === number);
/** In a result: the leader wasn't one of the five. */
export const SOMEONE_ELSE = 0;

/**
 * What was called: who's ahead coming out of Turn 1, by car number. The kind is stored with it, so other calls can
 * join later without reading old ones differently.
 */
export type Call = { kind: "turn1-leader"; driver: number };

/** What really happened, in the same terms (driver: SOMEONE_ELSE if it wasn't one of the five). */
export type Outcome = { kind: "turn1-leader"; driver: number };

/**
 * The outcome, and where it came from. "manual": the caller entered it after the start. Timing data has no
 * Turn 1 line, but a feed (OpenF1's /location or /position for the race's session key) can add its own source without
 * changing the call.
 */
export type Result = Outcome & { source: "manual"; at: number };

/** A locked call, as anyone with its link sees it. */
export interface Prediction {
  id: string;
  race: number;
  call: Call;
  /** When the server locked it, ms since the epoch. */
  lockedAt: number;
  /** The caller's time zone (IANA), so the card reads in their local time for everyone. */
  tz: string;
  result: Result | null;
}

/** What the page sends to lock a call. */
export interface NewPrediction {
  race: number;
  call: unknown;
  tz?: string;
}

const record = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

/** A call for this race, or null: one of its top five. */
export function readCall(v: unknown, race: number): Call | null {
  const o = record(v);
  return o?.kind === "turn1-leader" && typeof o.driver === "number" && driverIn(race, o.driver) ? { kind: "turn1-leader", driver: o.driver } : null;
}

/** An outcome for a call on this race, or null: one of the five, or SOMEONE_ELSE. */
export function readOutcome(v: unknown, race: number): Outcome | null {
  const o = record(v);
  const d = o?.driver;
  return o?.kind === "turn1-leader" && typeof d === "number" && (d === SOMEONE_ELSE || driverIn(race, d)) ? { kind: "turn1-leader", driver: d } : null;
}

/** Why a call can't be locked, or null if it can. */
export function lockProblem(p: NewPrediction, now: number): string | null {
  const r = raceById(p.race);
  if (!r) return "Pick a race";
  if (r.start <= now) return "Lights are already out for that one";
  if (!topFive(p.race).length) return "Calls open after qualifying";
  if (!readCall(p.call, p.race)) return "Pick a driver";
  return null;
}

/** Whether the call was right. */
export const calledIt = (call: Call, outcome: Outcome) => outcome.driver === call.driver;

/** A time zone the runtime knows, or UTC. */
export function safeTz(tz: unknown): string {
  if (typeof tz !== "string" || tz.length > 64) return "UTC";
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return tz;
  } catch {
    return "UTC";
  }
}

export const predictionPath = (id: string) => `/predictions/${id}`;
export const ID_PATTERN = /^[23456789abcdefghjkmnpqrstuvwxyz]{7}$/;
