import { describe, expect, test } from "bun:test";
import { loginError, type Token, type TokenResult } from "./openf1";
import type { LoginErrorCode } from "./protocol";
import { BACKOFF_429_MS, BACKOFF_BASE_MS, BACKOFF_CAP_MS, FRESH_MS, JITTER, MAX_SLEEP_MS, TOKEN_TIMEOUT_MS, TokenScheduler } from "./scheduler";

const HOUR = 3_600_000;
const T0 = 1_700_000_000_000;

type Reply = "ok" | LoginErrorCode | "hang";

/**
 * A fake clock with fake timers, and a fake /token. `replies` answers the calls in order (default "ok"):
 * a token issued now, lasting `lifetime`. "hang" leaves the call pending until `release()`.
 */
function harness(opts: { replies?: Reply[]; lifetime?: number; random?: number } = {}) {
  let now = T0;
  let timers: { at: number; fn: () => void; ms: number }[] = [];
  const replies = [...(opts.replies ?? [])];
  const calls: number[] = [];
  const hung: ((r: TokenResult) => void)[] = [];
  let changes = 0;
  let n = 0;
  const lifetime = opts.lifetime ?? HOUR;
  const mint = (): Token => ({ accessToken: `tok-${++n}`, issuedAt: now, expiresAt: now + lifetime });
  const s = new TokenScheduler({
    now: () => now,
    setTimeout: (fn, ms) => {
      const t = { at: now + ms, fn, ms };
      timers.push(t);
      return t;
    },
    clearTimeout: (h) => (timers = timers.filter((t) => t !== h)),
    random: () => opts.random ?? 0.5,
    onChange: () => changes++,
    fetchToken: () => {
      calls.push(now);
      const r = replies.shift() ?? "ok";
      if (r === "hang") return new Promise((res) => hung.push((x) => res(x)));
      return Promise.resolve(r === "ok" ? { ok: true, token: mint() } : { ok: false, error: loginError(r) });
    },
  });
  const flush = async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  };
  return {
    s,
    calls,
    mint,
    timers: () => timers,
    changes: () => changes,
    now: () => now,
    /** Fire every timer due up to `to`, in order, like a browser that keeps its timers. */
    async runUntil(to: number) {
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        const t = timers[0];
        if (!t || t.at > to) break;
        timers.shift();
        now = Math.max(now, t.at);
        t.fn();
        await flush();
      }
      now = to;
    },
    /** Jump the clock without firing anything: a suspended laptop or a throttled background tab. */
    sleep(ms: number) {
      now += ms;
    },
    async release(r: Reply = "ok") {
      const f = hung.shift()!;
      f(r === "ok" ? { ok: true, token: mint() } : { ok: false, error: loginError(r as LoginErrorCode) });
      await flush();
    },
    flush,
  };
}

/** Gaps between consecutive /token calls. */
const gaps = (calls: number[]) => calls.slice(1).map((c, i) => c - calls[i]!);

describe("TokenScheduler: the schedule", () => {
  test("refreshes at 5/6 of the lifetime, counted from the token's issue time", async () => {
    const h = harness();
    h.s.start(h.mint());
    expect(h.s.status()).toMatchObject({ refresh: "scheduled", nextRefreshAt: T0 + (HOUR * 5) / 6, tokenExpiresAt: T0 + HOUR, refreshCount: 0, needsReauth: false });
    await h.runUntil(T0 + 50 * 60_000 - 1);
    expect(h.calls).toEqual([]);
    await h.runUntil(T0 + 50 * 60_000);
    expect(h.calls).toEqual([T0 + 50 * 60_000]);
    expect(h.s.current()).toBe("tok-2");
    expect(h.s.status()).toMatchObject({ refresh: "scheduled", refreshCount: 1, lastRefresh: { at: T0 + 50 * 60_000, ok: true }, nextRefreshAt: T0 + 100 * 60_000 });
    await h.runUntil(T0 + 5 * HOUR);
    expect(gaps(h.calls)).toEqual(Array(h.calls.length - 1).fill(50 * 60_000));
    expect(h.calls.length).toBe(6);
  });

  test("a short (faked) lifetime: 120 s tokens refresh every 100 s", async () => {
    const h = harness({ lifetime: 120_000 });
    h.s.start(h.mint());
    await h.runUntil(T0 + 1000_000);
    expect(h.calls.length).toBe(10);
    expect(new Set(gaps(h.calls))).toEqual(new Set([100_000]));
  });

  test("timers never sleep longer than MAX_SLEEP_MS", () => {
    const h = harness();
    h.s.start(h.mint());
    expect(h.timers().every((t) => t.ms <= MAX_SLEEP_MS)).toBe(true);
  });

  test("a token already past its refresh time refreshes at once", async () => {
    const h = harness();
    const old = h.mint();
    h.sleep(55 * 60_000);
    h.s.start(old);
    await h.runUntil(h.now());
    expect(h.calls).toEqual([h.now()]);
  });

  test("current() is null from the first millisecond after exp (REST has no grace)", async () => {
    const h = harness({ replies: ["server", "server", "server", "server", "server", "server", "server", "server", "server", "server"] });
    h.s.start(h.mint());
    await h.runUntil(T0 + HOUR - 1);
    expect(h.s.current()).toBe("tok-1");
    await h.runUntil(T0 + HOUR);
    expect(h.s.current()).toBeNull();
  });
});

