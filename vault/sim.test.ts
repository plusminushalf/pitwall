// Simulate mode end to end in bun, on synthetic raw data (so it runs without data/raw): simserver.ts over
// real HTTP, the in-vault SimBroker speaking MQTT bytes to the real MqttSession, LiveManager (handover, drop,
// gap-fill, dedupe), the real Rest class with the REST budget, and the simulation's /token.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { SIM_TOPICS, buildTimeline, offsetOf, restQuery, shift, simNow } from "./simdata";
import { SimServer } from "./simserver";
import { LiveManager, canonical, hash53, type Batch } from "./src/live";
import { MqttSession, type MqttError } from "./src/mqtt";
import { requestToken } from "./src/openf1";
import { Budget } from "./src/budget";
import { Rest } from "./src/rest";
import { SimBroker, loadSimConfig, simNowOf } from "./src/sim";

const KEY = 4242;
const T = Date.parse("2025-06-01T12:00:00Z"); // session start; lights out at +220 s
const iso = (t: number) => new Date(t).toISOString().replace("Z", "000+00:00");

let repo: string;
let server: Server;
let sim: SimServer;
let base: string;

beforeAll(async () => {
  repo = mkdtempSync(join(tmpdir(), "vault-sim-"));
  const dir = join(repo, "data", "raw", String(KEY));
  mkdirSync(dir, { recursive: true });
  const put = (name: string, rows: unknown) => writeFileSync(join(dir, `${name}.json.gz`), gzipSync(JSON.stringify(rows)));
  put("sessions", [{ session_key: KEY, meeting_key: 1, date_start: iso(T), date_end: iso(T + 3600_000), session_name: "Race", circuit_short_name: "Test" }]);
  put("meeting", [{ meeting_key: 1, meeting_name: "Test GP", date_start: iso(T) }]);
  put("drivers", [1, 44].map((n) => ({ session_key: KEY, meeting_key: 1, driver_number: n, name_acronym: `D${n}` })));
  const lightsOut = T + 220_000;
  const laps = [];
  for (const n of [1, 44]) for (let lap = 1; lap <= 20; lap++) laps.push({ session_key: KEY, meeting_key: 1, driver_number: n, lap_number: lap, date_start: iso(lightsOut + (lap - 1) * 90_000 + n), duration_sector_1: 30, duration_sector_2: 30, duration_sector_3: 30, lap_duration: 90 });
  put("laps", laps);
  put("position", [1, 44].flatMap((n) => Array.from({ length: 200 }, (_, i) => ({ session_key: KEY, meeting_key: 1, driver_number: n, date: iso(lightsOut + i * 5000 + n), position: n === 1 ? 1 : 2 }))));
  for (const n of [1, 44]) put(`car_data_${n}`, Array.from({ length: 4 * 2400 }, (_, i) => ({ session_key: KEY, meeting_key: 1, driver_number: n, date: iso(T - 60_000 + i * 250 + n), speed: i % 300, rpm: 10000, n_gear: 7, throttle: 90, brake: 0, drs: 0 })));
  sim = new SimServer(repo, { sessionKey: KEY, speed: 20, startS: 0, tokenS: 60, dropEveryMin: 0, refuseAtMin: null, jitterMs: 5, keepaliveCheck: true, lock: false });
  server = createServer((req, res) => {
    if (!sim.handle(req, res)) (res.statusCode = 404), res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}/__sim`;
});

afterAll(() => {
  server?.close();
  rmSync(repo, { recursive: true, force: true });
});

describe("simdata", () => {
  test("the timeline: laps at start, after each sector and complete; telemetry from 10 min before the session", () => {
    const tl = buildTimeline(repo, KEY, 0);
    const laps = [...tl.byTopic.get("laps")!].map((i) => tl.recs[i]!);
    expect(laps.filter((l) => l.driver_number === 1 && l.lap_number === 3).map((l) => [l.duration_sector_1, l.duration_sector_2, l.lap_duration])).toEqual([
      [null, null, null],
      [30, null, null],
      [30, 30, null],
      [30, 30, 90],
    ]);
    // Telemetry stops at the end (5 min after the last lap); nothing is published after it.
    const cd = [...tl.byTopic.get("car_data")!];
    expect(cd.length).toBeLessThan(2 * 4 * 2400);
    expect(cd.every((i) => tl.at[i]! <= tl.endOrig)).toBe(true);
    expect(Math.max(...cd.map((i) => tl.at[i]!))).toBeGreaterThan(tl.endOrig - 1000);
    expect(tl.byTopic.get("sessions")!.length).toBe(1);
    // Emission order.
    for (let i = 1; i < tl.at.length; i++) expect(tl.at[i]! >= tl.at[i - 1]!).toBe(true);
  });

  test("REST as of a sim time: published rows only, each document's latest version, OpenF1's filters", () => {
    const tl = buildTimeline(repo, KEY, 0);
    const clock = { anchorWall: 1_000_000_000_000, startOrig: tl.startOrig, speed: 1 };
    const now = simNow(clock, clock.anchorWall + 100_000); // lap 2 is 10 s in (sector 1 not done)
    const laps = restQuery(tl, clock, "laps", "session_key=latest&driver_number=1", now)!;
    expect(laps.map((l) => [l.lap_number, l.lap_duration, l.duration_sector_1])).toEqual([
      [1, 90, 30],
      [2, null, null],
    ]);
    expect(laps.every((l) => !("_id" in l) && !("_key" in l))).toBe(true);
    const from = iso(now - 10_000);
    const cd = restQuery(tl, clock, "car_data", `session_key=${KEY}&date>=${encodeURIComponent(from)}`, now)!;
    expect(Math.abs(cd.length - 2 * 40)).toBeLessThanOrEqual(2); // 4 Hz x 2 drivers x 10 s (boundaries inclusive)
    expect(cd.every((r) => Date.parse(r.date) >= Date.parse(from) && Date.parse(r.date) <= now)).toBe(true);
    expect(restQuery(tl, clock, "nothing", "", now)).toBeNull();
    // Dates are on the sim clock and written OpenF1's way.
    expect(cd[0]!.date).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}\+00:00$/);
  });
});

describe("SimBroker + simserver: the vault's real stream code against the simulation", () => {
  test("stream, handover, a CONNACK 5 refusal, a forced drop with gap-fill: every message once", async () => {
    const cfg = await loadSimConfig(base);
    expect(cfg.topics).toEqual([...SIM_TOPICS]);
    const timers = { now: Date.now, setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms), clearTimeout: (h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>) };
    const broker = new SimBroker({ base, config: cfg, timers, fetch });
    const tok = await requestToken((url, init) => fetch(url.replace("https://api.openf1.org/token", `${base}/token`), init), "sim@example.com", "whatever", Date.now);
    if (!tok.ok) throw new Error("no token");
    let token = { accessToken: tok.token.accessToken, expiresAt: tok.token.expiresAt, username: "sim@example.com" };
    const budget = new Budget({ ...timers, random: Math.random, authenticated: () => true });
    const rest = new Rest((u, { timeoutMs, ...i }) => fetch(u, { ...i, signal: AbortSignal.timeout(timeoutMs) }), { current: () => token.accessToken, onUnauthorized: async () => "give_up" }, `${base}/v1/`, budget);
    const got: Batch[] = [];
    const live = new LiveManager({
      ...timers,
      random: Math.random,
      url: "wss://mqtt.openf1.org:8084/mqtt",
      socket: broker.socket,
      token: () => token,
      refresh: async () => false,
      rest: (e, p) => rest.get(e, p, { caller: "live", priority: "live", timeoutMs: 30_000 }),
      emit: (b) => got.push(...b),
      onStatus: () => {},
    });
    const t0 = Date.now();
    live.setTopics(["car_data", "position", "laps"]);
    live.start();
    const wait = async (pred: () => boolean, ms = 10_000) => {
      const end = Date.now() + ms;
      while (Date.now() < end && !pred()) await Bun.sleep(20);
      return pred();
    };
    expect(await wait(() => live.status().phase === "connected")).toBe(true);
    await Bun.sleep(700);
    // A handover (a new token), refused once with CONNACK 5 at the "cap": the old session stays.
    await fetch(`${base}/control/refuse?n=1`, { method: "POST" });
    const tok2 = await requestToken((url, init) => fetch(url.replace("https://api.openf1.org/token", `${base}/token`), init), "sim@example.com", "whatever", Date.now);
    if (!tok2.ok) throw new Error("no token");
    token = { ...token, accessToken: tok2.token.accessToken, expiresAt: tok2.token.expiresAt };
    live.onToken();
    expect(await wait(() => live.status().phase === "connection-limit")).toBe(true);
    expect(live.status().sessions).toBe(1);
    expect(await wait(() => live.status().handovers === 1 && live.status().phase === "connected", 15_000)).toBe(true);
    // A forced drop at the broker: reconnect, gap-fill.
    await fetch(`${base}/control/drop`, { method: "POST" });
    expect(await wait(() => live.status().reconnects === 1 && live.status().phase === "connected", 10_000)).toBe(true);
    await Bun.sleep(800);
    const t1 = Date.now();
    live.stop();
    const stats = await (await fetch(`${base}/stats`)).json();
    expect(stats.max).toBeLessThanOrEqual(2);
    expect(stats.rest429).toBe(0);
    expect(live.status().gapFilled).toBeGreaterThan(0);

    // Compare with the source: everything published between (start + 1 s sim) and (end - 1 s sim), once.
    const tl = buildTimeline(repo, KEY, 0);
    const off = offsetOf({ anchorWall: cfg.anchorWall, startOrig: tl.startOrig, speed: cfg.speed });
    const from = simNowOf(cfg, t0) + 2000;
    const to = simNowOf(cfg, t1) - 2000;
    const idOf = (m: Record<string, unknown>) => {
      const { _id, _key, ...rest } = m;
      return hash53(canonical(rest));
    };
    for (const topic of ["car_data", "position"] as const) {
      const want = [...tl.byTopic.get(topic)!].filter((i) => tl.at[i]! + off > from && tl.at[i]! + off <= to).map((i) => hash53(canonical(JSON.parse(JSON.stringify(shift(tl.recs[i]!, off))))));
      const mine = got.filter((b) => b.topic === topic).flatMap((b) => b.messages.map(idOf));
      expect(mine.length - new Set(mine).size).toBe(0);
      const have = new Set(mine);
      expect(want.filter((h) => !have.has(h))).toEqual([]);
      expect(want.length).toBeGreaterThan(10);
    }
  }, 30_000);

  test("the session table keeps a session whose CONNACK is slow (a sync mid-CONNECT doesn't forget it)", async () => {
    const cfg = await loadSimConfig(base);
    const timers = { now: Date.now, setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms), clearTimeout: (h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>) };
    // The dev server registers the session at once, but its answer reaches the frame after a sync has gone.
    const slow: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const r = await fetch(input, init);
      if (String(input).endsWith("/connect")) await Bun.sleep(1_500);
      return r;
    }) as typeof fetch;
    const broker = new SimBroker({ base, config: cfg, timers, fetch: slow });
    const tok = await requestToken((url, init) => fetch(url.replace("https://api.openf1.org/token", `${base}/token`), init), "sim@example.com", "whatever", Date.now);
    if (!tok.ok) throw new Error("no token");
    const token = { accessToken: tok.token.accessToken, expiresAt: tok.token.expiresAt, username: "sim@example.com" };
    const live = new LiveManager({ ...timers, random: Math.random, url: "wss://x/mqtt", socket: broker.socket, token: () => token, refresh: async () => false, rest: async () => ({ status: 404, body: new ArrayBuffer(0) }), emit: () => {}, onStatus: () => {} });
    live.setTopics(["car_data"]);
    live.start();
    const end = Date.now() + 10_000;
    while (Date.now() < end && live.status().phase !== "connected") await Bun.sleep(20);
    expect(live.status().phase).toBe("connected");
    await Bun.sleep(1_200); // another sync
    const mine = (await (await fetch(`${base}/stats`)).json()).sessions.filter((s: { instance: string }) => s.instance === broker.instance);
    live.stop();
    expect(mine.length).toBe(1);
  }, 20_000);

  test("a refusal reaches the client as CONNACK 5 before the close, whatever the delivery jitter", async () => {
    const cfg = { ...(await loadSimConfig(base)), jitterMs: 60 };
    const timers = { now: Date.now, setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms), clearTimeout: (h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>) };
    const broker = new SimBroker({ base, config: cfg, timers, fetch });
    const tok = await requestToken((url, init) => fetch(url.replace("https://api.openf1.org/token", `${base}/token`), init), "sim@example.com", "whatever", Date.now);
    if (!tok.ok) throw new Error("no token");
    const reasons: string[] = [];
    for (let i = 0; i < 8; i++) {
      await fetch(`${base}/control/refuse?n=1`, { method: "POST" });
      const session = new MqttSession({ url: "wss://x/mqtt", clientId: `refuse-${i}`, username: "sim@example.com", password: tok.token.accessToken, socket: broker.socket, timers, onMessage: () => {}, onClose: () => {} });
      const e = (await session.connect().then(() => null, (err) => err)) as MqttError | null;
      reasons.push(e?.info ? `${e.info.reason}${"code" in e.info ? ` ${e.info.code}` : ""}` : "connected");
      session.close();
    }
    expect(reasons).toEqual(Array(8).fill("refused 5"));
  }, 20_000);

  test("the simulation's /token and REST: fake JWTs with the configured lifetime; bad tokens get 401", async () => {
    const r = await fetch(`${base}/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "username=a%40b.c&password=x" });
    const j = await r.json();
    expect(j.access_token.startsWith("eyJhbGciOi")).toBe(true);
    expect(j.expires_in).toBe("60");
    expect((await fetch(`${base}/v1/sessions?session_key=latest`, { headers: { Authorization: `Bearer ${j.access_token}` } })).status).toBe(200);
    expect((await fetch(`${base}/v1/sessions`, { headers: { Authorization: `Bearer ${j.access_token}x` } })).status).toBe(401);
    expect((await fetch(`${base}/token`, { method: "POST", body: "username=nope&password=x" })).status).toBe(401);
  });
});

