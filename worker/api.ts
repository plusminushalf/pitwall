// Called It's API, apart from where calls are kept (the Store), so it can be tested without Cloudflare.
//   POST /api/predictions              { race, teams, hook, tz }  -> { prediction, ownerToken }   lock a call
//   GET  /api/predictions/:id                                     -> { prediction }
//   POST /api/predictions/:id/result   { token, order }           -> { prediction }               reveal it, once
// The server's clock is the only one that counts: a call is stamped when it's stored, and refused once lights are out.

import {
  cleanHook,
  ID_PATTERN,
  lockProblem,
  raceById,
  safeTz,
  threeTeams,
  type NewPrediction,
  type Prediction,
  type Result,
} from "../src/predictions/model";

/** A stored call: the public part and the hash of the caller's token. */
export interface Stored extends Prediction {
  ownerHash: string;
}

export interface Store {
  /** Adds a call; false if its id is taken. */
  insert(p: Stored): Promise<boolean>;
  get(id: string): Promise<Stored | null>;
  /** Sets the result if there isn't one yet; false if there was. */
  reveal(id: string, result: Result): Promise<boolean>;
}

const ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz";
const randomId = () => [...crypto.getRandomValues(new Uint8Array(7))].map((b) => ALPHABET[b % ALPHABET.length]).join("");
const randomToken = () => [...crypto.getRandomValues(new Uint8Array(24))].map((b) => b.toString(16).padStart(2, "0")).join("");

export async function sha256(s: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const problem = (error: string, status = 400) => json({ error }, status);

const publicPart = ({ ownerHash: _, ...p }: Stored): Prediction => p;

/** Bodies are a few hundred bytes; anything much bigger isn't a call. */
const MAX_BODY = 4096;
async function readBody(req: Request): Promise<Record<string, unknown> | null> {
  const text = await req.text();
  if (text.length > MAX_BODY) return null;
  try {
    const v: unknown = JSON.parse(text);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const ROUTE = /^\/api\/predictions(?:\/([^/]+)(\/result)?)?\/?$/;

/** The response to an /api/predictions request, or null if it isn't one. */
export async function handleApi(req: Request, store: Store, now: () => number = Date.now): Promise<Response | null> {
  const m = ROUTE.exec(new URL(req.url).pathname);
  if (!m) return null;
  const [, id, result] = m;

  if (!id) {
    if (req.method !== "POST") return problem("Method not allowed", 405);
    const body = await readBody(req);
    if (!body) return problem("That isn't a call");
    const input: NewPrediction = {
      race: Number(body.race),
      teams: Array.isArray(body.teams) ? body.teams : [],
      hook: typeof body.hook === "string" ? body.hook : "",
    };
    const why = lockProblem(input, now());
    const started = (raceById(input.race)?.start ?? Infinity) <= now();
    if (why) return problem(why, started ? 409 : 400);
    const ownerToken = randomToken();
    const ownerHash = await sha256(ownerToken);
    for (let attempt = 0; attempt < 5; attempt++) {
      const p: Stored = {
        id: randomId(),
        race: input.race,
        teams: threeTeams(input.teams)!,
        hook: cleanHook(input.hook),
        // Stamped here, after every check, so nothing the page sends can move it.
        lockedAt: now(),
        tz: safeTz(body.tz),
        result: null,
        ownerHash,
      };
      if (await store.insert(p)) return json({ prediction: publicPart(p), ownerToken }, 201);
    }
    return problem("Couldn't lock it, try again", 503);
  }

  if (!ID_PATTERN.test(id)) return problem("No such call", 404);
  const stored = await store.get(id);
  if (!stored) return problem("No such call", 404);

  if (!result) {
    if (req.method !== "GET") return problem("Method not allowed", 405);
    return json({ prediction: publicPart(stored) });
  }

  if (req.method !== "POST") return problem("Method not allowed", 405);
  const body = await readBody(req);
  if (!body || typeof body.token !== "string") return problem("Only the caller can reveal this", 403);
  if ((await sha256(body.token)) !== stored.ownerHash) return problem("Only the caller can reveal this", 403);
  if (stored.result) return problem("The result is already in", 409);
  if (now() < raceById(stored.race)!.start) return problem("Lights aren't out yet", 409);
  const order = threeTeams(body.order);
  if (!order || !stored.teams.every((t) => order.includes(t))) return problem("Put the same three teams in order");
  const res: Result = { order, source: "manual", at: now() };
  if (!(await store.reveal(id, res))) return problem("The result is already in", 409);
  return json({ prediction: { ...publicPart(stored), result: res } });
}

/** A Store in memory, for tests and local tries. */
export function memoryStore(): Store {
  const rows = new Map<string, Stored>();
  return {
    async insert(p) {
      if (rows.has(p.id)) return false;
      rows.set(p.id, structuredClone(p));
      return true;
    },
    async get(id) {
      const p = rows.get(id);
      return p ? structuredClone(p) : null;
    },
    async reveal(id, result) {
      const p = rows.get(id);
      if (!p || p.result) return false;
      p.result = structuredClone(result);
      return true;
    },
  };
}