describe("TokenScheduler: failures", () => {
  test("backoff 5 s, 10 s, 20 s … capped at 2 min, until success", async () => {
    const h = harness({ replies: ["server", "network", "server", "server", "server", "server", "server", "server"] });
    h.s.start(h.mint());
    const first = T0 + (HOUR * 5) / 6;
    await h.runUntil(first);
    expect(h.s.status()).toMatchObject({ refresh: "retrying", lastRefresh: { ok: false, error: "server" }, nextRefreshAt: first + 5_000 });
    expect(h.s.current()).toBe("tok-1"); // still good
    await h.runUntil(first + 20 * 60_000);
    expect(gaps(h.calls)).toEqual([5_000, 10_000, 20_000, 40_000, 80_000, 120_000, 120_000, 120_000]);
    expect(h.s.status()).toMatchObject({ refresh: "scheduled", refreshCount: 1, lastRefresh: { ok: true } });
    // Success resets the backoff.
    expect(h.s.status().nextRefreshAt).toBe(h.calls.at(-1)! + (HOUR * 5) / 6);
  });

  test("a /token call that never answers times out as a network failure and is retried", async () => {
    const h = harness({ replies: ["hang"] });
    h.s.start(h.mint());
    const first = T0 + (HOUR * 5) / 6;
    await h.runUntil(first + TOKEN_TIMEOUT_MS);
    expect(h.s.status()).toMatchObject({ refresh: "retrying", lastRefresh: { ok: false, error: "network" } });
    await h.runUntil(first + TOKEN_TIMEOUT_MS + 5_000);
    expect(h.calls.length).toBe(2);
    expect(h.s.current()).toBe("tok-2");
    // The hung call answering late changes nothing.
    await h.release();
    expect(h.s.current()).toBe("tok-2");
  });

  test("jitter spreads each delay by ±20%", async () => {
    for (const [random, factor] of [
      [0, 1 - JITTER],
      [0.999999, 1 + JITTER],
    ] as const) {
      const h = harness({ replies: ["server", "server"], random });
      h.s.start(h.mint());
      await h.runUntil(T0 + HOUR - 1);
      const g = gaps(h.calls);
      expect(g[0]).toBe(Math.round(BACKOFF_BASE_MS * factor));
      expect(g[1]).toBe(Math.round(2 * BACKOFF_BASE_MS * factor));
    }
  });

  test("a 429 backs off longer: 30 s, 60 s, 120 s", async () => {
    const h = harness({ replies: ["rate_limited", "rate_limited", "rate_limited", "rate_limited"] });
    h.s.start(h.mint());
    await h.runUntil(T0 + HOUR - 1);
    expect(gaps(h.calls)).toEqual([BACKOFF_429_MS, 2 * BACKOFF_429_MS, BACKOFF_CAP_MS, BACKOFF_CAP_MS]);
  });

  test("after the token expires: phase expired, pushed at exp, retries at the cap", async () => {
    const replies: Reply[] = Array(30).fill("server");
    const h = harness({ replies });
    h.s.start(h.mint());
    await h.runUntil(T0 + HOUR - 1);
    expect(h.s.status().refresh).toBe("retrying");
    const before = h.changes();
    await h.runUntil(T0 + HOUR);
    expect(h.s.status().refresh).toBe("expired");
    expect(h.changes()).toBe(before + 1); // the UI hears about it at exp, not at the next retry
    const n = h.calls.length;
    await h.runUntil(T0 + HOUR + 10 * 60_000);
    const later = h.calls.slice(n - 1);
    expect(gaps(later).slice(1).every((g) => g === BACKOFF_CAP_MS)).toBe(true);
    expect(h.s.status().refresh).toBe("expired");
    expect(h.s.current()).toBeNull();
  });

  test("recovery after expiry: back to scheduled with a fresh token", async () => {
    const h = harness({ replies: Array(12).fill("network") });
    h.s.start(h.mint());
    await h.runUntil(T0 + 2 * HOUR);
    expect(h.s.status().refresh).toBe("scheduled");
    expect(h.s.current()).not.toBeNull();
  });

  test("401 from /token: stop, needsReauth, keep the current token until its exp", async () => {
    const h = harness({ replies: ["wrong_credentials"] });
    h.s.start(h.mint());
    await h.runUntil(T0 + (HOUR * 5) / 6);
    expect(h.s.status()).toMatchObject({ refresh: "stopped", needsReauth: true, lastRefresh: { ok: false, error: "wrong_credentials" } });
    expect(h.s.status().nextRefreshAt).toBeUndefined();
    expect(h.s.current()).toBe("tok-1");
    expect(await h.s.refresh()).toBe(false);
    expect(await h.s.onUnauthorized("tok-1")).toBe("give_up");
    const before = h.changes();
    await h.runUntil(T0 + 3 * HOUR);
    expect(h.calls.length).toBe(1); // never asked again
    expect(h.s.current()).toBeNull();
    expect(h.changes()).toBe(before + 1); // told at exp
    // A new login starts over.
    h.s.start(h.mint());
    expect(h.s.status()).toMatchObject({ refresh: "scheduled", needsReauth: false });
  });

  test("no first token (restore failed): retries with backoff and starts on success", async () => {
    const h = harness({ replies: ["network"] });
    h.s.start(null, "network");
    expect(h.s.status()).toMatchObject({ refresh: "retrying", nextRefreshAt: T0 + 5_000, lastRefresh: { ok: false, error: "network" } });
    await h.runUntil(T0 + 20_000);
    expect(gaps([T0, ...h.calls])).toEqual([5_000, 10_000]);
    expect(h.s.status()).toMatchObject({ refresh: "scheduled", refreshCount: 1 });
  });
});

