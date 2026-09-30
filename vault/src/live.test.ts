import { describe, expect, test } from "bun:test";
import { FakeClock, MemBroker, settle } from "../testkit";
import { FLUSH_MS, GAP_FILL, GAP_MARGIN_MS, LIMIT_BASE_MS, LiveManager, LiveState, OVERLAP_MS, SEEN_PER_TOPIC, byDate, canonical, gapParams, identity, isoDate, type Batch, type LiveToken } from "./live";
import type { LiveMessage, LiveTopic } from "./protocol";

function setup(opts: { token?: LiveToken | null; state?: LiveState } = {}) {
  const clock = new FakeClock();
  const broker = new MemBroker();
  let token: LiveToken | null = opts.token === undefined ? { accessToken: "tok-1", username: "me@example.com", expiresAt: clock.t + 3_600_000 } : opts.token;
  let refreshes = 0;
  let refreshTo: LiveToken | null = null;
  const got: Batch[] = [];
  const restCalls: [string, Record<string, string | number>][] = [];
  let statuses = 0;
  const live = new LiveManager(
    {
      now: clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      random: () => 0.5,
      url: "wss://broker/mqtt",
      socket: broker.socket,
      token: () => token,
      refresh: async () => {
        refreshes++;
        if (!refreshTo) return false;
        token = refreshTo;
        return true;
      },
      rest: async (endpoint, params) => {
        restCalls.push([endpoint, params]);
        return broker.rest(endpoint, params);
      },
      emit: (b) => got.push(...b),
      onStatus: () => statuses++,
    },
    opts.state,
  );
  let n = 0;
  /** Publish one message per topic with a unique n and the clock's date. */
  const pub = (topic: LiveTopic, extra: Record<string, unknown> = {}) => {
    n++;
    clock.t += 1; // distinct dates
    return broker.publish(topic, { session_key: 9999, date: isoDate(clock.t), n, ...extra });
  };
  const ns = (topic?: LiveTopic) => got.filter((b) => !topic || b.topic === topic).flatMap((b) => b.messages.map((m) => m.n as number));
  return {
    clock,
    broker,
    live,
    got,
    restCalls,
    pub,
    ns,
    refreshes: () => refreshes,
    setToken: (t: LiveToken | null) => (token = t),
    refreshGives: (t: LiveToken | null) => (refreshTo = t),
    statuses: () => statuses,
  };
}

async function streaming(topics: LiveTopic[] = ["car_data", "laps"]) {
  const x = setup();
  x.live.setTopics(topics);
  x.live.start();
  await x.clock.advance(10);
  expect(x.live.status().phase).toBe("connected");
  return x;
}

const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

