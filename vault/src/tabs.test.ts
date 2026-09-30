import { describe, expect, test } from "bun:test";
import { FakeClock, MemBroker, settle } from "../testkit";
import { VaultCore } from "./core";
import { FLUSH_MS, LiveManager, isoDate, type Batch } from "./live";
import type { Fetch } from "./openf1";
import type { LiveTopic, PopupMessage, VaultStatus } from "./protocol";
import { MemoryStore } from "./storage";
import { FRAME_LOCK, LEADER_LOCK, PROVISIONAL_MS, VaultNode, type ChannelLike, type LocksLike } from "./tabs";

const USER = "someone@example.com";
const PASS = "correct horse battery staple";
const T = "ticket_ticket_ticket_01";

/** BroadcastChannel: every other channel on the bus gets a structured clone, asynchronously. */
class Bus {
  channels = new Set<ChannelLike & { dead?: boolean }>();
  make(): ChannelLike & { dead?: boolean } {
    const ch: ChannelLike & { dead?: boolean } = {
      onmessage: null,
      postMessage: (m) => {
        if (ch.dead) return;
        const copy = structuredClone(m);
        for (const o of this.channels) if (o !== ch && !o.dead) setImmediate(() => !o.dead && o.onmessage?.({ data: copy }));
      },
    };
    this.channels.add(ch);
    return ch;
  }
}

/** Web Locks for several frames: exclusive, FIFO; a dead frame's locks and queued requests go away. */
class Locks {
  held = new Map<string, string>();
  queue = new Map<string, { owner: string; grant: () => void }[]>();
  forFrame(owner: string): LocksLike {
    return {
      request: (name, opts, cb) => {
        if (!this.held.has(name)) {
          this.held.set(name, owner);
          cb({ name });
          return Promise.resolve();
        }
        if (opts.ifAvailable) {
          cb(null);
          return Promise.resolve();
        }
        const q = this.queue.get(name) ?? [];
        q.push({ owner, grant: () => cb({ name }) });
        this.queue.set(name, q);
        return Promise.resolve();
      },
      query: async () => ({ held: [...this.held.keys()].map((name) => ({ name })) }),
    };
  }
  kill(owner: string) {
    for (const q of this.queue.values()) for (let i = q.length - 1; i >= 0; i--) if (q[i]!.owner === owner) q.splice(i, 1);
    for (const [name, o] of [...this.held]) {
      if (o !== owner) continue;
      this.held.delete(name);
      const next = this.queue.get(name)?.shift();
      if (next) {
        this.held.set(name, next.owner);
        next.grant();
      }
    }
  }
}

