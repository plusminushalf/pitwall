import { describe, expect, test } from "bun:test";
import { FakeClock, MemBroker, settle } from "../testkit";
import { VaultCore } from "./core";
import { FLUSH_MS, LiveManager, isoDate, type Batch } from "./live";
import type { Fetch } from "./openf1";
import type { LiveTopic, PopupMessage, VaultStatus } from "./protocol";
import { MemoryStore } from "./storage";
import { FreezeGate } from "./freeze";
import { Budget } from "./budget";
import { channelName, FORWARD_TIMEOUT_MS, HEARTBEAT_MS, LEASE_MS, lockNames, PROVISIONAL_MS, TAKEOVER_MS, VaultNode, type ChannelLike, type LocksLike } from "./tabs";

const USER = "someone@example.com";
const PASS = "correct horse battery staple";
const T = "ticket_ticket_ticket_01";

/** BroadcastChannel: every other channel of the same name on the bus gets a structured clone, asynchronously. */
class Bus {
  channels = new Set<ChannelLike & { dead?: boolean; name: string }>();
  make(name = channelName("test")): ChannelLike & { dead?: boolean } {
    const ch: ChannelLike & { dead?: boolean; name: string } = {
      name,
      onmessage: null,
      postMessage: (m) => {
        if (ch.dead) return;
        const copy = structuredClone(m);
        for (const o of this.channels) if (o !== ch && !o.dead && o.name === name) setImmediate(() => !o.dead && o.onmessage?.({ data: copy }));
      },
    };
    this.channels.add(ch);
    return ch;
  }
}

/** Web Locks for several frames: exclusive, FIFO, steal, abort; a dead frame's locks and queued requests go away. */
class Locks {
  held = new Map<string, string>();
  private holders = new Map<string, { owner: string; reject: (e: Error) => void }>();
  queue = new Map<string, { owner: string; grant: () => void; reject: (e: Error) => void }[]>();
  forFrame(owner: string): LocksLike {
    return {
      request: (name, opts, cb) =>
        new Promise((_resolve, reject) => {
          const grant = () => {
            this.held.set(name, owner);
            this.holders.set(name, { owner, reject });
            void cb({ name });
          };
          if (opts.steal) {
            // The holder's request rejects (AbortError); queued requests stay queued.
            this.holders.get(name)?.reject(new Error("AbortError"));
            return grant();
          }
          if (!this.held.has(name)) return grant();
          if (opts.ifAvailable) {
            void cb(null);
            return _resolve(undefined);
          }
          const q = this.queue.get(name) ?? [];
          const entry = { owner, grant, reject };
          q.push(entry);
          this.queue.set(name, q);
          opts.signal?.addEventListener("abort", () => {
            const i = q.indexOf(entry);
            if (i >= 0) {
              q.splice(i, 1);
              reject(new Error("AbortError"));
            }
          });
        }),
      query: async () => ({ held: [...this.held].map(([name, o]) => ({ name, clientId: `client-${o}` })) }),
    };
  }
  kill(owner: string) {
    for (const q of this.queue.values()) for (let i = q.length - 1; i >= 0; i--) if (q[i]!.owner === owner) q.splice(i, 1);
    for (const [name, o] of [...this.held]) {
      if (o !== owner) continue;
      this.held.delete(name);
      this.holders.delete(name);
      const next = this.queue.get(name)?.shift();
      if (next) next.grant();
    }
  }
}