describe("identity and dedupe", () => {
  test("canonical JSON ignores key order", () => {
    expect(canonical({ b: 1, a: { d: [1, { f: 2, e: 3 }], c: null } })).toBe(canonical({ a: { c: null, d: [1, { e: 3, f: 2 }] }, b: 1 }));
  });
  test("an MQTT message (with _id/_key) and the same REST row share a key", () => {
    const rest = { date: "2025-03-22T02:18:36.428000+00:00", driver_number: 1, speed: 300 };
    const mqtt = { speed: 300, _key: "k", driver_number: 1, _id: 42, date: "2025-03-22T02:18:36.428000+00:00" };
    const a = identity("car_data", rest);
    const b = identity("car_data", mqtt);
    expect(b).toContain(a[0]!);
    expect(b).toContain("car_data#42");
    const s = new LiveState();
    expect(s.accept("car_data", mqtt)).toBe(true);
    expect(s.accept("car_data", rest)).toBe(false);
    expect(s.accept("car_data", { ...mqtt })).toBe(false);
    expect(s.duplicates).toBe(2);
  });
  test("same _id, different topic: not a duplicate; same content, different date: not a duplicate", () => {
    const s = new LiveState();
    expect(s.accept("laps", { _id: 1, x: 1 })).toBe(true);
    expect(s.accept("pit", { _id: 1, x: 1 })).toBe(true);
    expect(s.accept("pit", { date: "2025-01-01T00:00:00+00:00", x: 1 })).toBe(true);
    expect(s.accept("pit", { date: "2025-01-01T00:00:01+00:00", x: 1 })).toBe(true);
  });
  test("a newer version of a document (same _key, new _id, new content) is delivered", () => {
    const s = new LiveState();
    expect(s.accept("laps", { _id: 1, _key: "44:3", lap_number: 3, duration_sector_1: 30 })).toBe(true);
    expect(s.accept("laps", { _id: 2, _key: "44:3", lap_number: 3, duration_sector_1: 30, duration_sector_2: 31 })).toBe(true);
  });
  test("memory is bounded per topic; a flood on one topic doesn't evict another's", () => {
    const s = new LiveState();
    s.accept("laps", { _id: "lap", lap_number: 1 });
    for (let i = 0; i < SEEN_PER_TOPIC; i++) s.accept("car_data", { _id: i, date: isoDate(i), speed: i });
    expect(s.size("car_data")).toBeLessThanOrEqual(SEEN_PER_TOPIC);
    expect(s.accept("laps", { lap_number: 1 })).toBe(false);
    // The oldest car_data keys are gone, the newest are still there.
    expect(s.accept("car_data", { _id: SEEN_PER_TOPIC - 1, date: isoDate(SEEN_PER_TOPIC - 1), speed: SEEN_PER_TOPIC - 1 })).toBe(false);
    expect(s.accept("car_data", { _id: 0, date: isoDate(0), speed: 0 })).toBe(true);
  });
  test("lastSeen is the latest date (an older straggler doesn't lower it); sessionKey is tracked", () => {
    const s = new LiveState();
    s.accept("position", { date: "2025-03-22T02:00:02.000000+00:00", session_key: 9, n: 1 });
    s.accept("position", { date: "2025-03-22T02:00:01.000000+00:00", session_key: 9, n: 2 });
    expect(s.lastSeen.position).toBe("2025-03-22T02:00:02.000000+00:00");
    expect(s.sessionKey).toBe(9);
  });
  test("snapshot / merge carries the seen keys, lastSeen and since to another frame", () => {
    const a = new LiveState();
    a.accept("position", { date: "2025-03-22T02:00:02.000000+00:00", n: 1, _id: 5 });
    a.since.position = 123;
    const b = new LiveState();
    b.merge(structuredClone(a.snapshot()));
    expect(b.accept("position", { date: "2025-03-22T02:00:02.000000+00:00", n: 1 })).toBe(false);
    expect(b.lastSeen.position).toBe("2025-03-22T02:00:02.000000+00:00");
    expect(b.since.position).toBe(123);
  });
  test("byDate is stable and puts undated first", () => {
    const m = (n: number, date?: string): LiveMessage => ({ n, ...(date && { date }) });
    expect(byDate([m(1, isoDate(3)), m(2), m(3, isoDate(1)), m(4, isoDate(1))]).map((x) => x.n)).toEqual([2, 3, 4, 1]);
  });
});

