// Called It (/predictions): a fan's call of which of three teams pits first, locked before lights out with the
// server's clock, and revealed after the race. Shared by the page (src/predictions/) and the Worker (worker/), so
// both read a call, a race and a team the same way.

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
/** Races a call can still be locked for. */
export const openRaces = (now: number) => RACES.filter((r) => r.start > now);

export const HOOK_MAX = 60;

/** A locked call, as anyone with its link sees it. */
export interface Prediction {
  id: string;
  race: number;
  /** Who pits first, second, third. */
  teams: [TeamId, TeamId, TeamId];
  hook: string;
  /** When the server locked it, ms since the epoch. */
  lockedAt: number;
  /** The caller's time zone (IANA), so the card reads in their local time for everyone. */
  tz: string;
  result: Result | null;
}

/**
 * The real pit order of the three teams. "manual": the caller typed it in after the race. A pit-stop feed (OpenF1's
 * /pit for the race's session key) can add its own source without changing the call.
 */
export interface Result {
  order: [TeamId, TeamId, TeamId];
  source: "manual";
  at: number;
}

/** What the page sends to lock a call. */
export interface NewPrediction {
  race: number;
  teams: TeamId[];
  hook: string;
  tz?: string;
}

/** The hook as stored: one line, no control or text-direction characters, trimmed, at most HOOK_MAX characters. */
export function cleanHook(raw: string): string {
  return raw
    .replace(/[\p{Cc}\u202A-\u202E\u2066-\u2069]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export const hookLength = (s: string) => [...s].length;

/** Three different teams from the grid, or null. */
export function threeTeams(v: unknown): [TeamId, TeamId, TeamId] | null {
  if (!Array.isArray(v) || v.length !== 3 || !v.every(isTeamId) || new Set(v).size !== 3) return null;
  return [v[0], v[1], v[2]];
}

/** Why a call can't be locked, or null if it can. */
export function lockProblem(p: NewPrediction, now: number): string | null {
  const r = raceById(p.race);
  if (!r) return "Pick a race";
  if (r.start <= now) return "Lights are already out for that one";
  if (!threeTeams(p.teams)) return "Pick three different teams";
  const hook = cleanHook(p.hook ?? "");
  if (!hook) return "Write your hook";
  if (hookLength(hook) > HOOK_MAX) return `Keep the hook to ${HOOK_MAX} characters`;
  return null;
}

/** Which predicted places were right (by place, 1st first). */
export const hits = (p: Pick<Prediction, "teams">, r: Pick<Result, "order">): boolean[] => p.teams.map((t, i) => r.order[i] === t);

/** How the reveal reads: all three right, some, or none (a strict order of three can't have exactly two right). */
export type Verdict = "called" | "partial" | "missed";
export function verdict(p: Pick<Prediction, "teams">, r: Pick<Result, "order">): Verdict {
  const n = hits(p, r).filter(Boolean).length;
  return n === 3 ? "called" : n > 0 ? "partial" : "missed";
}

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
