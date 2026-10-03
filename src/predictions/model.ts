// Called It (/predictions): a fan's call of who leads into Turn 1 at the next race, from the top five on its
// starting grid, made into a card to post before lights out. All in the browser: the post's own time is the proof.

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

/** The next race: the one calls are for (open once its starting grid's top five are in GRID_TOP5). */
export const nextRace = (now: number): Race | undefined => RACES.find((r) => r.start > now);

export interface Driver {
  number: number;
  first: string;
  last: string;
  code: string;
  team: TeamId;
  /** Where they start, penalties applied. */
  grid: number;
}

const driver = (grid: number, number: number, first: string, last: string, code: string, team: TeamId): Driver => ({ number, first, last, code, team, grid });

/**
 * The top five of each race's starting grid, penalties applied (formula1.com's starting grid; OpenF1's
 * /starting_grid only has it near the start), the drivers a call picks from. Calls for a race open once its five are
 * here: add them after qualifying, and check again when grid penalties come out.
 */
export const GRID_TOP5: Record<number, Driver[]> = {
  // Qualifying 11730 (2026-10-03), then Hadjar's five-place penalty (his seventh engine) took him from 3rd to 8th.
  11731: [
    driver(1, 3, "Max", "Verstappen", "VER", "redbull"),
    driver(2, 44, "Lewis", "Hamilton", "HAM", "ferrari"),
    driver(3, 12, "Kimi", "Antonelli", "ANT", "mercedes"),
    driver(4, 16, "Charles", "Leclerc", "LEC", "ferrari"),
    driver(5, 1, "Lando", "Norris", "NOR", "mclaren"),
  ],
};

export const topFive = (race: number): Driver[] => GRID_TOP5[race] ?? [];
export const driverIn = (race: number, number: number): Driver | undefined => topFive(race).find((d) => d.number === number);
/** What's called: who's ahead coming out of Turn 1, by car number (none picked yet: null). */
export type Call = { kind: "turn1-leader"; driver: number | null };

/** The race calls are for now: the next one, once its grid's top five are in. */
export function openRace(now: number): Race | null {
  const race = nextRace(now);
  return race && topFive(race.id).length ? race : null;
}