function world() {
  const clock = new FakeClock();
  const bus = new Bus();
  const locks = new Locks();
  const store = new MemoryStore(); // one partition: every frame sees the same IndexedDB
  const broker = new MemBroker();
  let tokens = 0;
  const fetch: Fetch = async () => {
    tokens++;
    return { status: 200, text: async () => JSON.stringify({ access_token: `eyJhbGciOiJIUzI1NiJ9.tok${tokens}.sig`, token_type: "bearer", expires_in: "3600" }) };
  };
  let seq = 0;
  function frame() {
    const id = `frame${++seq}`;
    const statuses: VaultStatus[] = [];
    const got: Batch[] = [];
    const gets: string[] = [];
    let node: VaultNode | null = null;
    let live: LiveManager | null = null;
    const channel = bus.make();
    const core = new VaultCore({
      store,
      fetch,
      now: clock.now,
      version: "test",
      onStatus: () => node?.onCoreStatus(),
      announceWipe: () => node?.announceWipe(),
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      random: () => 0.5,
      leading: () => node?.role === "leader",
      onShared: (s) => node?.onShared(s),
      onToken: () => live?.onToken(),
    });
    const rest = {
      get: async (endpoint: string, params: Record<string, string | number>) => {
        gets.push(`${id}:${endpoint}`);
        const r = await broker.rest(endpoint, params);
        return { ...r, auth: core.token() !== null };
      },
    };
    live = new LiveManager({
      now: clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      random: () => 0.5,
      url: "wss://broker/mqtt",
      socket: broker.socket,
      token: () => core.liveToken(),
      refresh: () => core.scheduler.refresh(),
      rest: (e, p) => rest.get(e, p),
      emit: (b) => node?.onLiveData(b),
      onStatus: () => node?.pushStatus(),
    });
    node = new VaultNode({
      id,
      core,
      live,
      rest: rest as never,
      channel,
      locks: locks.forFrame(id),
      timers: clock,
      version: "test",
      onStatus: (s) => statuses.push(s),
      deliver: (b) => got.push(...b),
    });
    const f = {
      id,
      core,
      node,
      live,
      statuses,
      got,
      gets,
      status: () => node!.status(),
      ns: () => got.flatMap((b) => b.messages.map((m) => m.n as number)),
      /** The tab closes. */
      kill: () => {
        channel.dead = true;
        live!.stop();
        locks.kill(id);
      },
      /** A popup login completing in this frame. */
      login: async () => {
        expect(core.expect("connect", T).ok).toBe(true);
        const popup = {};
        const send = (m: Record<string, unknown>) => core.popup({ v: 1, ticket: T, ...m } as PopupMessage, popup);
        await send({ type: "popup:hello" });
        return send({ type: "popup:login", username: USER, password: PASS, mode: "device" });
      },
    };
    return f;
  }
  let n = 0;
  const pub = (topic: LiveTopic) => {
    clock.t += 1;
    return broker.publish(topic, { session_key: 9999, date: isoDate(clock.t), n: ++n });
  };
  const run = async (ms = 0) => {
    await settle(10);
    await clock.advance(ms);
    await settle(10);
  };
  return { clock, bus, locks, store, broker, frame, pub, run, tokens: () => tokens, published: () => n };
}

const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

