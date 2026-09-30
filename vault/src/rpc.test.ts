import { describe, expect, test } from "bun:test";
import type { VaultStatus } from "./protocol";
import { MAX_PORTS, Rpc, type PortLike } from "./rpc";

const status: VaultStatus = { account: "none", storage: null, live: "off", version: "test" };

class FakePort implements PortLike {
  sent: unknown[] = [];
  private listener: ((e: { data: unknown; ports: readonly PortLike[] }) => void) | null = null;
  postMessage(m: unknown) {
    this.sent.push(m);
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
  test("status round trip, errors for the rest", () => {
    const rpc = new Rpc({ status: () => status });
    const port = new FakePort();
    rpc.attach(port);
    port.deliver({ v: 1, id: 1, type: "status" });
    port.deliver({ v: 1, id: 2, type: "subscribe", topics: ["laps"] });
    port.deliver({ v: 1, id: 3, type: "token" });
    port.deliver({ v: 1, type: "status" }); // no id: dropped
    port.deliver("garbage");
    expect(port.sent).toEqual([
      { v: 1, id: 1, ok: true, result: status },
      { v: 1, id: 2, ok: false, error: { code: "not_implemented", message: "subscribe is not implemented yet" } },
      { v: 1, id: 3, ok: false, error: { code: "bad_request", message: "unknown type" } },
    ]);
  });

  test("a throwing handler becomes a generic internal error", () => {
    const rpc = new Rpc({
      status: () => {
        throw new Error("secret detail");
      },
    });
    expect(rpc.handle({ v: 1, id: 9, type: "status" }, [])).toEqual({ v: 1, id: 9, ok: false, error: { code: "internal", message: "internal error" } });
  });

  test("openPort serves the protocol on the new port, up to MAX_PORTS", () => {
    const rpc = new Rpc({ status: () => status });
    const main = new FakePort();
    rpc.attach(main);
    const extra = new FakePort();
    main.deliver({ v: 1, id: 1, type: "openPort" }, [extra]);
    expect(main.sent[0]).toEqual({ v: 1, id: 1, ok: true, result: {} });
    extra.deliver({ v: 1, id: 1, type: "status" });
    expect(extra.sent).toEqual([{ v: 1, id: 1, ok: true, result: status }]);
    for (let i = 2; i < MAX_PORTS; i++) main.deliver({ v: 1, id: i, type: "openPort" }, [new FakePort()]);
    main.deliver({ v: 1, id: 99, type: "openPort" }, [new FakePort()]);
    expect(main.sent.at(-1)).toMatchObject({ id: 99, ok: false, error: { code: "rate_limited" } });
  });
});
