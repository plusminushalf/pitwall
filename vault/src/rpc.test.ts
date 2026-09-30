import { describe, expect, test } from "bun:test";
import type { VaultStatus } from "./protocol";
import { BudgetError } from "./budget";
import { RestError } from "./rest";
import { MAX_PORTS, Rpc, type PortLike, type Vault } from "./rpc";

const status: VaultStatus = { state: "disconnected", live: "off", version: "test" };
const fake = (over: Partial<Vault> = {}): Vault => ({
  status: () => status,
  expect: () => ({ ok: true, status }),
  cancel: () => status,
  disconnect: async () => status,
  get: async () => ({ status: 200, body: new ArrayBuffer(0), auth: false }),
  dropCaller: () => {},
  setTopics: () => {},
  ...over,
});
const tick = () => new Promise((r) => setTimeout(r, 0));

class FakePort implements PortLike {
  sent: unknown[] = [];
  transfers: Transferable[][] = [];
  private listener: ((e: { data: unknown; ports: readonly PortLike[] }) => void) | null = null;
  postMessage(m: unknown, transfer: Transferable[] = []) {
    this.sent.push(m);
    this.transfers.push(transfer);
  }
  addEventListener(_type: "message", fn: NonNullable<FakePort["listener"]>) {
    this.listener = fn;
  }
  start() {}
  deliver(data: unknown, ports: PortLike[] = []) {
    this.listener?.({ data, ports });
  }
}