describe("TokenScheduler: coalescing and 401s", () => {
  test("concurrent refreshes share one /token call", async () => {
    const h = harness({ replies: ["hang"] });
    h.s.start(h.mint());
    const all = [h.s.refresh(), h.s.refresh(), h.s.onUnauthorized("tok-1"), h.s.refresh()];
    expect(h.s.status().refresh).toBe("refreshing");
    await h.flush();
    expect(h.calls.length).toBe(1);
    await h.release();
    expect(await Promise.all(all)).toEqual([true, true, "retry", true]);
    expect(h.calls.length).toBe(1);
    expect(h.s.current()).toBe("tok-2");
  });

  test("a scheduled refresh landing during a manual one doesn't start a second call", async () => {
    const h = harness({ replies: ["hang"] });
    h.s.start(h.mint());
    h.sleep(50 * 60_000 - 10);
    const p = h.s.refresh();
    await h.runUntil(h.now() + TOKEN_TIMEOUT_MS - 1);
    expect(h.calls.length).toBe(1);
    await h.release();
    expect(await p).toBe(true);
  });

  test("REST 401 on an older token: refresh, then retry", async () => {
    const h = harness();
    h.s.start(h.mint());
    h.sleep(FRESH_MS + 1);
    expect(await h.s.onUnauthorized("tok-1")).toBe("retry");
    expect(h.calls.length).toBe(1);
    expect(h.s.current()).toBe("tok-2");
    expect(h.s.status().refreshCount).toBe(1);
  });

  test("REST 401 with a token already replaced: retry, no /token call", async () => {
    const h = harness();
    h.s.start(h.mint());
    h.sleep(FRESH_MS + 1);
    await h.s.refresh();
    expect(await h.s.onUnauthorized("tok-1")).toBe("retry");
    expect(h.calls.length).toBe(1);
  });

  test("a brand-new token refused too: give up, go unauthenticated, try again only at the cap", async () => {
    const h = harness();
    h.s.start(h.mint());
    h.sleep(FRESH_MS + 1);
    expect(await h.s.onUnauthorized("tok-1")).toBe("retry");
    // tok-2 is refused at once as well: no second refresh.
    expect(await h.s.onUnauthorized("tok-2")).toBe("give_up");
    expect(h.calls.length).toBe(1);
    expect(h.s.current()).toBeNull();
    expect(h.s.status()).toMatchObject({ refresh: "retrying", lastRefresh: { ok: false, error: "rejected" } });
    // A storm of 401s changes nothing.
    for (let i = 0; i < 50; i++) expect(await h.s.onUnauthorized("tok-2")).toBe("give_up");
    expect(h.calls.length).toBe(1);
    await h.runUntil(h.now() + BACKOFF_CAP_MS);
    expect(h.calls.length).toBe(2);
    expect(h.s.current()).toBe("tok-3");
  });

  test("no refresh storm: a burst of 401s during a backoff doesn't skip it", async () => {
    const h = harness({ replies: ["rate_limited"] });
    h.s.start(h.mint());
    h.sleep(FRESH_MS + 1);
    expect(await h.s.onUnauthorized("tok-1")).toBe("give_up");
    for (let i = 0; i < 100; i++) await h.s.onUnauthorized("tok-1");
    expect(h.calls.length).toBe(1);
    expect(h.s.status().nextRefreshAt).toBe(h.now() + BACKOFF_429_MS);
  });

  test("100 REST 401s in a row cost at most one /token call per cap interval", async () => {
    const h = harness();
    h.s.start(h.mint());
    h.sleep(FRESH_MS + 1);
    // Every token is "refused": the caller hammers onUnauthorized with whatever it last used.
    for (let i = 0; i < 100; i++) {
      await h.s.onUnauthorized(h.s.current() ?? `tok-${h.calls.length + 1}`);
      await h.runUntil(h.now() + 1_000);
    }
    // 100 s of hammering: the first refresh, then nothing until the cap.
    expect(h.calls.length).toBeLessThanOrEqual(2);
  });

  test("stop() drops an in-flight answer and cancels timers", async () => {
    const h = harness({ replies: ["hang"] });
    h.s.start(h.mint());
    const p = h.s.refresh();
    h.s.stop();
    await h.release();
    expect(await p).toBe(false);
    expect(h.s.current()).toBeNull();
    expect(h.s.running).toBe(false);
    expect(h.timers()).toEqual([]);
    expect(await h.s.refresh()).toBe(false);
    expect(await h.s.onUnauthorized("tok-2")).toBe("give_up");
  });
});

