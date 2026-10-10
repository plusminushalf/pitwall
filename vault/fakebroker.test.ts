// The fake broker against the vault's real MQTT client and live manager, over real WebSockets (Bun's).

import { afterAll, describe, expect, test } from "bun:test";
import { FakeBroker, openf1Date } from "./fakebroker";
import { LiveManager, OVERLAP_MS, type Batch } from "./src/live";
import { type MqttError, MqttSession, type CloseInfo, type SocketLike } from "./src/mqtt";
import { restUrl } from "./src/rest";
import type { Timers } from "./src/scheduler";

const broker = new FakeBroker();
afterAll(() => broker.stop());

const timers: Timers = { now: Date.now, setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) };
const socket = (url: string, protocols: string[]) => new WebSocket(url, protocols) as unknown as SocketLike;
const until = async (f: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!f()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await Bun.sleep(10);
  }
};

function session(clientId: string, password = "token") {
  const messages: [string, unknown][] = [];
  const closes: CloseInfo[] = [];
  const s = new MqttSession({
    url: `ws://127.0.0.1:${broker.port}/mqtt`,
    clientId,
    username: "u@example.com",
    password,
    socket,
    timers,
    onMessage: (t, p) => messages.push([t, JSON.parse(new TextDecoder().decode(p))]),
    onClose: (i) => closes.push(i),
  });
  return { s, messages, closes };
}

describe("fake broker <-> MqttSession over WebSocket", () => {
  test("connect, subscribe, receive what's published; the session count", async () => {
    const a = session("a1");
    await a.s.connect();
    expect(await a.s.subscribe(["v1/laps"])).toEqual([0]);
    expect(broker.stats.current).toBe(1);
    broker.publish("laps", { n: 1, lap_number: 1 });
    broker.publish("pit", { n: 2 });
    await until(() => a.messages.length === 1);
    expect(a.messages[0]).toEqual(["v1/laps", { n: 1, lap_number: 1, _id: expect.any(Number) }]);
    a.s.close();
    await until(() => broker.stats.current === 0);
  });

  test("refuse: CONNACK 5", async () => {
    broker.refuse(1);
    const e = await session("r1").s.connect().catch((e) => e);
    expect((e as MqttError).info).toEqual({ reason: "refused", code: 5 });
    expect(broker.stats.refused).toBeGreaterThanOrEqual(1);
  });

  test("drop: the client sees the connection close", async () => {
    const a = session("d1");
    await a.s.connect();
    expect(broker.drop("all")).toBe(1);
    await until(() => a.closes.length === 1);
    expect(a.closes[0]!.reason).toBe("closed");
  });

  test("a reused clientId kicks the older session", async () => {
    const a = session("same");
    await a.s.connect();
    const b = session("same");
    await b.s.connect();
    await until(() => a.closes.length === 1);
    expect(b.s.open).toBe(true);
    b.s.close();
  });

  test("REST: the vault's own URLs (date>= encoded) filter what was published, without _id", async () => {
    const t0 = Date.now() + 1_000_000;
    broker.publish("weather", { date: openf1Date(t0), n: 10 });
    broker.publish("weather", { date: openf1Date(t0 + 1), n: 11 });
    broker.publish("weather", { date: openf1Date(t0 + 2), n: 12 });
    const url = restUrl("weather", { session_key: "latest", "date>=": openf1Date(t0 + 1) }, `${broker.origin}/v1/`);
    const res = await fetch(url, { headers: { Authorization: "Bearer x" } });
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(await res.json()).toEqual([
      { date: openf1Date(t0 + 1), n: 11 },
      { date: openf1Date(t0 + 2), n: 12 },
    ]);
    const pre = await fetch(url, { method: "OPTIONS" });
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-headers")).toContain("authorization");
  });

  test("LiveManager end to end: handover and a drop + gap-fill, nothing lost, nothing twice", async () => {
    broker.resetStats();
    const got: Batch[] = [];
    let token = { accessToken: "t1", username: "me@example.com", expiresAt: Date.now() + 3_600_000 };
    const live = new LiveManager({
      ...timers,
      random: Math.random,
      url: `ws://127.0.0.1:${broker.port}/mqtt`,
      socket,
      token: () => token,
      refresh: async () => false,
      rest: async (endpoint, params) => {
        const r = await fetch(restUrl(endpoint, params, `${broker.origin}/v1/`));
        return { status: r.status, body: await r.arrayBuffer() };
      },
      emit: (b) => got.push(...b),
      onStatus: () => {},
    });
    live.setTopics(["car_data", "position"]);
    live.start();
    await until(() => live.status().phase === "connected");
    const first = broker.log.length;
    broker.startStream(100, ["car_data", "position"]);
    await Bun.sleep(300);
    token = { accessToken: "t2", username: "me@example.com", expiresAt: Date.now() + 3_600_000 };
    live.onToken();
    await until(() => live.status().handovers === 1);
    await Bun.sleep(OVERLAP_MS + 300);
    expect(broker.stats.max).toBeLessThanOrEqual(2);
    broker.drop("all");
    await until(() => live.status().reconnects === 1);
    await until(() => live.status().phase === "connected", 5000);
    await Bun.sleep(300);
    broker.stopStream();
    await Bun.sleep(400);
    const want = broker.log.slice(first).map((x) => x.msg.n as number);
    const ns = got.flatMap((b) => b.messages.map((m) => m.n as number));
    expect(ns.length).toBe(new Set(ns).size);
    expect([...ns].sort((a, b) => a - b)).toEqual(want);
    const st = live.status();
    expect(st.maxSessions).toBeLessThanOrEqual(2);
    expect(st.duplicates).toBeGreaterThan(0);
    live.stop();
  });
});
