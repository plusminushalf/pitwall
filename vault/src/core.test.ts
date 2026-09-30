import { describe, expect, test } from "bun:test";
import { PENDING_MS, VaultCore } from "./core";
import type { Fetch } from "./openf1";
import type { FrameToPopup, PopupMessage, VaultStatus } from "./protocol";
import { MemoryStore, randomBytes } from "./storage";

const USER = "someone@example.com";
const PASS = "correct horse battery staple";
const JWT = "eyJhbGciOiJSUzI1NiJ9.payload.signature";
const T = "ticket_ticket_ticket_01";

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type Reply = { status: number; body: string } | "throw";

function setup(opts: { store?: MemoryStore; replies?: Reply[] } = {}) {
  const store = opts.store ?? new MemoryStore();
  const replies = opts.replies ?? [];
  const requests: Record<string, string>[] = [];
  const statuses: VaultStatus[] = [];
  let now = 1_000_000;
  let wipes = 0;
  const fetch: Fetch = async (_url, init) => {
    requests.push(Object.fromEntries(new URLSearchParams(init.body)));
    const r = replies.shift() ?? { status: 200, body: JSON.stringify({ access_token: JWT, token_type: "bearer", expires_in: "3600" }) };
    if (r === "throw") throw new TypeError("Failed to fetch");
    return { status: r.status, text: async () => r.body };
  };
  // Fake timers: the refresh schedule runs only when a test calls runTimers().
  let timers: { at: number; fn: () => void }[] = [];
  const core = new VaultCore({
    store,
    fetch,
    now: () => now,
    version: "test",
    onStatus: (s) => statuses.push(s),
    announceWipe: () => wipes++,
    setTimeout: (fn, ms) => {
      const t = { at: now + ms, fn };
      timers.push(t);
      return t;
    },
    clearTimeout: (h) => (timers = timers.filter((t) => t !== h)),
    random: () => 0.5,
  });
  const popup = { name: "popup window" };
  return {
    core,
    store,
    requests,
    statuses,
    popup,
    advance: (ms: number) => (now += ms),
    /** Move the clock to `to`, firing due timers in order, and let their /token calls finish. */
    runUntil: async (to: number) => {
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        const t = timers[0];
        if (!t || t.at > to) break;
        timers.shift();
        now = Math.max(now, t.at);
        t.fn();
        for (let i = 0; i < 5; i++) await Promise.resolve();
      }
      now = to;
    },
    now: () => now,
    wipes: () => wipes,
    send: (msg: DistributiveOmit<PopupMessage, "v" | "ticket"> & { ticket?: string }, source: unknown = popup) =>
      core.popup({ v: 1, ticket: T, ...msg } as PopupMessage, source) as Promise<FrameToPopup | null>,
  };
}

const login = (mode: "device" | "passkey", username = USER, password = PASS) => ({ type: "popup:login" as const, username, password, mode });
const noSecrets = (x: unknown) => {
  const s = JSON.stringify(x);
  expect(s).not.toContain(PASS);
  expect(s).not.toContain(JWT);
  expect(s).not.toContain("eyJhbGciOi");
};

