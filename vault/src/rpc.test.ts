import { describe, expect, test } from "bun:test";
import type { VaultStatus } from "./protocol";
import { RestError } from "./rest";
import { MAX_PORTS, Rpc, type PortLike, type Vault } from "./rpc";

const status: VaultStatus = { state: "disconnected", live: "off", version: "test" };
const fake = (over: Partial<Vault> = {}): Vault => ({
  status: () => status,
  expect: () => ({ ok: true, status }),
  cancel: () => status,
  disconnect: async () => status,
  get: async () => ({ status: 200, body: new ArrayBuffer(0), auth: false }),
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
    port.deliver({ v: 1, id: 2, type: "subscribe", topics: ["laps"] });
    port.deliver({ v: 1, id: 3, type: "token" });
    port.deliver({ v: 1, type: "status" }); // no id: dropped
    port.deliver("garbage");
    await tick();
    expect(port.sent).toEqual([
      { v: 1, id: 1, ok: true, result: status },
      { v: 1, id: 2, ok: false, error: { code: "not_implemented", message: "subscribe is not implemented yet" } },
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

  test("openPort serves the protocol on the new port, up to MAX_PORTS", async () => {
    const rpc = new Rpc(fake());
    const main = new FakePort();
    rpc.attach(main);
    const extra = new FakePort();
    main.deliver({ v: 1, id: 1, type: "openPort" }, [extra]);
    await tick();
    expect(main.sent[0]).toEqual({ v: 1, id: 1, ok: true, result: {} });
    extra.deliver({ v: 1, id: 1, type: "status" });
    await tick();
    expect(extra.sent).toEqual([{ v: 1, id: 1, ok: true, result: status }]);
    for (let i = 2; i < MAX_PORTS; i++) main.deliver({ v: 1, id: i, type: "openPort" }, [new FakePort()]);
    main.deliver({ v: 1, id: 99, type: "openPort" }, [new FakePort()]);
    await tick();
    expect(main.sent.at(-1)).toMatchObject({ id: 99, ok: false, error: { code: "rate_limited" } });
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
});