describe("simserver: OpenF1's lock during a session", () => {
  test("a browser's REST fails inside the session's window, server-side REST (the pass-through) doesn't; outside it both answer", async () => {
    // Its own simulation (the one above keeps its clock): from lights out, i.e. inside the window.
    const locked = new SimServer(repo, { sessionKey: KEY, speed: 1, startS: 0, tokenS: 3600, dropEveryMin: 0, refuseAtMin: null, jitterMs: 0, keepaliveCheck: true, lock: true });
    const srv = createServer((req, res) => {
      if (!locked.handle(req, res)) (res.statusCode = 404), res.end();
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const addr = srv.address();
    const at = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}/__sim`;
    try {
      const token = ((await (await fetch(`${at}/token`, { method: "POST", body: "username=a%40b.c&password=x" })).json()) as { access_token: string }).access_token;
      const auth = { Authorization: `Bearer ${token}` };
      const cfg = (await (await fetch(`${at}/config`)).json()) as { start: number; lock: { from: number; to: number } | null };
      const off = cfg.start - locked.timeline.startOrig;
      expect(cfg.lock).toEqual({ from: T + off - 30 * 60_000, to: T + 3600_000 + off + 30 * 60_000 });
      // A browser (Sec-Fetch-*): the connection drops.
      await expect(fetch(`${at}/v1/sessions?session_key=latest`, { headers: { ...auth, "Sec-Fetch-Mode": "cors" } })).rejects.toThrow();
      // The pass-through asks as a server does: answered.
      const viaProxy = await locked.fetchRest("http://vault/openf1/v1/sessions?session_key=latest", { headers: auth });
      expect(viaProxy.status).toBe(200);
      expect(((await viaProxy.json()) as { session_key: number }[])[0]!.session_key).toBe(KEY);
      // (A client may retry a dropped connection once.)
      expect(locked.stats.restLocked).toBeGreaterThanOrEqual(1);
      expect(locked.stats.restProxied).toBe(1);
      // Long after the end: no lock.
      locked.reset({ startS: 3 * 3600 });
      expect((await fetch(`${at}/v1/sessions?session_key=latest`, { headers: { ...auth, "Sec-Fetch-Mode": "cors" } })).status).toBe(200);
    } finally {
      srv.close();
    }
  });
});
