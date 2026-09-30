// Dev only: the vault dev server's side of simulate mode (vite.config.ts mounts it at /__sim/ when
// VAULT_SIMULATE is set; a build never has it). It is the "network" the in-vault simulated broker (src/sim.ts)
// and the dev vault's REST and /token talk to, all on the vault's own origin (nothing under the app's):
//
//   GET  /__sim/config                  the clock anchor, speed, session, token lifetime, faults
//   GET  /__sim/feed?from=&to=          what the session published in (from, to] (sim ms), as MQTT payloads
//   POST /__sim/token                   OpenF1's /token: any email + password; a fake JWT lasting VAULT_SIMULATE_TOKEN_S
//   GET  /__sim/v1/<endpoint>?...       OpenF1's REST as of the current sim time (401 for a bad or expired token; 429 over 6/s)
//   POST /__sim/connect|sync|close|bye  the broker's session table: CONNECT checks (token, email, armed refusals),
//                                       liveness (a silent session expires after 1.5 x keepalive, as at OpenF1)
//   POST /__sim/control/drop            drop every session now          (also: VAULT_SIMULATE_DROP_EVERY minutes)
//   POST /__sim/control/refuse?n=1      CONNACK 5 for the next n CONNECTs (also: VAULT_SIMULATE_REFUSE_AT minutes)
//   POST /__sim/control/reset?...       restart the simulation now (session, speed, start, token, dropEvery, jitter, refuseAt)
//   POST /__sim/control/stats-reset     zero the counters (max sessions = open now)
//   GET  /__sim/stats                   sessions now / max, connects, refusals, drops, tokens, REST counts
//
// The data: data/raw/<VAULT_SIMULATE>/ (gitignored; `bun run ingest <key>`), turned into a timeline by simdata.ts.

import { createHmac, randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { SIM_TOPICS, buildTimeline, countUntil, offsetOf, payload, restQuery, simNow, type SimClock, type Timeline } from "./simdata.ts";

export type SimOptions = {
  sessionKey: number;
  speed: number;
  /** Seconds from lights out where the simulation starts (negative: before). */
  startS: number;
  tokenS: number;
  dropEveryMin: number;
  /** One CONNACK 5 at the first CONNECT this many minutes after the start (null: none). */
  refuseAtMin: number | null;
  jitterMs: number;
  /** Enforce 1.5 x keepalive at the broker (on by default). */
  keepaliveCheck: boolean;
};

const num = (raw: string, name: string, min: number, max: number, int = false) => {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max || (int && !Number.isInteger(n))) throw new Error(`${name}: ${int ? "an integer" : "a number"} from ${min} to ${max} (got ${raw})`);
  return n;
};

/** The options from VAULT_SIMULATE* (null: simulate mode off). Throws on a bad value (the dev server won't start). */
export function simOptionsFromEnv(env: (name: string) => string): SimOptions | null {
  const key = env("VAULT_SIMULATE");
  if (!key) return null;
  const o = (name: string, d: string) => env(name) || d;
  const refuse = env("VAULT_SIMULATE_REFUSE_AT");
  return {
    sessionKey: num(key, "VAULT_SIMULATE (a session key)", 1, 1e7, true),
    speed: num(o("VAULT_SIMULATE_SPEED", "1"), "VAULT_SIMULATE_SPEED", 0.1, 60),
    startS: num(o("VAULT_SIMULATE_START", "-60"), "VAULT_SIMULATE_START (s from lights out)", -86_400, 86_400),
    tokenS: num(o("VAULT_SIMULATE_TOKEN_S", "3600"), "VAULT_SIMULATE_TOKEN_S", 20, 3600, true),
    dropEveryMin: num(o("VAULT_SIMULATE_DROP_EVERY", "0"), "VAULT_SIMULATE_DROP_EVERY (minutes)", 0, 600),
    refuseAtMin: refuse ? num(refuse, "VAULT_SIMULATE_REFUSE_AT (minutes)", 0, 600) : null,
    jitterMs: num(o("VAULT_SIMULATE_JITTER", "0"), "VAULT_SIMULATE_JITTER (ms)", 0, 5000),
    keepaliveCheck: env("VAULT_SIMULATE_KEEPALIVE") !== "off",
  };
}

type Session = { instance: string; session: string; clientId: string; openedAt: number; lastSeen: number; keepaliveS: number };

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");
const FEED_MAX = 60_000;
const NGINX_429 = "<html>\r\n<head><title>429 Too Many Requests</title></head>\r\n<body>\r\n<center><h1>429 Too Many Requests</h1></center>\r\n<hr><center>nginx</center>\r\n</body>\r\n</html>\r\n";