describe("Rpc", () => {
  test("status round trip, errors for the rest", async () => {
    const rpc = new Rpc(fake());
    const port = new FakePort();
    rpc.attach(port);
    port.deliver({ v: 1, id: 1, type: "status" });
    port.deliver({ v: 1, id: 2, type: "unsubscribe", topics: ["laps"] });
    port.deliver({ v: 1, id: 3, type: "token" });
    port.deliver({ v: 1, type: "status" }); // no id: dropped
    port.deliver("garbage");
    await tick();
    expect(port.sent).toEqual([
      { v: 1, id: 1, ok: true, result: status },
      { v: 1, id: 2, ok: true, result: { topics: [] } },
      { v: 1, id: 3, ok: false, error: { code: "bad_request", message: "unknown type" } },
    ]);
  });

  test("a throwing handler becomes a generic internal error", async () => {
    const rpc = new Rpc(
      fake({
        status: () => {
          throw new Error("secret detail");
        },
      }),
    );
    expect(await rpc.handle({ v: 1, id: 9, type: "status" }, [])).toEqual({ v: 1, id: 9, ok: false, error: { code: "internal", message: "internal error" } });
  });

  test("openPort serves the protocol on the new port; at MAX_PORTS the one idle longest is dropped, never a busy one or the main port", async () => {
    const dropped: string[] = [];
    let hold: (() => void)[] = [];
    const rpc = new Rpc(
      fake({
        dropCaller: (c) => dropped.push(c),
        get: () => new Promise((r) => hold.push(() => r({ status: 200, body: new ArrayBuffer(0), auth: false }))),
      }),
    );
    const main = new FakePort();
    rpc.attach(main, { main: true });
    const extra = new FakePort();
    main.deliver({ v: 1, id: 1, type: "openPort" }, [extra]);
    await tick();
    expect(main.sent[0]).toEqual({ v: 1, id: 1, ok: true, result: {} });
    extra.deliver({ v: 1, id: 1, type: "status" });
    await tick();
    expect(extra.sent).toEqual([{ v: 1, id: 1, ok: true, result: status }]);
    const more: FakePort[] = [];
    for (let i = 2; i < MAX_PORTS; i++) main.deliver({ v: 1, id: i, type: "openPort" }, [(more[i] = new FakePort())]);
    await tick();
    expect(rpc.portCount).toBe(MAX_PORTS);
    // At the cap: `extra` (idle longest) makes room.
    const newest = new FakePort();
    main.deliver({ v: 1, id: 50, type: "openPort" }, [newest]);
    await tick();
    expect(main.sent.at(-1)).toMatchObject({ id: 50, ok: true });
    expect(dropped).toEqual(["p1"]);
    extra.deliver({ v: 1, id: 2, type: "status" });
    await tick();
    expect(extra.sent.length).toBe(1); // no longer served
    // Every openPort port busy (a get in flight): no room.
    for (const p of [...more.filter(Boolean), newest]) p.deliver({ v: 1, id: 7, type: "get", endpoint: "laps", params: {} });
    await tick();
    main.deliver({ v: 1, id: 99, type: "openPort" }, [new FakePort()]);
    await tick();
    expect(main.sent.at(-1)).toMatchObject({ id: 99, ok: false, error: { code: "rate_limited" } });
    for (const h of hold) h();
    hold = [];
  });

  test("close: answered, then the port is done (its queued gets dropped, its topics gone)", async () => {
    const dropped: string[] = [];
    const unions: string[][] = [];
    const rpc = new Rpc(fake({ dropCaller: (c) => dropped.push(c), setTopics: (t) => unions.push(t) }));
    const main = new FakePort();
    rpc.attach(main, { main: true });
    const w = new FakePort();
    main.deliver({ v: 1, id: 1, type: "openPort" }, [w]);
    await tick();
    w.deliver({ v: 1, id: 1, type: "subscribe", topics: ["pit"] });
    await tick();
    expect(unions.at(-1)).toEqual(["pit"]);
    w.deliver({ v: 1, id: 2, type: "close" });
    await tick();
    expect(w.sent.at(-1)).toEqual({ v: 1, id: 2, ok: true, result: {} });
    expect(dropped).toContain("p1");
    expect(unions.at(-1)).toEqual([]);
    expect(rpc.portCount).toBe(1);
    w.deliver({ v: 1, id: 3, type: "status" });
    await tick();
    expect(w.sent.length).toBe(2);
  });

  test("get: each port is its own caller for the budget; a full queue is rate_limited", async () => {
    const callers: string[] = [];
    let full = false;
    const rpc = new Rpc(
      fake({
        get: async (_e, _p, caller) => {
          callers.push(caller);
          if (full) throw new BudgetError("rate_limited");
          return { status: 200, body: new ArrayBuffer(0), auth: true };
        },
      }),
    );
    const a = new FakePort();
    const b = new FakePort();
    rpc.attach(a, { main: true });
    rpc.attach(b);
    a.deliver({ v: 1, id: 1, type: "get", endpoint: "laps", params: {} });
    b.deliver({ v: 1, id: 1, type: "get", endpoint: "laps", params: {} });
    await tick();
    expect(callers).toEqual(["p0", "p1"]);
    full = true;
    b.deliver({ v: 1, id: 2, type: "get", endpoint: "laps", params: {} });
    await tick();
    expect(b.sent.at(-1)).toMatchObject({ id: 2, ok: false, error: { code: "rate_limited" } });
  });

  test("connect / unlock / cancel / disconnect, and events to every port", async () => {
    const calls: string[] = [];
    const rpc = new Rpc(
      fake({
        expect: (kind, ticket) => (calls.push(`${kind} ${ticket}`), kind === "unlock" ? { ok: false, code: "not_connected", message: "nothing to unlock" } : { ok: true, status }),
        cancel: (t) => (calls.push(`cancel ${t}`), status),
        disconnect: async () => (calls.push("disconnect"), status),
      }),
    );
    const a = new FakePort();
    const b = new FakePort();
    rpc.attach(a);
    rpc.attach(b);
    const ticket = "A".repeat(22);
    a.deliver({ v: 1, id: 1, type: "connect", ticket });
    a.deliver({ v: 1, id: 2, type: "unlock", ticket });
    a.deliver({ v: 1, id: 3, type: "cancel", ticket });
    a.deliver({ v: 1, id: 4, type: "disconnect" });
    a.deliver({ v: 1, id: 5, type: "connect" });
    a.deliver({ v: 1, id: 6, type: "connect", ticket: "short" });
    await tick();
    expect(calls).toEqual([`connect ${ticket}`, `unlock ${ticket}`, `cancel ${ticket}`, "disconnect"]);
    // Responses come back as each finishes (matched by id), not necessarily in order.
    expect(a.sent.map((r: any) => `${r.id}:${r.ok ? "ok" : r.error.code}`).sort()).toEqual(["1:ok", "2:not_connected", "3:ok", "4:ok", "5:bad_request", "6:bad_request"]);
    rpc.broadcast({ v: 1, type: "event", event: "status", status });
    expect(a.sent.at(-1)).toEqual({ v: 1, type: "event", event: "status", status });
    expect(b.sent).toEqual([{ v: 1, type: "event", event: "status", status }]);
  });

  test("get: the body is transferred; a network failure is a network error", async () => {
    const body = new TextEncoder().encode("[]").buffer as ArrayBuffer;
    let fail = false;
    const rpc = new Rpc(
      fake({
        get: async (endpoint, params) => {
          if (fail) throw new RestError("network");
          expect([endpoint, params]).toEqual(["sessions", { session_key: "latest" }]);
          return { status: 200, body, auth: true };
        },
      }),
    );
    const port = new FakePort();
    rpc.attach(port);
    port.deliver({ v: 1, id: 1, type: "get", endpoint: "sessions", params: { session_key: "latest" } });
    await tick();
    expect(port.sent[0]).toEqual({ v: 1, id: 1, ok: true, result: { status: 200, body, auth: true } });
    expect(port.transfers[0]).toEqual([body]);
    fail = true;
    port.deliver({ v: 1, id: 2, type: "get", endpoint: "sessions", params: {} });
    await tick();
    expect(port.sent[1]).toMatchObject({ id: 2, ok: false, error: { code: "network" } });
    // A handler that throws anything else: generic.
    const other = new Rpc(fake({ get: async () => { throw new Error("eyJ secret"); } }));
    expect(await other.handle({ v: 1, id: 3, type: "get", endpoint: "laps", params: {} }, [])).toEqual({ v: 1, id: 3, ok: false, error: { code: "internal", message: "internal error" } });
  });

  test("debug methods: unknown without a debug handler (a production vault), dispatched with one", async () => {
    const prod = new Rpc(fake());
    for (const req of [{ type: "debug:spoilToken" }, { type: "debug:refreshNow" }, { type: "debug:fakeExpiry", seconds: 120 }])
      expect(await prod.handle({ v: 1, id: 1, ...req }, [])).toEqual({ v: 1, id: 1, ok: false, error: { code: "bad_request", message: "unknown type" } });
    const seen: string[] = [];
    const dev = new Rpc(fake(), async (req) => (seen.push(req.type), status));
    expect(await dev.handle({ v: 1, id: 2, type: "debug:spoilToken" }, [])).toEqual({ v: 1, id: 2, ok: true, result: status });
    expect(await dev.handle({ v: 1, id: 3, type: "debug:fakeExpiry", seconds: 120 }, [])).toMatchObject({ ok: true });
    expect(await dev.handle({ v: 1, id: 4, type: "debug:fakeExpiry", seconds: 5 }, [])).toMatchObject({ ok: false, error: { code: "bad_request" } });
    expect(await dev.handle({ v: 1, id: 5, type: "debug:fakeExpiry", seconds: 0 }, [])).toMatchObject({ ok: true });
    expect(seen).toEqual(["debug:spoilToken", "debug:fakeExpiry", "debug:fakeExpiry"]);
  });

  test("subscribe / unsubscribe per port; the frame's union goes to the vault; data only to subscribed ports", async () => {
    const unions: string[][] = [];
    const rpc = new Rpc(fake({ setTopics: (t) => unions.push(t) }));
    const a = new FakePort();
    const b = new FakePort();
    rpc.attach(a);
    rpc.attach(b);
    a.deliver({ v: 1, id: 1, type: "subscribe", topics: ["laps", "car_data"] });
    b.deliver({ v: 1, id: 1, type: "subscribe", topics: ["laps", "pit"] });
    await tick();
    expect(a.sent[0]).toEqual({ v: 1, id: 1, ok: true, result: { topics: ["car_data", "laps"] } });
    expect(unions.at(-1)).toEqual(["car_data", "laps", "pit"]);
    rpc.deliver([
      { topic: "laps", messages: [{ n: 1 }] },
      { topic: "car_data", messages: [{ n: 2 }] },
      { topic: "pit", messages: [] },
    ]);
    expect(a.sent.slice(1)).toEqual([
      { v: 1, type: "event", event: "data", topic: "laps", messages: [{ n: 1 }] },
      { v: 1, type: "event", event: "data", topic: "car_data", messages: [{ n: 2 }] },
    ]);
    expect(b.sent.slice(1)).toEqual([{ v: 1, type: "event", event: "data", topic: "laps", messages: [{ n: 1 }] }]);
    a.deliver({ v: 1, id: 2, type: "unsubscribe", topics: ["laps", "car_data"] });
    await tick();
    expect(unions.at(-1)).toEqual(["laps", "pit"]);
    expect(rpc.topics()).toEqual(["laps", "pit"]);
  });
});