describe("VaultCore", () => {
  test("empty store: disconnected", async () => {
    const v = setup();
    await v.core.init();
    expect(v.core.status()).toEqual({ state: "disconnected", live: "off", version: "test" });
  });

  test("blocked storage: unavailable, and connect is refused", async () => {
    const store = new MemoryStore();
    store.fail = true;
    const v = setup({ store });
    await v.core.init();
    expect(v.core.status().state).toBe("unavailable");
    expect(v.core.expect("connect", T)).toMatchObject({ ok: false, code: "unavailable" });
  });

  test("stay connected: popup login, stored sealed, restored silently on the next load", async () => {
    const v = setup();
    await v.core.init();
    expect(v.core.expect("connect", T).ok).toBe(true);
    const welcome = await v.send({ type: "popup:hello" });
    expect(welcome).toMatchObject({ type: "popup:welcome", kind: "connect", ticket: T });
    expect(await v.send(login("device"))).toEqual({ v: 1, type: "popup:result", ticket: T, ok: true, next: "done" });
    expect(v.requests).toEqual([{ username: USER, password: PASS }]);
    const s = v.core.status();
    expect(s).toEqual({
      state: "connected",
      mode: "device",
      account: "s***@example.com",
      tokenExpiresAt: 1_000_000 + 3_600_000,
      nextRefreshAt: 1_000_000 + 3_000_000,
      refreshCount: 0,
      needsReauth: false,
      refresh: "scheduled",
      live: "off",
      version: "test",
    });
    expect(v.statuses.map((x) => x.state)).toEqual(["disconnected", "connecting", "connected"]);
    noSecrets(v.statuses);
    // The ticket is used up: a replay is ignored.
    expect(await v.send(login("device"))).toBeNull();
    // What's stored: sealed, with only the masked account in the clear.
    const stored = v.store.value!;
    expect(stored.mode).toBe("device");
    expect(stored.account).toBe("s***@example.com");
    expect(new TextDecoder().decode(stored.sealed.ciphertext)).not.toContain(PASS);
    // Next page load: silent restore.
    const next = setup({ store: v.store });
    await next.core.init();
    expect(next.core.status()).toMatchObject({ state: "connected", mode: "device", account: "s***@example.com" });
    expect(next.requests).toEqual([{ username: USER, password: PASS }]);
    expect(next.statuses.map((x) => x.state)).toEqual(["connecting", "connected"]);
  });

  test("login errors go to the popup; nothing is stored, the state is unchanged", async () => {
    const v = setup({
      replies: [
        { status: 401, body: '{"detail":"Incorrect username or password"}' },
        { status: 429, body: "<html><center>nginx</center></html>" },
        "throw",
        { status: 503, body: "" },
      ],
    });
    await v.core.init();
    v.core.expect("connect", T);
    await v.send({ type: "popup:hello" });
    for (const code of ["wrong_credentials", "rate_limited", "network", "server"]) {
      const r = await v.send(login("device"));
      expect(r).toMatchObject({ ok: false, error: { code } });
      noSecrets(r);
      expect(v.core.status().state).toBe("disconnected");
    }
    expect(v.store.value).toBeNull();
    // The same popup can then try again and succeed.
    expect(await v.send(login("device"))).toMatchObject({ ok: true, next: "done" });
  });

  test("only the frame expecting the ticket answers, and only to the popup that said hello first", async () => {
    const store = new MemoryStore();
    const a = setup({ store });
    const b = setup({ store });
    await a.core.init();
    await b.core.init();
    a.core.expect("connect", T);
    expect(await b.send({ type: "popup:hello" })).toBeNull();
    expect(await a.send({ type: "popup:hello" })).not.toBeNull();
    const other = { name: "another vault window" };
    expect(await a.send({ type: "popup:hello" }, other)).toBeNull();
    expect(await a.send(login("device"), other)).toBeNull();
    expect(await a.send({ ...login("device"), ticket: "another_ticket_entirely" })).toBeNull();
    expect(a.requests).toEqual([]);
  });

  test("no pending connect: popup messages are ignored; a stale one is told it expired", async () => {
    const v = setup();
    await v.core.init();
    expect(await v.send({ type: "popup:hello" })).toBeNull();
    v.core.expect("connect", T);
    v.advance(PENDING_MS + 1);
    expect(await v.send({ type: "popup:hello" })).toMatchObject({ ok: false, error: { code: "expired" } });
    expect(await v.send({ type: "popup:hello" })).toBeNull();
    // A newer connect replaces an older ticket.
    v.core.expect("connect", T);
    v.core.expect("connect", "a_newer_ticket_xxxxxxxxx");
    expect(await v.send({ type: "popup:hello" })).toBeNull();
  });

  test("passkey: verified first, sealed with the PRF output, locked on the next load, unlocked by the same PRF", async () => {
    const v = setup();
    await v.core.init();
    v.core.expect("connect", T);
    const welcome = await v.send({ type: "popup:hello" });
    if (welcome?.type !== "popup:welcome") throw new Error("no welcome");
    expect(await v.send(login("passkey"))).toMatchObject({ ok: true, next: "passkey" });
    expect(v.core.status().state).toBe("connecting");
    expect(v.store.value).toBeNull();
    const prf = randomBytes(32);
    const prfCopy = prf.slice(0);
    const credentialId = randomBytes(20);
    expect(await v.send({ type: "popup:passkey", credentialId, prf })).toMatchObject({ ok: true, next: "done" });
    expect(new Uint8Array(prf).every((b) => b === 0)).toBe(true); // wiped after use
    expect(v.core.status()).toMatchObject({ state: "connected", mode: "passkey" });
    const stored = v.store.value!;
    if (stored.mode !== "passkey") throw new Error();
    expect(new Uint8Array(stored.prfSalt)).toEqual(new Uint8Array(welcome.prfSalt));

    const next = setup({ store: v.store });
    await next.core.init();
    expect(next.core.status()).toEqual({ state: "locked", mode: "passkey", account: "s***@example.com", live: "off", version: "test" });
    expect(next.requests).toEqual([]);
    expect(next.core.expect("unlock", T).ok).toBe(true);
    const w = await next.send({ type: "popup:hello" });
    expect(w).toMatchObject({ kind: "unlock", account: "s***@example.com" });
    if (w?.type !== "popup:welcome" || w.kind !== "unlock") throw new Error();
    expect(new Uint8Array(w.credentialId)).toEqual(new Uint8Array(credentialId));
    expect(await next.send({ type: "popup:unlock", prf: randomBytes(32) })).toMatchObject({ ok: false, error: { code: "passkey" } });
    expect(next.core.status().state).toBe("locked");
    expect(next.requests).toEqual([]);
    expect(await next.send({ type: "popup:unlock", prf: prfCopy })).toMatchObject({ ok: true, next: "done" });
    expect(next.core.status()).toMatchObject({ state: "connected", mode: "passkey", tokenExpiresAt: 1_000_000 + 3_600_000 });
    expect(next.requests).toEqual([{ username: USER, password: PASS }]);
    noSecrets([...v.statuses, ...next.statuses]);
  });

  test("passkey without PRF: stay connected instead", async () => {
    const v = setup();
    await v.core.init();
    v.core.expect("connect", T);
    await v.send({ type: "popup:hello" });
    await v.send(login("passkey"));
    expect(await v.send({ type: "popup:device" })).toMatchObject({ ok: true, next: "done" });
    expect(v.core.status()).toMatchObject({ state: "connected", mode: "device" });
    expect(v.store.value?.mode).toBe("device");
  });

  test("popup closed halfway through a passkey setup: dropped, back to disconnected", async () => {
    const v = setup();
    await v.core.init();
    v.core.expect("connect", T);
    await v.send({ type: "popup:hello" });
    await v.send(login("passkey"));
    v.core.cancel("some_other_ticket_xxxxxx");
    expect(v.core.status().state).toBe("connecting");
    v.core.cancel(T);
    await new Promise((r) => setTimeout(r, 0));
    expect(v.core.status().state).toBe("disconnected");
    expect(await v.send({ type: "popup:device" })).toBeNull();
    expect(v.store.value).toBeNull();
  });

  test("unlock needs a locked login", async () => {
    const v = setup();
    await v.core.init();
    expect(v.core.expect("unlock", T)).toMatchObject({ ok: false, code: "not_connected" });
  });

  test("restore with a password changed on OpenF1: error, stored login kept for reconnect / disconnect", async () => {
    const v = setup();
    await v.core.init();
    v.core.expect("connect", T);
    await v.send({ type: "popup:hello" });
    await v.send(login("device"));
    const next = setup({ store: v.store, replies: [{ status: 401, body: "{}" }] });
    await next.core.init();
    expect(next.core.status()).toMatchObject({ state: "error", mode: "device", error: { code: "wrong_credentials" } });
    expect(next.store.value).not.toBeNull();
  });

  test("disconnect wipes storage and memory, and tells other tabs", async () => {
    const v = setup();
    await v.core.init();
    v.core.expect("connect", T);
    await v.send({ type: "popup:hello" });
    await v.send(login("device"));
    expect((await v.core.disconnect()).state).toBe("disconnected");
    expect(v.store.value).toBeNull();
    expect(v.core.status()).toEqual({ state: "disconnected", live: "off", version: "test" });
    expect(v.wipes()).toBe(1);
    const other = setup({ store: v.store });
    await other.core.init();
    expect(other.core.status().state).toBe("disconnected");
  });

  test("silent refresh at 5/6 of the lifetime: status pushed, no secrets in it", async () => {
    const v = setup();
    await v.core.init();
    v.core.expect("connect", T);
    await v.send({ type: "popup:hello" });
    await v.send(login("device"));
    const t0 = v.now();
    v.statuses.length = 0;
    await v.runUntil(t0 + 3_000_000 - 1);
    expect(v.requests.length).toBe(1);
    await v.runUntil(t0 + 3_000_000);
    expect(v.requests.length).toBe(2);
    expect(v.requests[1]).toEqual({ username: USER, password: PASS });
    expect(v.core.status()).toMatchObject({ state: "connected", refreshCount: 1, lastRefresh: { at: t0 + 3_000_000, ok: true }, tokenExpiresAt: t0 + 3_000_000 + 3_600_000 });
    expect(v.statuses.map((x) => x.refresh)).toEqual(["refreshing", "scheduled"]);
    noSecrets(v.statuses);
  });

  test("restore while OpenF1 is unreachable: error, then the scheduler's retry connects", async () => {
    const v = setup();
    await v.core.init();
    v.core.expect("connect", T);
    await v.send({ type: "popup:hello" });
    await v.send(login("device"));
    const next = setup({ store: v.store, replies: ["throw"] });
    await next.core.init();
    expect(next.core.status()).toMatchObject({ state: "error", error: { code: "network" }, refresh: "retrying", lastRefresh: { ok: false, error: "network" } });
    await next.runUntil(next.now() + 5_000);
    expect(next.core.status()).toMatchObject({ state: "connected", refresh: "scheduled", refreshCount: 1 });
    expect(next.core.status().error).toBeUndefined();
  });

  test("password changed: needsReauth, the token is kept until its exp, then the state is error", async () => {
    const v = setup({ replies: [{ status: 200, body: JSON.stringify({ access_token: JWT, expires_in: "3600" }) }, { status: 401, body: "{}" }] });
    await v.core.init();
    v.core.expect("connect", T);
    await v.send({ type: "popup:hello" });
    await v.send(login("device"));
    const t0 = v.now();
    await v.runUntil(t0 + 3_000_000);
    expect(v.core.status()).toMatchObject({ state: "connected", needsReauth: true, refresh: "stopped", tokenExpiresAt: t0 + 3_600_000 });
    expect(v.core.scheduler.current()).toBe(JWT);
    await v.runUntil(t0 + 3_600_000 + 60_000);
    expect(v.requests.length).toBe(2); // never asked again
    expect(v.core.status()).toMatchObject({ state: "error", error: { code: "wrong_credentials" }, needsReauth: true });
    expect(v.core.scheduler.current()).toBeNull();
    // Reconnecting clears it.
    v.core.expect("connect", "ticket_ticket_ticket_02");
    await v.core.popup({ v: 1, type: "popup:hello", ticket: "ticket_ticket_ticket_02" }, v.popup);
    await v.core.popup({ v: 1, ticket: "ticket_ticket_ticket_02", ...login("device") }, v.popup);
    expect(v.core.status()).toMatchObject({ state: "connected", needsReauth: false, refresh: "scheduled", refreshCount: 0 });
  });

  test("disconnect stops the refresh", async () => {
    const v = setup();
    await v.core.init();
    v.core.expect("connect", T);
    await v.send({ type: "popup:hello" });
    await v.send(login("device"));
    await v.core.disconnect();
    await v.runUntil(v.now() + 10 * 3_600_000);
    expect(v.requests.length).toBe(1);
    expect(v.core.scheduler.running).toBe(false);
  });

  test("tokenFilter (dev fake expiry) applies to every token", async () => {
    const store = new MemoryStore();
    const statuses: VaultStatus[] = [];
    const fetch: Fetch = async () => ({ status: 200, text: async () => JSON.stringify({ access_token: JWT, expires_in: "3600" }) });
    const core = new VaultCore({ store, fetch, now: () => 0, version: "t", onStatus: (s) => statuses.push(s), setTimeout: () => 0, clearTimeout: () => {}, tokenFilter: (t) => ({ ...t, expiresAt: t.issuedAt + 120_000 }) });
    await core.init();
    core.expect("connect", T);
    await core.popup({ v: 1, type: "popup:hello", ticket: T }, "w");
    await core.popup({ v: 1, ticket: T, ...login("device") }, "w");
    expect(core.status()).toMatchObject({ tokenExpiresAt: 120_000, nextRefreshAt: 100_000 });
  });
});