describe("LiveManager", () => {
  test("connects with a fresh clientId, the token as password, subscribes v1/<topic>, delivers in batches", async () => {
    const x = await streaming(["car_data", "laps"]);
    const c = x.broker.clients[0]!;
    expect(c.clientId).toMatch(/^f1-vault-[a-z0-9]{16}$/);
    expect(c.password).toBe("tok-1");
    expect(c.username).toBe("me@example.com"); // OpenF1 refuses any other username (CONNACK 5)
    expect([...c.subs].sort()).toEqual(["v1/car_data", "v1/laps"]);
    x.pub("car_data");
    x.pub("laps");
    x.pub("car_data");
    await settle();
    expect(x.got).toEqual([]); // batched
    await x.clock.advance(FLUSH_MS);
    expect(x.ns("car_data")).toEqual([1, 3]);
    expect(x.ns("laps")).toEqual([2]);
    expect(x.got.every((b) => b.messages.every((m) => typeof m._id === "number"))).toBe(true);
    const st = x.live.status();
    expect(st).toMatchObject({ phase: "connected", sessions: 1, maxSessions: 1, delivered: 3, duplicates: 0 });
    expect(st.lastSeen.car_data).toBe(x.got[0]!.messages[1]!.date as string);
  });

  test("messages on topics nobody subscribed to, and non-JSON payloads, are dropped", async () => {
    const x = await streaming(["car_data"]);
    x.broker.clients[0]!.subs.add("v1/weather");
    x.pub("weather");
    await x.clock.advance(FLUSH_MS);
    expect(x.got).toEqual([]);
  });

  test("no token: waiting, no socket, no refresh polling; onToken() connects", async () => {
    const x = setup({ token: null });
    x.live.setTopics(["laps"]);
    x.live.start();
    await x.clock.advance(60_000);
    expect(x.live.status().phase).toBe("waiting");
    expect(x.broker.clients.length).toBe(0);
    expect(x.refreshes()).toBe(0);
    x.setToken({ accessToken: "t", username: "me@example.com", expiresAt: x.clock.t + 1e6 });
    x.live.onToken();
    await x.clock.advance(10);
    expect(x.live.status().phase).toBe("connected");
  });

  test("an expired token: refresh first, then connect with the new one", async () => {
    const x = setup();
    x.setToken({ accessToken: "old", username: "me@example.com", expiresAt: x.clock.t - 1 });
    x.refreshGives({ accessToken: "new", username: "me@example.com", expiresAt: x.clock.t + 1e6 });
    x.live.setTopics(["laps"]);
    x.live.start();
    await x.clock.advance(10);
    expect(x.refreshes()).toBe(1);
    expect(x.broker.clients.map((c) => c.password)).toEqual(["new"]);
  });

  test("handover on a new token: B subscribes, A closes after the overlap; no loss, no duplicates, 2 sessions at most", async () => {
    const x = await streaming(["car_data"]);
    for (let i = 0; i < 5; i++) x.pub("car_data");
    await settle();
    x.setToken({ accessToken: "tok-2", username: "me@example.com", expiresAt: x.clock.t + 3_600_000 });
    x.live.onToken();
    // Publish while B connects and subscribes: some reach only A, some both.
    for (let i = 0; i < 10; i++) {
      x.pub("car_data");
      await Promise.resolve();
    }
    await settle();
    expect(x.live.status().phase).toBe("handover");
    expect(x.broker.current).toBe(2);
    for (let i = 0; i < 5; i++) x.pub("car_data");
    await x.clock.advance(OVERLAP_MS);
    expect(x.broker.current).toBe(1);
    expect(x.broker.clients.filter((c) => !c.sock.closed).map((c) => c.password)).toEqual(["tok-2"]);
    for (let i = 0; i < 5; i++) x.pub("car_data");
    await x.clock.advance(FLUSH_MS);
    expect(x.ns()).toEqual(range(1, 25));
    const st = x.live.status();
    expect(st).toMatchObject({ phase: "connected", handovers: 1, maxSessions: 2, sessions: 1 });
    expect(st.duplicates).toBeGreaterThan(0);
    expect(x.broker.max).toBe(2);
    expect(new Set(x.broker.clients.map((c) => c.clientId)).size).toBe(2);
  });

  test("a message still in flight on A when B's SUBACK lands is not lost (the overlap)", async () => {
    const x = await streaming(["car_data"]);
    x.setToken({ accessToken: "tok-2", username: "me@example.com", expiresAt: x.clock.t + 3_600_000 });
    x.live.onToken();
    // Wait until B has subscribed, then publish only to A (as if it had been published a moment earlier).
    for (let i = 0; i < 50 && x.broker.clients.length < 2; i++) await Promise.resolve();
    await settle();
    const a = x.broker.clients[0]!;
    const b = x.broker.clients[1]!;
    b.subs.delete("v1/car_data");
    x.pub("car_data");
    b.subs.add("v1/car_data");
    await x.clock.advance(OVERLAP_MS + FLUSH_MS);
    expect(a.sock.closed).not.toBeNull();
    expect(x.ns()).toEqual([1]);
  });

  test("CONNACK 5 with a valid token = the connection cap: keep A and the token, back off, then hand over", async () => {
    const x = await streaming(["car_data"]);
    x.broker.refuseNext = 1;
    x.setToken({ accessToken: "tok-2", username: "me@example.com", expiresAt: x.clock.t + 3_600_000 });
    x.live.onToken();
    await settle();
    let st = x.live.status();
    expect(st.phase).toBe("connection-limit");
    expect(st.lastError).toBe("refused: CONNACK 5 (not authorized)");
    expect(st.retryAt).toBe(x.clock.t + LIMIT_BASE_MS);
    expect(x.refreshes()).toBe(0);
    // A still streams.
    x.pub("car_data");
    await x.clock.advance(FLUSH_MS);
    expect(x.ns()).toEqual([1]);
    expect(x.broker.current).toBe(1);
    await x.clock.advance(LIMIT_BASE_MS);
    await x.clock.advance(OVERLAP_MS);
    st = x.live.status();
    expect(st).toMatchObject({ phase: "connected", handovers: 1, sessions: 1, maxSessions: 2 });
    expect(x.broker.refused).toBe(1);
  });

  test("CONNACK 5 at the cap with no session at all: connection-limit, retried with growing backoff", async () => {
    const x = setup();
    x.broker.refuseNext = 2;
    x.live.setTopics(["laps"]);
    x.live.start();
    await x.clock.advance(10);
    expect(x.live.status().phase).toBe("connection-limit");
    await x.clock.advance(LIMIT_BASE_MS);
    expect(x.live.status().phase).toBe("connection-limit");
    expect(x.broker.refused).toBe(2);
    await x.clock.advance(LIMIT_BASE_MS * 2);
    expect(x.live.status().phase).toBe("connected");
    expect(x.refreshes()).toBe(0);
  });

  test("CONNACK 5 with an expired token = refresh first, then retry", async () => {
    const x = await streaming(["laps"]);
    // The token runs out; the broker refuses it on the reconnect after a drop.
    x.clock.t += 3_600_001;
    x.broker.refusePasswords.add("tok-1");
    x.refreshGives({ accessToken: "tok-2", username: "me@example.com", expiresAt: x.clock.t + 3_600_000 });
    x.broker.dropAll();
    await x.clock.advance(1_000);
    expect(x.refreshes()).toBe(1);
    expect(x.live.status().phase).toBe("connected");
    expect(x.broker.clients.at(-1)!.password).toBe("tok-2");
  });

  test("a drop: reconnect with backoff, gap-fill over REST (date>=lastSeen - overlap, or whole), in order, before live resumes; no loss, no duplicates", async () => {
    const x = await streaming(["car_data", "position", "laps"]);
    for (let i = 0; i < 6; i++) x.pub(i % 2 ? "position" : "car_data");
    await x.clock.advance(FLUSH_MS);
    const lastCar = x.live.status().lastSeen.car_data!;
    x.broker.dropAll();
    await settle();
    expect(x.live.status().phase).toBe("reconnecting");
    // Published while nobody is connected: only REST has them.
    for (let i = 0; i < 6; i++) x.pub(i % 2 ? "position" : "car_data");
    x.pub("laps", { date: undefined, lap_number: 1 });
    await x.clock.advance(600);
    expect(x.live.status().reconnects).toBe(1);
    await x.clock.advance(FLUSH_MS);
    for (let i = 0; i < 4; i++) x.pub("car_data");
    await x.clock.advance(FLUSH_MS);
    const car = x.restCalls.find(([e]) => e === "car_data")!;
    expect(car[1]).toEqual({ session_key: 9999, "date>=": isoDate(Date.parse(lastCar) - (GAP_FILL.car_data as number)) });
    expect(x.restCalls.find(([e]) => e === "position")![1]).toEqual({ session_key: 9999 });
    expect(x.restCalls.find(([e]) => e === "laps")![1]).toEqual({ session_key: 9999 });
    expect([...x.ns()].sort((a, b) => a - b)).toEqual(range(1, 17));
    // Each topic in order (gap-filled before live).
    for (const t of ["car_data", "position"] as const) {
      const seq = x.ns(t);
      expect(seq).toEqual([...seq].sort((a, b) => a - b));
    }
    const st = x.live.status();
    expect(st.phase).toBe("connected");
    expect(st.gapFilled).toBe(7);
    expect(st.duplicates).toBeGreaterThanOrEqual(6); // the overlap: every car_data and position row delivered before the drop
    expect(x.broker.max).toBe(1);
  });

  test("a record published during the outage but dated before lastSeen (a pit stop, a lagging driver) is gap-filled", async () => {
    const x = await streaming(["pit", "car_data", "location"]);
    // Pit stops: A enters the pit lane first and is published last (a slow stop); B, dated later, is out first.
    const entryA = x.clock.t + 1;
    x.clock.t = entryA + 5_000;
    x.pub("pit", { date: isoDate(x.clock.t), driver_number: 44, lane_duration: 20 }); // B, delivered live
    // Telemetry: driver 1 is up to date, driver 81's samples lag 5 s behind at the broker.
    x.pub("car_data", { driver_number: 1 });
    x.pub("location", { driver_number: 1 });
    await x.clock.advance(FLUSH_MS);
    const seen = x.live.status().lastSeen;
    expect(Date.parse(seen.pit!)).toBe(entryA + 5_000);
    x.broker.dropAll();
    await settle();
    // During the outage: A, dated before lastSeen (pit); driver 81's lagging samples, dated before lastSeen (telemetry).
    const lateA = x.pub("pit", { date: isoDate(entryA), driver_number: 1, lane_duration: 40 }) as { n?: number };
    const late81 = x.pub("car_data", { driver_number: 81, date: isoDate(Date.parse(seen.car_data!) - 5_000) }) as { n?: number };
    const late81loc = x.pub("location", { driver_number: 81, date: isoDate(Date.parse(seen.location!) - 5_000) }) as { n?: number };
    await x.clock.advance(1_000);
    expect(x.live.status().phase).toBe("connected");
    expect(x.restCalls.find(([e]) => e === "pit")![1]).toEqual({ session_key: 9999 }); // whole: no date filter
    expect(x.ns("pit")).toEqual([1, lateA.n as number]);
    expect(x.ns("car_data")).toEqual([late81.n as number, 2].sort((a, b) => a - b));
    expect(x.ns("location")).toContain(late81loc.n as number);
    // Nothing twice: the whole refetch's pit B and the overlap's rows were dropped as duplicates.
    const all = x.ns();
    expect(new Set(all).size).toBe(all.length);
    expect(x.live.status().gapFilled).toBe(3);
  });

  test("gapParams: whole or lastSeen - overlap; a topic that never delivered anything starts from `since` minus the larger margin", () => {
    const at = Date.parse("2026-09-30T12:00:00.000Z");
    const lastSeen = { car_data: isoDate(at), intervals: isoDate(at), pit: isoDate(at) };
    const since = { car_data: at - 600_000, location: at - 600_000, weather: at - 600_000 };
    expect(gapParams("car_data", 9, { lastSeen, since })).toEqual({ session_key: 9, "date>=": isoDate(at - 30_000) });
    expect(gapParams("intervals", 9, { lastSeen, since })).toEqual({ session_key: 9, "date>=": isoDate(at - 60_000) });
    expect(gapParams("location", "latest", { lastSeen, since })).toEqual({ session_key: "latest", "date>=": isoDate(at - 600_000 - Math.max(30_000, GAP_MARGIN_MS)) });
    expect(gapParams("pit", 9, { lastSeen, since })).toEqual({ session_key: 9 });
    expect(gapParams("weather", 9, { lastSeen, since })).toEqual({ session_key: 9 });
    expect(gapParams("race_control", 9, { lastSeen, since })).toBeNull(); // never streamed
    // Every overlap stays well inside the dedupe window (~2 min of car_data at 22 cars x 3.7 Hz x 2 keys).
    for (const v of Object.values(GAP_FILL)) if (typeof v === "number") expect(v).toBeLessThan((SEEN_PER_TOPIC / (22 * 3.7 * 2)) * 1000 * 0.5);
  });

  test("live messages that arrive during the gap-fill are held back and follow it", async () => {
    const x = await streaming(["car_data"]);
    x.pub("car_data");
    await x.clock.advance(FLUSH_MS);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const orig = x.broker.rest;
    x.broker.rest = async (e, p) => {
      await gate;
      return orig(e, p);
    };
    x.broker.dropAll();
    x.pub("car_data"); // missed: REST only
    await x.clock.advance(600);
    expect(x.live.status().phase).toBe("gap-filling");
    x.pub("car_data"); // live, during the gap-fill
    await x.clock.advance(FLUSH_MS);
    expect(x.ns()).toEqual([1]);
    release();
    await x.clock.advance(FLUSH_MS);
    expect(x.ns()).toEqual([1, 2, 3]);
  });

  test("a topic with nothing delivered yet is gap-filled from when it started streaming (minus a margin), or whole", async () => {
    const x = await streaming(["car_data", "race_control"]);
    const since = x.live.status().since.car_data!;
    x.broker.dropAll();
    x.pub("car_data");
    x.pub("race_control");
    await x.clock.advance(1_000);
    expect(x.restCalls).toEqual([
      ["car_data", { session_key: "latest", "date>=": isoDate(since - 30_000) }],
      ["race_control", { session_key: "latest" }],
    ]);
    expect(x.ns()).toEqual([1, 2]);
  });

  test("a failed gap-fill is retried, then reported (the stream carries on)", async () => {
    const x = await streaming(["car_data"]);
    x.pub("car_data");
    await x.clock.advance(FLUSH_MS);
    x.broker.rest = async () => ({ status: 503, body: new ArrayBuffer(0) });
    x.broker.dropAll();
    await x.clock.advance(10_000);
    const st = x.live.status();
    expect(st.phase).toBe("connected");
    expect(st.lastError).toBe("gap-fill failed for car_data");
  });

  test("subscriptions change on the open session: SUBSCRIBE the new, UNSUBSCRIBE the old, forget its state", async () => {
    const x = await streaming(["car_data"]);
    x.pub("car_data");
    await x.clock.advance(FLUSH_MS);
    x.live.setTopics(["laps"]);
    await settle();
    expect([...x.broker.clients[0]!.subs]).toEqual(["v1/laps"]);
    expect(x.live.status().lastSeen.car_data).toBeUndefined();
    expect(x.live.status().topics).toEqual(["laps"]);
    x.live.setTopics([]);
    await settle();
    expect(x.live.status()).toMatchObject({ phase: "off", sessions: 0 });
    x.live.setTopics(["pit"]);
    await x.clock.advance(10);
    expect(x.live.status().phase).toBe("connected");
  });

  test("taking over another frame's stream: gap-fill from its lastSeen on the first connect", async () => {
    const state = new LiveState();
    const x = setup({ state });
    x.pub("position");
    x.pub("position");
    // The old leader delivered n=1 only, then died.
    state.merge({ lastSeen: { position: isoDate(x.clock.t - 1) }, since: { position: x.clock.t - 1000 }, sessionKey: 9999, seen: {} });
    state.accept("position", { ...x.broker.records.get("position")![0]! });
    x.live.setTopics(["position"]);
    x.live.start({ gap: true });
    await x.clock.advance(FLUSH_MS + 10);
    expect(x.ns()).toEqual([2]);
    expect(x.live.status().gapFilled).toBe(1);
  });

  test("stop(): every session closes; reset forgets what was delivered", async () => {
    const x = await streaming(["car_data"]);
    x.pub("car_data");
    await x.clock.advance(FLUSH_MS);
    x.live.stop({ reset: true });
    await settle();
    expect(x.broker.current).toBe(0);
    expect(x.live.status()).toMatchObject({ phase: "waiting", sessions: 0 });
    expect(x.live.status().lastSeen).toEqual({});
  });

  test("never more than 2 sessions, even when tokens arrive faster than handovers finish", async () => {
    const x = await streaming(["car_data"]);
    for (let i = 2; i < 8; i++) {
      x.setToken({ accessToken: `tok-${i}`, username: "me@example.com", expiresAt: x.clock.t + 3_600_000 });
      x.live.onToken();
      x.pub("car_data");
      await settle(1);
      await x.clock.advance(300);
    }
    await x.clock.advance(10_000);
    x.pub("car_data");
    await x.clock.advance(FLUSH_MS);
    expect(x.broker.max).toBeLessThanOrEqual(2);
    expect(x.ns()).toEqual(range(1, 7));
  });
});