export class SimServer {
  opts: SimOptions;
  private tl: Timeline;
  private clock: SimClock;
  private version = 1;
  private manualDrops = 0;
  private refuseNext = 0;
  private refuseAtArmed: boolean;
  private sessions = new Map<string, Session>();
  /** Sessions kicked by a reused clientId, per instance (told at its next sync; it may be frozen now). */
  private kicked = new Map<string, string[]>();
  private secret = randomBytes(32);
  private minted = 0;
  private tokenTimes: number[] = [];
  private restTimes = { auth: [] as number[], anon: [] as number[] };
  stats = { current: 0, max: 0, connects: 0, refused: 0, expired: 0, kicked: 0, drops: 0, tokens: 0, rest: 0, restAuthorized: 0, rest401: 0, rest429: 0 };

  constructor(
    private repo: string,
    opts: SimOptions,
    private log: (s: string) => void = () => {},
  ) {
    this.opts = opts;
    this.tl = buildTimeline(repo, opts.sessionKey, opts.startS);
    this.clock = { anchorWall: Date.now(), startOrig: this.tl.startOrig, speed: opts.speed };
    this.refuseAtArmed = opts.refuseAtMin !== null;
    this.announce();
  }

  private announce() {
    const h = ((this.tl.endOrig - this.tl.startOrig) / 3.6e6).toFixed(2);
    this.log(`[vault sim] #${this.tl.sessionKey} ${this.tl.label}: ${this.tl.at.length} events, ${h} h from lights out ${this.opts.startS >= 0 ? "+" : ""}${this.opts.startS} s, at ${this.opts.speed}x (${((Number(h) * 60) / this.opts.speed).toFixed(1)} min); tokens last ${this.opts.tokenS} s`);
  }

  config() {
    const off = offsetOf(this.clock);
    return {
      sessionKey: this.tl.sessionKey,
      label: this.tl.label,
      speed: this.clock.speed,
      anchorWall: this.clock.anchorWall,
      start: this.tl.startOrig + off,
      lightsOut: this.tl.lightsOut + off,
      end: this.tl.endOrig + off,
      tokenS: this.opts.tokenS,
      dropEveryMin: this.opts.dropEveryMin,
      jitterMs: this.opts.jitterMs,
      version: this.version,
      topics: [...SIM_TOPICS],
      keepaliveCheck: this.opts.keepaliveCheck,
    };
  }

  /** The timeline and clock (e2e rebuilds the source from the same data). */
  get timeline() {
    return this.tl;
  }

  reset(patch: Partial<SimOptions>) {
    const next = { ...this.opts, ...patch };
    if (next.sessionKey !== this.opts.sessionKey || next.startS !== this.opts.startS) this.tl = buildTimeline(this.repo, next.sessionKey, next.startS);
    this.opts = next;
    this.clock = { anchorWall: Date.now(), startOrig: this.tl.startOrig, speed: next.speed };
    this.version++;
    this.manualDrops = 0;
    this.refuseNext = 0;
    this.refuseAtArmed = next.refuseAtMin !== null;
    this.sessions.clear();
    this.kicked.clear();
    this.resetStats(true);
    this.announce();
  }

  private resetStats(all = false) {
    this.prune();
    this.stats = { ...this.stats, max: this.sessions.size, connects: 0, refused: 0, expired: 0, kicked: 0, drops: 0, tokens: 0, rest: 0, restAuthorized: 0, rest401: 0, rest429: 0, ...(all && { current: 0, max: 0 }) };
  }

  private dropCount(now: number) {
    const periodic = this.opts.dropEveryMin > 0 ? Math.floor((now - this.clock.anchorWall) / (this.opts.dropEveryMin * 60_000)) : 0;
    return this.manualDrops + periodic;
  }

  // ---------------------------------------------------------------- tokens

  private mint(email: string, now: number) {
    const iat = Math.floor(now / 1000);
    const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
    const body = b64url(JSON.stringify({ iss: "f1-vault-simulation", email, iat, exp: iat + this.opts.tokenS, n: ++this.minted }));
    const sig = createHmac("sha256", this.secret).update(`${header}.${body}`).digest("base64url");
    return `${header}.${body}.${sig}`;
  }