/** A browser that blocks third-party storage (Helium's default): every Web Locks call is a SecurityError. */
const denied = () => Promise.reject(new DOMException("The request was denied.", "SecurityError"));
const DENIED_LOCKS = { request: denied, query: denied };

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
  function frame(opts: { gate?: boolean; visible?: () => boolean; budget?: boolean; restDelay?: number; deniedLocks?: boolean; version?: string } = {}) {
    const version = opts.version ?? "test";
    const id = `frame${++seq}`;
    const gate = opts.gate ? new FreezeGate(clock) : null;
    const timers = gate ? gate.timers() : clock;
    const statuses: VaultStatus[] = [];
    const got: Batch[] = [];
    const gets: string[] = [];
    let node: VaultNode | null = null;
    let live: LiveManager | null = null;
    const rawChannel = bus.make(channelName(version));
    const channel = gate ? gate.channel(rawChannel) : rawChannel;
    const core = new VaultCore({
      store,
      fetch,
      now: clock.now,
      version: "test",
      onStatus: () => node?.onCoreStatus(),
      announceWipe: () => node?.announceWipe(),
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
      random: () => 0.5,
      leading: () => node?.role === "leader",
      onShared: (s) => node?.onShared(s),
      onToken: () => live?.onToken(),
    });
    const budget = opts.budget ? new Budget({ ...timers, random: () => 0.5, authenticated: () => core.token() !== null }) : null;
    const callers: string[] = [];
    const rest = {
      get: async (endpoint: string, params: Record<string, string | number>, o?: { caller: string; priority?: "live" | "normal" }) => {
        const slot = budget ? await budget.acquire(o?.caller ?? "?", o?.priority) : null;
        gets.push(`${id}:${endpoint}`);
        callers.push(o?.caller ?? "?");
        if (opts.restDelay) await new Promise((r) => timers.setTimeout(() => r(null), opts.restDelay!));
        const r = await broker.rest(endpoint, params);
        slot?.release({ status: r.status });
        return { ...r, auth: core.token() !== null };
      },
    };
    live = new LiveManager({
      now: clock.now,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
      random: () => 0.5,
      url: "wss://broker/mqtt",
      socket: gate ? (u, p) => gate.socket(broker.socket(u, p)) : broker.socket,
      token: () => core.liveToken(),
      refresh: () => core.scheduler.refresh(),
      rest: (e, p) => (gate ? gate.hold(rest.get(e, p, { caller: "live", priority: "live" })) : rest.get(e, p, { caller: "live", priority: "live" })),
      emit: (b) => node?.onLiveData(b),
      onStatus: () => node?.pushStatus(),
      lease: { ok: () => node!.leaseOk(), verify: () => node!.verify() },
    });
    const frameLocks = opts.deniedLocks ? DENIED_LOCKS : locks.forFrame(id);
    node = new VaultNode({
      id,
      core,
      live,
      rest: rest as never,
      ...(budget && { budget }),
      channel,
      locks: gate ? gate.locks(frameLocks) : frameLocks,
      timers,
      version,
      onStatus: (s) => statuses.push(s),
      deliver: (b) => got.push(...b),
      ...(opts.visible && { visible: opts.visible }),
    });
    const f = {
      id,
      gate,
      core,
      node,
      live,
      statuses,
      got,
      gets,
      callers,
      budget,
      status: () => node!.status(),
      ns: () => got.flatMap((b) => b.messages.map((m) => m.n as number)),
      /** The tab closes. */
      kill: () => {
        rawChannel.dead = true;
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

/** The watchdog runs every second: allow one more. */
const WATCH_MS_SLACK = 1_000;

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
    expect(b.status().tab).toEqual({ role: "follower", id: "frame2", leader: "frame1", changes: 0, steals: 0, lost: 0 });
    expect(b.status().state).toBe("disconnected");
    expect(w.locks.held.get(lockNames("test").leader)).toBe("frame1");
    expect(w.locks.held.has(`${lockNames("test").frame}frame2`)).toBe(true);
  });

  test("Web Locks refused (third-party storage blocked): the frame leads on its own and says unavailable", async () => {
    const w = world();
    w.store.fail = true; // and IndexedDB refuses too
    const a = w.frame({ deniedLocks: true });
    await a.node.start();
    await w.run();
    expect(a.status().tab).toMatchObject({ role: "leader", id: "frame1" });
    expect(a.status().state).toBe("unavailable");
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

  test("after a disconnect, a new login in the same page streams again what the tabs subscribe to", async () => {
    const w = world();
    const a = w.frame();
    await a.node.start();
    const b = w.frame();
    await b.node.start();
    await w.run();
    await a.login();
    b.node.setTopics(["car_data"]);
    await w.run(10);
    w.pub("car_data");
    await w.run(FLUSH_MS);
    expect(b.ns()).toEqual([1]);
    await b.node.disconnect();
    await w.run();
    expect(a.status().stream?.phase).toBe("waiting");
    // A new popup login (a ticket of its own): the leader's stream starts again.
    const ticket = "ticket_ticket_ticket_02";
    expect(a.core.expect("connect", ticket).ok).toBe(true);
    const popup = {};
    const send = (m: Record<string, unknown>) => a.core.popup({ v: 1, ticket, ...m } as PopupMessage, popup);
    await send({ type: "popup:hello" });
    await send({ type: "popup:login", username: USER, password: PASS, mode: "device" });
    await w.run(10);
    expect(a.status().stream).toMatchObject({ phase: "connected", sessions: 1, topics: ["car_data"] });
    w.pub("car_data");
    await w.run(FLUSH_MS);
    expect(b.ns()).toEqual([1, 2]);
  });

  test("a frame of another build never follows this one's leader: each build leads on its own", async () => {
    const w = world();
    const old = w.frame({ version: "0.1.0+old" });
    await old.node.start();
    await w.run();
    await old.login();
    old.node.setTopics(["car_data"]);
    await w.run(10);
    // A tab opened after a deploy: the new build.
    const fresh = w.frame({ version: "0.1.0+new" });
    await fresh.node.start();
    await w.run();
    expect(old.status().tab?.role).toBe("leader");
    expect(fresh.status().tab).toMatchObject({ role: "leader", leader: fresh.id });
    // Its own login (restored from storage), its own requests and its own stream.
    expect(fresh.status().state).toBe("connected");
    const g = fresh.node.get("sessions", { session_key: "latest" }, "p0");
    await w.run();
    expect((await g).status).toBe(200);
    expect(fresh.gets).toEqual([`${fresh.id}:sessions`]);
    expect(old.gets).toEqual([]);
    fresh.node.setTopics(["position"]);
    await w.run(10);
    expect(fresh.live.status().topics).toEqual(["position"]);
    expect(old.live.status().topics).toEqual(["car_data"]);
    expect(w.broker.current).toBe(2);
    w.pub("position");
    await w.run(FLUSH_MS);
    expect(fresh.ns()).toEqual([1]);
    expect(old.ns()).toEqual([]);
  });

  test("a follower's get goes through the leader (its REST budget)", async () => {
    const w = world();
    const a = w.frame();
    await a.node.start();
    const b = w.frame();
    await b.node.start();
    await w.run();
    const p = b.node.get("sessions", { session_key: "latest" }, "p0");
    await w.run();
    expect((await p).status).toBe(200);
    expect(a.gets).toEqual(["frame1:sessions"]);
    expect(b.gets).toEqual([]);
    // The budget's caller: the follower frame's port.
    expect(a.callers).toEqual(["frame2/p0"]);
    await a.node.get("laps", {}, "p1");
    expect(a.callers.at(-1)).toBe("frame1/p1");
  });

  test("one budget across tabs: a follower's gets queue in the leader's budget and wait there for minutes while the leader lives", async () => {
    const w = world();
    const a = w.frame({ budget: true, restDelay: 2_000 });
    await a.node.start();
    const b = w.frame({ budget: true });
    await b.node.start();
    await w.run();
    // 70 gets without a token (30/min): the last ones wait more than two minutes in the leader's budget.
    const ps = Array.from({ length: 70 }, (_, i) => b.node.get("laps", { session_key: i }, "p1"));
    const done: number[] = [];
    ps.forEach((p, i) => p.then(() => done.push(i), () => done.push(-1)));
    await w.run(30_000);
    expect(a.budget!.status()).toMatchObject({ auth: false, callers: 1 });
    expect(a.budget!.status().usedThisMinute).toBeLessThanOrEqual(30);
    await w.run(150_000);
    expect(done.length).toBe(70);
    expect(done.includes(-1)).toBe(false);
    expect(b.budget!.status().started).toBe(0); // the follower spent none of its own
  });

  test("a forwarded get fails once the leader has gone quiet (a hidden follower doesn't steal)", async () => {
    const w = world();
    const a = w.frame({ gate: true });
    await a.node.start();
    const b = w.frame({ visible: () => false });
    await b.node.start();
    await w.run();
    a.gate!.freeze(120_000);
    const p = b.node.get("laps", {}, "p0").then(() => "ok", (e: Error) => e.message);
    await w.run(FORWARD_TIMEOUT_MS - 5_000);
    const r: { v: string | null } = { v: null };
    void p.then((x) => (r.v = x));
    await w.run();
    expect(r.v).toBeNull();
    await w.run(10_000);
    expect(r.v).toBe("the leader frame didn't answer");
    expect(b.node.role).toBe("follower");
  });

  test("a closed port's queued gets are dropped, at the leader too", async () => {
    const w = world();
    const a = w.frame({ budget: true, restDelay: 1_000 });
    await a.node.start();
    const b = w.frame({ budget: true });
    await b.node.start();
    await w.run();
    const results: string[] = [];
    for (let i = 0; i < 40; i++) b.node.get("laps", { session_key: i }, "p2").then(() => results.push("ok"), (e) => results.push(e.code ?? e.message));
    await w.run(5_000);
    const started = a.budget!.status().started;
    b.node.dropCaller("p2");
    await w.run(120_000);
    expect(results.filter((r) => r === "cancelled").length).toBe(40 - results.filter((r) => r === "ok").length);
    expect(a.budget!.status()).toMatchObject({ queued: 0, inFlight: 0 });
    expect(a.budget!.status().started).toBeLessThanOrEqual(started + 6); // only what was already in flight
  });

  test("takeover: the new leader counts the old leader's last minute of requests (its heartbeat carried them)", async () => {
    const w = world();
    const a = w.frame({ budget: true });
    await a.node.start();
    const b = w.frame({ budget: true });
    await b.node.start();
    await w.run();
    for (let i = 0; i < 25; i++) void a.node.get("laps", { session_key: i }, "p0");
    await w.run(12_000);
    expect(a.budget!.status().usedThisMinute).toBe(25);
    a.kill();
    await w.run(1_000);
    expect(b.node.role).toBe("leader");
    expect(b.budget!.status().usedThisMinute).toBe(25);
    // So without a token it has 5 left this minute, not 30.
    for (let i = 0; i < 10; i++) void b.node.get("laps", { session_key: i }, "p0");
    await w.run(10_000);
    expect(b.budget!.status().started).toBe(5);
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
    const p = b.node.get("laps", {}, "p0");
    await w.run();
    a.kill();
    await w.run();
    expect((await p).status).toBe(200);
    expect(b.gets).toEqual(["frame2:laps"]);
  });

  test("a frozen leader: a visible follower steals the lock; the old leader wakes, emits nothing stale, and follows", async () => {
    const w = world();
    const a = w.frame({ gate: true });
    await a.node.start();
    const b = w.frame();
    await b.node.start();
    await w.run();
    await a.login();
    a.node.setTopics(["car_data"]);
    b.node.setTopics(["car_data"]);
    await w.run(10);
    for (let i = 0; i < 5; i++) w.pub("car_data");
    await w.run(FLUSH_MS);
    expect(b.ns()).toEqual(range(1, 5));
    await w.run(HEARTBEAT_MS); // (a heartbeat has told b the session's clientId)
    // The leader's tab freezes (timers, socket, channel, locks all wait). The broker keeps publishing to it.
    a.gate!.freeze(30_000);
    for (let i = 0; i < 5; i++) w.pub("car_data");
    await w.run(TAKEOVER_MS - 2_000);
    expect(b.status().tab?.role).toBe("follower");
    await w.run(3_000 + WATCH_MS_SLACK);
    // Heard nothing for TAKEOVER_MS: b steals, opens its own session and gap-fills what a never forwarded.
    expect(b.status().tab).toMatchObject({ role: "leader", steals: 1 });
    await w.run(FLUSH_MS);
    for (let i = 0; i < 5; i++) w.pub("car_data");
    await w.run(FLUSH_MS);
    expect(b.ns()).toEqual(range(1, 15));
    // b's session reused a's clientId (from its heartbeat), so the broker kicked a's frozen session.
    expect(w.broker.current).toBe(1);
    expect(w.broker.max).toBeLessThanOrEqual(2);
    // A new token now: b waits with the handover until a is heard from (its other session may still be open).
    await b.core.scheduler.refresh();
    await w.run(3_000);
    expect(b.live.status().handovers).toBe(0);
    // a wakes: its socket's backlog (10 messages) must not be delivered by a as the leader; it demotes.
    await w.run(20_000);
    for (let i = 0; i < 5; i++) w.pub("car_data");
    await w.run(PROVISIONAL_MS + FLUSH_MS);
    expect(a.status().tab).toMatchObject({ role: "follower", leader: b.id, lost: 1 });
    expect(b.live.status().handovers).toBe(1); // released once a said hello as a follower
    expect(b.status().tab?.role).toBe("leader");
    const all = range(1, w.published());
    expect([...b.ns()].sort((x, y) => x - y)).toEqual(all);
    // a's app: everything once (what it delivered before the freeze, then b's data, deduped).
    expect([...a.ns()].sort((x, y) => x - y)).toEqual(all);
    expect(w.broker.current).toBe(1); // a closed its stale session
    expect(a.core.scheduler.running).toBe(false);
    expect(b.core.scheduler.running).toBe(true);
    expect(w.tokens()).toBe(2); // the takeover used the shared login; one refresh (the test's) since
  });

  test("a frame that joins while the leader is frozen: the stale leader, waking, doesn't answer its hello", async () => {
    const w = world();
    const a = w.frame({ gate: true });
    await a.node.start();
    const b = w.frame();
    await b.node.start();
    await w.run();
    await a.login();
    a.node.setTopics(["car_data"]);
    b.node.setTopics(["car_data"]);
    await w.run(10);
    for (let i = 0; i < 3; i++) w.pub("car_data");
    await w.run(FLUSH_MS + HEARTBEAT_MS);
    a.gate!.freeze(30_000);
    await w.run(2_000);
    // A new (hidden) tab joins now: its hello waits in a's frozen queue, ahead of the lock being stolen.
    const d = w.frame({ visible: () => false });
    await d.node.start();
    d.node.setTopics(["car_data"]);
    await w.run(TAKEOVER_MS + WATCH_MS_SLACK);
    expect(b.status().tab?.role).toBe("leader");
    expect(d.status().tab?.leader).toBe(b.id);
    // a wakes: it must not sync d as if it still led (d would follow a stale leader, and being hidden, never steal).
    await w.run(20_000);
    expect(a.status().tab).toMatchObject({ role: "follower", leader: b.id });
    expect(d.status().tab?.leader).toBe(b.id);
    const before = d.ns().length;
    for (let i = 0; i < 3; i++) w.pub("car_data");
    await w.run(PROVISIONAL_MS + FLUSH_MS);
    expect(d.ns().length).toBe(before + 3);
  });

  test("a hidden follower doesn't steal from a silent leader", async () => {
    const w = world();
    const a = w.frame({ gate: true });
    await a.node.start();
    const b = w.frame({ visible: () => false });
    await b.node.start();
    await w.run();
    a.gate!.freeze(20_000);
    await w.run(15_000);
    expect(b.status().tab?.role).toBe("follower");
    expect(a.status().tab?.role).toBe("leader");
  });

  test("the lease: void after a missed heartbeat, renewed by a lock check", async () => {
    const w = world();
    const a = w.frame({ gate: true });
    await a.node.start();
    await w.run();
    expect(a.node.leaseOk()).toBe(true);
    await w.run(HEARTBEAT_MS * 3);
    expect(a.node.leaseOk()).toBe(true); // on-time heartbeats keep it
    a.gate!.freeze(LEASE_MS + 2_000);
    w.clock.t += LEASE_MS + 1; // (read the lease mid-freeze)
    expect(a.node.leaseOk()).toBe(false);
    await w.run(3_000);
    // The late heartbeat didn't renew it by itself: it checked the lock (still ours), which did.
    expect(a.node.leaseOk()).toBe(true);
    expect(a.status().tab?.role).toBe("leader");
  });

  test("followers take data and status only from the leader they know", async () => {
    const w = world();
    const a = w.frame();
    await a.node.start();
    const b = w.frame();
    await b.node.start();
    await w.run();
    const impostor = w.bus.make();
    impostor.postMessage({ k: "data", from: "stale", batches: [{ topic: "car_data", messages: [{ date: isoDate(1), n: 99 }] }] });
    impostor.postMessage({ k: "status", from: "stale", status: { state: "error", live: "off", version: "x" } });
    await w.run();
    expect(b.ns()).toEqual([]);
    expect(b.status().state).toBe("disconnected");
    expect(b.status().tab?.leader).toBe(a.id);
  });

  test("a frame that joins mid-batch gets that batch (the leader flushes before its sync snapshot)", async () => {
    const w = world();
    const a = w.frame();
    await a.node.start();
    await w.run();
    await a.login();
    a.node.setTopics(["car_data"]);
    await w.run(10);
    for (let i = 0; i < 3; i++) w.pub("car_data");
    await w.run(FLUSH_MS);
    w.pub("car_data"); // accepted by the leader, still in its outbox
    await settle();
    const b = w.frame();
    await b.node.start();
    b.node.setTopics(["car_data"]);
    await w.run(FLUSH_MS * 2);
    expect(b.ns()).toContain(4);
  });
});
