// The download worker's vault path (vaultPort.ts): which way to go, and falling back to the direct fetches with
// no failure when the vault isn't signed in, loses its token, or stops answering mid-download.

import { describe, expect, test } from "bun:test";
import { FakeClock, settle } from "../../vault/testkit";
import type { VaultStatus } from "../../vault/src/protocol";
import { choosePath, PING_MS, PING_TIMEOUT_MS, vaultFetchEndpoint, VaultPort, type PortLike } from "./vaultPort";

const NOW = 1_700_000_000_000;
const connected: VaultStatus = { state: "connected", live: "off", version: "t", tokenExpiresAt: NOW + 3_600_000, refresh: "scheduled" };

describe("choosePath", () => {
  test("through the vault only when it's signed in with a token that works", () => {
    expect(choosePath(connected, NOW)).toEqual({ path: "vault", reason: "signed in" });
    expect(choosePath(null, NOW).path).toBe("direct");
    for (const state of ["disconnected", "locked", "connecting", "error", "unavailable"] as const) expect(choosePath({ ...connected, state }, NOW)).toEqual({ path: "direct", reason: `vault ${state}` });
    expect(choosePath({ ...connected, refresh: "expired" }, NOW).path).toBe("direct");
    expect(choosePath({ ...connected, tokenExpiresAt: NOW - 1 }, NOW).path).toBe("direct");
    // A password change (needsReauth) keeps the current token until it runs out: still fast until then.
    expect(choosePath({ ...connected, needsReauth: true, refresh: "stopped" }, NOW).path).toBe("vault");
  });
});

/** The vault's end of the port: answers the protocol like the frame does, until it's "killed". */
function fakeVault(clock: FakeClock, opts: { status?: VaultStatus; answer?: (endpoint: string, params: unknown) => { status: number; body: string; auth: boolean } } = {}) {
  let alive = true;
  const seen: { type: string; endpoint?: string }[] = [];
  const port: PortLike = {
    onmessage: null,
    postMessage(m) {
      const req = m as { id: number; type: string; endpoint?: string; params?: unknown };
      seen.push({ type: req.type, ...(req.endpoint && { endpoint: req.endpoint }) });
      if (!alive) return;
      clock.setTimeout(() => {
        if (!alive) return;
        let result: unknown = {};
        if (req.type === "status") result = opts.status ?? connected;
        if (req.type === "get") {
          const a = opts.answer?.(req.endpoint!, req.params) ?? { status: 200, body: JSON.stringify([{ endpoint: req.endpoint }]), auth: true };
          result = { status: a.status, body: new TextEncoder().encode(a.body).buffer, auth: a.auth };
        }
        port.onmessage?.({ data: { v: 1, id: req.id, ok: true, result } });
      }, 50);
    },
  };
  return { port, seen, kill: () => (alive = false) };
}

function setup(opts: Parameters<typeof fakeVault>[1] = {}) {
  const clock = new FakeClock();
  const v = fakeVault(clock, opts);
  const vault = new VaultPort(v.port, clock);
  const direct: string[] = [];
  const paths: string[] = [];
  const retries: number[] = [];
  const fetch = vaultFetchEndpoint({
    vault,
    direct: async <T,>(endpoint: string) => (direct.push(endpoint), [{ direct: endpoint }] as T[]),
    onPath: (p, why) => paths.push(`${p}: ${why}`),
    onRetry: (e) => retries.push(e.status),
    sleep: (ms) => new Promise((r) => clock.setTimeout(() => r(), ms)),
  });
  return { clock, v, vault, fetch, direct, paths, retries };
}

describe("fetching through the vault", () => {
  test("signed in: rows come from the vault; 404 is no rows", async () => {
    const x = setup({ answer: (e) => (e === "overtakes" ? { status: 404, body: '{"detail":"No results found."}', auth: true } : { status: 200, body: `[{"e":"${e}"}]`, auth: true }) });
    const a = x.fetch("laps", { session_key: 1 });
    const b = x.fetch("overtakes", { session_key: 1 });
    await x.clock.advance(100);
    expect(await a).toEqual([{ e: "laps" }]);
    expect(await b).toEqual([]);
    expect(x.direct).toEqual([]);
    expect(x.v.seen.filter((s) => s.type === "get").map((s) => s.endpoint)).toEqual(["laps", "overtakes"]);
  });

  test("a 429 the vault gave back (after its own retries) and a 5xx: retried with backoff, still through the vault", async () => {
    let n = 0;
    const x = setup({ answer: () => (++n === 1 ? { status: 429, body: "", auth: true } : n === 2 ? { status: 502, body: "", auth: true } : { status: 200, body: "[1]", auth: true }) });
    const r = x.fetch("laps", {});
    await x.clock.advance(60_000);
    expect(await r).toEqual([1]);
    expect(x.retries).toEqual([429, 502]);
    expect(x.direct).toEqual([]);
  });

  test("the vault loses its token mid-download (an unauthenticated answer): this and every later request go direct", async () => {
    let auth = true;
    const x = setup({ answer: () => ({ status: 200, body: "[1]", auth }) });
    const a = x.fetch("laps", {});
    await x.clock.advance(100);
    expect(await a).toEqual([1]);
    auth = false;
    const b = x.fetch("stints", {});
    await x.clock.advance(100);
    expect(await b).toEqual([{ direct: "stints" }]);
    const c = x.fetch("pit", {});
    await x.clock.advance(100);
    expect(await c).toEqual([{ direct: "pit" }]);
    expect(x.paths).toEqual(["direct: the vault has no token now"]);
    expect(x.v.seen.filter((s) => s.type === "get").length).toBe(2); // pit never asked the vault
  });

  test("the vault stops answering mid-download: the pings fail, requests in flight are re-done direct, no error", async () => {
    const x = setup();
    const a = x.fetch("laps", {});
    await x.clock.advance(100);
    expect(await a).toEqual([{ endpoint: "laps" }]);
    x.v.kill(); // its frame crashed, or its server went away and the frame with it
    const inFlight = [x.fetch("car_data", { driver_number: 1 }), x.fetch("location", { driver_number: 1 })];
    await x.clock.advance(PING_MS + PING_TIMEOUT_MS + 100);
    expect(await Promise.all(inFlight)).toEqual([[{ direct: "car_data" }], [{ direct: "location" }]]);
    expect(x.paths.length).toBe(1);
    expect(x.paths[0]).toStartWith("direct: ");
    expect(x.vault.isDown).toBe(true);
    const later = x.fetch("car_data", { driver_number: 2 });
    await settle();
    expect(await later).toEqual([{ direct: "car_data" }]);
  });

  test("status: null when the vault doesn't answer in time; close tells it (and stops pinging)", async () => {
    const x = setup();
    const s = x.vault.status(1_000);
    await x.clock.advance(100);
    expect((await s)?.state).toBe("connected");
    x.vault.close();
    expect(x.v.seen.at(-1)).toEqual({ type: "close" });
    await expect(x.vault.get("laps", {})).rejects.toThrow("closed");
    const y = setup();
    y.v.kill();
    const s2 = y.vault.status(1_000);
    await y.clock.advance(1_100);
    expect(await s2).toBeNull();
  });

  test("the page couldn't get a port (markDown): straight to direct", async () => {
    const x = setup();
    x.vault.markDown("vault unavailable");
    const r = x.fetch("laps", {});
    await settle();
    expect(await r).toEqual([{ direct: "laps" }]);
    expect(x.v.seen.length).toBe(0);
  });
});