  /** The token's email if it's one of ours and not expired, else null. */
  private verify(token: string, now: number): string | null {
    const [h, b, sig] = token.split(".");
    if (!h || !b || !sig) return null;
    if (createHmac("sha256", this.secret).update(`${h}.${b}`).digest("base64url") !== sig) return null;
    try {
      const claims = JSON.parse(Buffer.from(b, "base64url").toString("utf8"));
      return typeof claims.exp === "number" && now < claims.exp * 1000 && typeof claims.email === "string" ? claims.email : null;
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------- sessions

  private prune(now = Date.now()) {
    for (const [id, s] of this.sessions) {
      if (now - s.lastSeen > s.keepaliveS * 1500) {
        this.sessions.delete(id);
        this.stats.expired++;
      }
    }
    this.stats.current = this.sessions.size;
  }

  private connect(m: { instance: string; session: string; clientId: string; username: string; password: string; keepaliveS: number }, now: number): number {
    this.prune(now);
    const email = this.verify(m.password, now);
    if (!email || m.username !== email || !/^[^\s@]+@[^\s@]+$/.test(m.username)) {
      this.stats.refused++;
      return 5;
    }
    if (this.refuseNext > 0) {
      this.refuseNext--;
      this.stats.refused++;
      this.log("[vault sim] CONNACK 5 (armed refusal)");
      return 5;
    }
    if (this.refuseAtArmed && this.opts.refuseAtMin !== null && now >= this.clock.anchorWall + this.opts.refuseAtMin * 60_000) {
      this.refuseAtArmed = false;
      this.stats.refused++;
      this.log("[vault sim] CONNACK 5 (VAULT_SIMULATE_REFUSE_AT)");
      return 5;
    }
    // A reused clientId kicks the older session, at once (OpenF1: DISCONNECT 142, session taken over).
    for (const [id, o] of this.sessions) {
      if (o.clientId !== m.clientId) continue;
      this.sessions.delete(id);
      this.stats.kicked++;
      this.kicked.set(o.instance, [...(this.kicked.get(o.instance) ?? []), id]);
    }
    this.sessions.set(m.session, { instance: m.instance, session: m.session, clientId: m.clientId, openedAt: now, lastSeen: now, keepaliveS: Math.max(1, m.keepaliveS) });
    this.stats.connects++;
    this.stats.current = this.sessions.size;
    this.stats.max = Math.max(this.stats.max, this.sessions.size);
    return 0;
  }

  // ---------------------------------------------------------------- HTTP

  /** Handle a /__sim/ request; false if it isn't one. */
  handle(req: IncomingMessage, res: ServerResponse): boolean {
    const url = new URL(req.url ?? "/", "http://vault");
    if (!url.pathname.startsWith("/__sim/")) return false;
    const path = url.pathname.slice("/__sim".length);
    const send = (status: number, body: unknown, type = "application/json") => {
      res.statusCode = status;
      res.setHeader("Content-Type", type);
      res.setHeader("Cache-Control", "no-store");
      res.end(typeof body === "string" ? body : JSON.stringify(body));
    };
    void (async () => {
      try {
        const now = Date.now();
        const body = req.method === "POST" ? await readBody(req) : "";
        const json = () => (body ? JSON.parse(body) : {});
        if (req.method === "GET" && path === "/config") return send(200, this.config());
        if (req.method === "GET" && path === "/feed") return send(200, this.feed(Number(url.searchParams.get("from")), Number(url.searchParams.get("to"))));
        if (req.method === "GET" && path === "/stats") {
          this.prune(now);
          return send(200, { ...this.stats, simNow: simNow(this.clock, now), sessions: [...this.sessions.values()].map((s) => ({ instance: s.instance, session: s.session, clientId: s.clientId, ageS: Math.round((now - s.openedAt) / 1000), silentS: Math.round((now - s.lastSeen) / 1000) })) });
        }
        if (req.method === "POST" && path === "/token") return this.token(body, now, send);
        if (req.method === "GET" && path.startsWith("/v1/")) return this.rest(path.slice(4), url.search, req.headers.authorization, now, send);
        if (req.method === "POST" && path === "/connect") return send(200, { code: this.connect(json(), now) });
        if (req.method === "POST" && path === "/sync") {
          const m = json() as { instance: string; sessions: string[] };
          const listed = new Set(m.sessions);
          for (const [id, s] of this.sessions) if (s.instance === m.instance && !listed.has(id)) this.sessions.delete(id);
          for (const id of listed) {
            const s = this.sessions.get(id);
            if (s) s.lastSeen = now;
          }
          this.prune(now);
          const kick = this.kicked.get(m.instance) ?? [];
          this.kicked.delete(m.instance);
          return send(200, { version: this.version, drop: this.dropCount(now), kick });
        }
        if (req.method === "POST" && path === "/close") {
          this.sessions.delete((json() as { session: string }).session);
          this.stats.current = this.sessions.size;
          return send(200, {});
        }
        if (req.method === "POST" && path === "/bye") {
          const { instance } = json() as { instance: string };
          for (const [id, s] of this.sessions) if (s.instance === instance) this.sessions.delete(id);
          this.stats.current = this.sessions.size;
          return send(200, {});
        }
        if (req.method === "POST" && path.startsWith("/control/")) {
          const q = url.searchParams;
          switch (path.slice("/control/".length)) {
            case "drop":
              this.manualDrops++;
              this.stats.drops++;
              this.log("[vault sim] drop every session");
              return send(200, { drop: this.dropCount(now) });
            case "refuse":
              this.refuseNext += Number(q.get("n") ?? 1) || 1;
              return send(200, { refuseNext: this.refuseNext });
            case "stats-reset":
              this.resetStats();
              return send(200, this.stats);
            case "reset": {
              const patch: Partial<SimOptions> = {};
              if (q.has("session")) patch.sessionKey = num(q.get("session")!, "session", 1, 1e7, true);
              if (q.has("speed")) patch.speed = num(q.get("speed")!, "speed", 0.1, 60);
              if (q.has("start")) patch.startS = num(q.get("start")!, "start", -86_400, 86_400);
              if (q.has("token")) patch.tokenS = num(q.get("token")!, "token", 20, 3600, true);
              if (q.has("dropEvery")) patch.dropEveryMin = num(q.get("dropEvery")!, "dropEvery", 0, 600);
              if (q.has("jitter")) patch.jitterMs = num(q.get("jitter")!, "jitter", 0, 5000);
              if (q.has("refuseAt")) patch.refuseAtMin = q.get("refuseAt") === "" ? null : num(q.get("refuseAt")!, "refuseAt", 0, 600);
              this.reset(patch);
              return send(200, this.config());
            }
          }
        }
        send(404, { detail: "Not Found" });
      } catch (e) {
        send(400, { detail: e instanceof Error ? e.message : "bad request" });
      }
    })();
    return true;
  }

  /** Events published in (from, to] sim ms: [_id, sim time, topic index, payload]. Capped; `to` says how far it got. */
  feed(from: number, to: number) {
    if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) throw new Error("from, to: sim ms");
    const off = offsetOf(this.clock);
    const at = this.tl.at;
    const a = countUntil(at, from - off);
    let b = countUntil(at, to - off, a);
    let covered = to;
    if (b - a > FEED_MAX) {
      b = a + FEED_MAX;
      while (b < at.length && at[b] === at[b - 1]) b++; // never split one instant
      covered = at[b - 1]! + off;
    }
    const events: [number, number, number, string][] = [];
    for (let i = a; i < b; i++) events.push([i + 1, at[i]! + off, this.tl.topic[i]!, payload(this.tl, i, off)]);
    return { to: covered, events };
  }

  private token(body: string, now: number, send: (s: number, b: unknown, t?: string) => void) {
    this.tokenTimes = this.tokenTimes.filter((t) => t > now - 2000);
    this.tokenTimes.push(now);
    if (this.tokenTimes.length > 8) return send(429, NGINX_429, "text/html");
    const form = new URLSearchParams(body);
    const username = form.get("username") ?? "";
    const password = form.get("password") ?? "";
    if (!/^[^\s@]+@[^\s@]+$/.test(username) || !password) return send(401, { detail: "Incorrect username or password" });
    this.stats.tokens++;
    send(200, { access_token: this.mint(username, now), token_type: "bearer", expires_in: String(this.opts.tokenS) });
  }

  private rest(endpoint: string, search: string, auth: string | undefined, now: number, send: (s: number, b: unknown, t?: string) => void) {
    this.stats.rest++;
    let authed = false;
    if (auth) {
      const token = auth.replace(/^Bearer /, "");
      if (!this.verify(token, now)) {
        this.stats.rest401++;
        return send(401, { detail: "Invalid ID token: Token expired" });
      }
      authed = true;
      this.stats.restAuthorized++;
    }
    // OpenF1's limits: 6/s and 60/min with a login, 3/s and 30/min without.
    const times = authed ? this.restTimes.auth : this.restTimes.anon;
    while (times.length && times[0]! <= now - 60_000) times.shift();
    const inSecond = times.filter((t) => t > now - 1000).length;
    if (inSecond >= (authed ? 6 : 3) || times.length >= (authed ? 60 : 30)) {
      this.stats.rest429++;
      return send(429, { detail: "Rate limit exceeded" });
    }
    times.push(now);
    const rows = restQuery(this.tl, this.clock, endpoint, search, simNow(this.clock, now));
    if (rows === null) return send(404, { detail: "Not Found" });
    if (!rows.length) return send(404, { detail: "No results found." });
    send(200, rows);
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > 1 << 20) reject(new Error("body too big"));
      else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