describe("TokenScheduler: throttled and suspended timers", () => {
  test("visible after a long sleep: re-checks the clock and refreshes at once", async () => {
    const h = harness();
    h.s.start(h.mint());
    // The laptop sleeps for 3 hours: no timer fires.
    h.sleep(3 * HOUR);
    expect(h.calls).toEqual([]);
    h.s.wake("visible");
    await h.flush();
    expect(h.calls).toEqual([T0 + 3 * HOUR]);
    expect(h.s.current()).toBe("tok-2");
  });

  test("a throttled timer that fires late is judged by the clock, not by its delay", async () => {
    const h = harness();
    h.s.start(h.mint());
    // Background throttling: the first (≤60 s) timer only fires 49 min later.
    const t = h.timers()[0]!;
    h.sleep(49 * 60_000);
    expect(h.calls).toEqual([]);
    h.sleep(2 * 60_000);
    // It fires now (late): 51 min in, past the 50-min mark: refresh.
    (h.timers().splice(0, 1)[0] ?? t).fn();
    await h.flush();
    expect(h.calls.length).toBe(1);
  });

  test("visible before anything is due: nothing happens", async () => {
    const h = harness();
    h.s.start(h.mint());
    h.sleep(10 * 60_000);
    h.s.wake("visible");
    await h.flush();
    expect(h.calls).toEqual([]);
    expect(h.timers().length).toBe(1);
  });

  test("online after a network failure: retry at once instead of waiting out the backoff", async () => {
    const h = harness({ replies: ["network", "network", "network", "network"] });
    h.s.start(h.mint());
    await h.runUntil(T0 + (HOUR * 5) / 6 + 5_000 + 10_000);
    const n = h.calls.length;
    h.s.wake("online");
    await h.flush();
    expect(h.calls.length).toBe(n + 1);
  });

  test("online after a server error: keeps the backoff", async () => {
    const h = harness({ replies: ["server"] });
    h.s.start(h.mint());
    await h.runUntil(T0 + (HOUR * 5) / 6);
    h.s.wake("online");
    await h.flush();
    expect(h.calls.length).toBe(1);
  });

  test("waking during a /token call doesn't start another", async () => {
    const h = harness({ replies: ["hang"] });
    h.s.start(h.mint());
    h.sleep(HOUR);
    h.s.wake("visible");
    h.s.wake("online");
    h.s.wake("visible");
    await h.flush();
    expect(h.calls.length).toBe(1);
  });

  test("needsReauth + a sleep past exp: waking reports the expiry", async () => {
    const h = harness({ replies: ["wrong_credentials"] });
    h.s.start(h.mint());
    await h.runUntil(T0 + (HOUR * 5) / 6);
    const before = h.changes();
    h.sleep(HOUR);
    h.s.wake("visible");
    expect(h.changes()).toBe(before + 1);
    expect(h.calls.length).toBe(1);
  });
});