describe("VaultNode: one leader among the vault frames", () => {
  test("the first frame leads; the next follows and mirrors the leader's status", async () => {
    const w = world();
    const a = w.frame();
    await a.node.start();
    await w.run();
    const b = w.frame();
    await b.node.start();
    await w.run();
    expect(a.status().tab).toMatchObject({ role: "leader", id: "frame1", leader: "frame1" });
    expect(b.status().tab).toEqual({ role: "follower", id: "frame2", leader: "frame1" });
    expect(b.status().state).toBe("disconnected");
    expect(w.locks.held.get(LEADER_LOCK)).toBe("frame1");
    expect(w.locks.held.has(FRAME_LOCK + "frame2")).toBe(true);
  });

  test("a login in a follower's popup reaches every frame; one /token call; the leader refreshes", async () => {
    const w = world();
    const a = w.frame();
    await a.node.start();
    const b = w.frame();
    await b.node.start();
    const c = w.frame();
    await c.node.start();
    await w.run();
    const r = await b.login();
    expect(r).toMatchObject({ ok: true, next: "done" });
    await w.run();
    for (const f of [a, b, c]) expect(f.status()).toMatchObject({ state: "connected", mode: "device", account: "s***@example.com" });
    expect(w.tokens()).toBe(1);
    expect(a.status().refresh).toBe("scheduled");
    expect(a.core.scheduler.running).toBe(true);
    expect(b.core.scheduler.running).toBe(false);
    // The leader refreshes (50 min); the followers get the new token, and call /token themselves never.
    await w.run(50 * 60_000 + 1000);
    expect(w.tokens()).toBe(2);
    expect(a.status().refreshCount).toBe(1);
    expect(c.status().refreshCount).toBe(1);
  });

  test("a frame that joins later gets the login without /token", async () => {
    const w = world();
    const a = w.frame();
    await a.node.start();
    await w.run();
    await a.login();
    await w.run();
    const b = w.frame();
    await b.node.start();
    await w.run();
    expect(b.status().state).toBe("connected");
    expect(w.tokens()).toBe(1);
  });

  test("disconnect in a follower wipes storage and every frame", async () => {
    const w = world();
    const a = w.frame();
    await a.node.start();
    const b = w.frame();
    await b.node.start();
    await w.run();
    await a.login();
    await w.run();
    const s = await b.node.disconnect();
    expect(s.state).toBe("disconnected");
    await w.run();
    expect(a.status().state).toBe("disconnected");
    expect(a.core.scheduler.running).toBe(false);
    expect(w.store.value).toBeNull();
    expect(a.core.sharedLogin()).toBeNull();
  });

  test("a follower's get goes through the leader (its REST budget)", async () => {
    const w = world();
    const a = w.frame();
    await a.node.start();
    const b = w.frame();
    await b.node.start();
    await w.run();
    const p = b.node.get("sessions", { session_key: "latest" });
    await w.run();
    expect((await p).status).toBe(200);
    expect(a.gets).toEqual(["frame1:sessions"]);
    expect(b.gets).toEqual([]);
  });

  test("subscriptions are the union across frames; the data reaches each frame", async () => {
    const w = world();
    const a = w.frame();
    await a.node.start();
    const b = w.frame();
    await b.node.start();
    await w.run();
    await a.login();
    a.node.setTopics(["car_data"]);
    b.node.setTopics(["position"]);
    await w.run(10);
    expect(a.live.status().topics).toEqual(["car_data", "position"]);
    expect(w.broker.current).toBe(1);
    w.pub("car_data");
    w.pub("position");
    await w.run(FLUSH_MS);
    // Each frame's rpc.deliver filters per port; here both frames get the whole batch.
    expect(a.ns()).toEqual([1, 2]);
    expect(b.ns()).toEqual([1, 2]);
    expect(b.status().stream).toMatchObject({ phase: "connected", sessions: 1 });
  });

  test("the leader's tab closes: the next frame takes over the login (no /token) and the stream (no gap)", async () => {
    const w = world();
    const a = w.frame();
    await a.node.start();
    const b = w.frame();
    await b.node.start();
    const c = w.frame();
    await c.node.start();
    await w.run();
    await a.login();
    b.node.setTopics(["car_data"]);
    c.node.setTopics(["car_data", "position"]);
    await w.run(10);
    for (let i = 0; i < 6; i++) w.pub(i % 2 ? "position" : "car_data");
    await w.run(FLUSH_MS);
    expect([...b.ns()].sort((x, y) => x - y)).toEqual(range(1, 6));
    // Messages the leader got but never flushed: lost with its tab, unless the new leader gap-fills them.
    w.pub("car_data");
    await settle();
    a.kill();
    for (let i = 0; i < 4; i++) w.pub(i % 2 ? "position" : "car_data");
    await w.run(10);
    expect(b.status().tab?.role).toBe("leader");
    expect(c.status().tab?.leader).toBe("frame2");
    expect(b.status().state).toBe("connected");
    expect(w.tokens()).toBe(1);
    await w.run(FLUSH_MS);
    for (let i = 0; i < 4; i++) w.pub(i % 2 ? "position" : "car_data");
    await w.run(PROVISIONAL_MS + FLUSH_MS);
    const all = range(1, w.published());
    expect([...c.ns()].sort((x, y) => x - y)).toEqual(all);
    expect([...b.ns()].sort((x, y) => x - y)).toEqual(all);
    expect(b.status().stream!.gapFilled).toBeGreaterThan(0);
    expect(w.broker.max).toBeLessThanOrEqual(2);
    // The dead frame's subscriptions are pruned; c's remain.
    await w.run(6_000);
    expect(b.live.status().topics).toEqual(["car_data", "position"]);
    expect(b.status().tab?.frames).toBe(2);
  });

  test("a follower's forwarded request survives the leader dying: the new leader runs it", async () => {
    const w = world();
    const a = w.frame();
    await a.node.start();
    const b = w.frame();
    await b.node.start();
    await w.run();
    // The leader goes before answering.
    const ch = [...w.bus.channels][0]!;
    ch.onmessage = null;
    const p = b.node.get("laps", {});
    await w.run();
    a.kill();
    await w.run();
    expect((await p).status).toBe(200);
    expect(b.gets).toEqual(["frame2:laps"]);
  });
});
