import { describe, expect, test } from "bun:test";
import { corrupt, DevKnobs } from "./debug";
import { loginError, type Token } from "./openf1";
import { FakeClock } from "../testkit";
import { Budget } from "./budget";
import { RETRIES_429, Rest, RestError, restUrl, retryAfterMs, type RestFetch, type TokenSource } from "./rest";
import { TokenScheduler } from "./scheduler";

const buf = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;

describe("restUrl", () => {
  test("endpoint and params, comparison suffixes written OpenF1's way", () => {
    expect(restUrl("sessions", {})).toBe("https://api.openf1.org/v1/sessions");
    expect(restUrl("sessions", { session_key: "latest" })).toBe("https://api.openf1.org/v1/sessions?session_key=latest");
    expect(restUrl("laps", { session_key: 9161, driver_number: 1, "lap_number>=": 3, "lap_number<": 10 })).toBe(
      "https://api.openf1.org/v1/laps?session_key=9161&driver_number=1&lap_number>=3&lap_number<10",
    );
    expect(restUrl("car_data", { "date>": "2023-09-16T13:03:35.200+00:00" })).toBe("https://api.openf1.org/v1/car_data?date>2023-09-16T13%3A03%3A35.200%2B00%3A00");
    expect(restUrl("sessions", { session_name: "Sprint Qualifying" })).toBe("https://api.openf1.org/v1/sessions?session_name=Sprint%20Qualifying");
    // What a browser actually sends: < and > percent-encoded, which OpenF1 decodes.
    expect(new URL(restUrl("laps", { "lap_number>=": 3 })).href).toBe("https://api.openf1.org/v1/laps?lap_number%3E=3");
  });
});

/** A fake OpenF1: 401 unless the bearer token is in `valid`; records what was sent. */
function fakeApi(valid: Set<string>, opts: { publicOk?: boolean } = {}) {
  const seen: { url: string; auth: string | undefined }[] = [];
  const fetch: RestFetch = async (url, init) => {
    const auth = init.headers.Authorization;
    seen.push({ url, auth });
    expect(init.credentials).toBe("omit");
    const token = auth?.replace(/^Bearer /, "");
    const ok = token ? valid.has(token) : opts.publicOk !== false;
    return { status: ok ? 200 : 401, arrayBuffer: async () => buf(ok ? "[{}]" : '{"detail":"Invalid ID token"}') };
  };
  return { fetch, seen };
}

describe("Rest", () => {
  test("authenticated with a valid token; unauthenticated without one", async () => {
    let tok: string | null = "good";
    const tokens: TokenSource = { current: () => tok, onUnauthorized: async () => "give_up" };
    const api = fakeApi(new Set(["good"]));
    const rest = new Rest(api.fetch, tokens);
    const r = await rest.get("sessions", { session_key: "latest" });
    expect(r.status).toBe(200);
    expect(r.auth).toBe(true);
    expect(new TextDecoder().decode(r.body)).toBe("[{}]");
    expect(api.seen[0]!.auth).toBe("Bearer good");
    tok = null;
    const u = await rest.get("sessions", {});
    expect(u).toMatchObject({ status: 200, auth: false });
    expect(api.seen[1]!.auth).toBeUndefined();
  });

  test("401: onUnauthorized, then one retry with the new token", async () => {
    let tok = "old";
    const calls: string[] = [];
    const tokens: TokenSource = {
      current: () => tok,
      onUnauthorized: async (used) => (calls.push(used), (tok = "new"), "retry"),
    };
    const api = fakeApi(new Set(["new"]));
    const r = await new Rest(api.fetch, tokens).get("laps", {});
    expect(r).toMatchObject({ status: 200, auth: true });
    expect(calls).toEqual(["old"]);
    expect(api.seen.map((s) => s.auth)).toEqual(["Bearer old", "Bearer new"]);
  });

  test("401 and give_up: the 401 goes back to the caller, no retry", async () => {
    const tokens: TokenSource = { current: () => "bad", onUnauthorized: async () => "give_up" };
    const api = fakeApi(new Set());
    expect((await new Rest(api.fetch, tokens).get("laps", {})).status).toBe(401);
    expect(api.seen.length).toBe(1);
  });

  test("a retry that 401s again is returned, not retried again", async () => {
    let n = 0;
    const tokens: TokenSource = { current: () => `t${n}`, onUnauthorized: async () => (n++, "retry") };
    const api = fakeApi(new Set());
    expect((await new Rest(api.fetch, tokens).get("laps", {})).status).toBe(401);
    expect(api.seen.length).toBe(2);
  });

  test("requests run in parallel (the budget, when there is one, decides when each starts)", async () => {
    let active = 0;
    let peak = 0;
    const fetch: RestFetch = async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 2));
      active--;
      return { status: 200, arrayBuffer: async () => buf("[]") };
    };
    const rest = new Rest(fetch, { current: () => null, onUnauthorized: async () => "give_up" });
    await Promise.all([1, 2, 3, 4].map((k) => rest.get("laps", { session_key: k })));
    expect(peak).toBe(4);
  });

  test("a network failure rejects with RestError and doesn't block the queue", async () => {
    let fail = true;
    const fetch: RestFetch = async () => {
      if (fail) throw new TypeError("Failed to fetch");
      return { status: 200, arrayBuffer: async () => buf("[]") };
    };
    const rest = new Rest(fetch, { current: () => null, onUnauthorized: async () => "give_up" });
    const a = rest.get("laps", {});
    fail = true;
    await expect(a).rejects.toBeInstanceOf(RestError);
    fail = false;
    expect((await rest.get("laps", {})).status).toBe(200);
  });
});

describe("dev knobs (debug.ts) with a real scheduler", () => {
  function setup() {
    let now = 1_000_000;
    let n = 0;
    const minted = new Set<string>();
    const mint = (): Token => {
      const t = `eyJhbGciOiJSUzI1NiJ9.eyJwYXlsb2FkIjoxfQ.signature-number-${++n}-abcdefghijklmnop`;
      minted.add(t);
      return { accessToken: t, issuedAt: now, expiresAt: now + 3_600_000 };
    };
    let fail = false;
    const scheduler = new TokenScheduler({
      now: () => now,
      setTimeout: () => 0,
      clearTimeout: () => {},
      random: () => 0.5,
      onChange: () => {},
      fetchToken: async () => (fail ? { ok: false, error: loginError("server") } : { ok: true, token: knobs.filter(mint()) }),
    });
    const knobs: DevKnobs = new DevKnobs(scheduler, 0, () => ({ state: "connected" }));
    const api = fakeApi(minted);
    const rest = new Rest(api.fetch, knobs.tokens());
    return { scheduler, knobs, rest, api, mint, advance: (ms: number) => (now += ms), setFail: (f: boolean) => (fail = f) };
  }

  test("corrupt changes one character that isn't the last", () => {
    const t = "eyJhbGciOiJSUzI1NiJ9.eyJ4IjoxfQ.c2lnbmF0dXJlLXNpZ25hdHVyZS1zaWduYXR1cmU";
    const c = corrupt(t);
    expect(c).not.toBe(t);
    expect(c.length).toBe(t.length);
    expect([...c].filter((ch, i) => ch !== t[i]).length).toBe(1);
    expect(c.at(-1)).toBe(t.at(-1));
  });

  test("spoilToken: the next get 401s for real, refreshes, and succeeds on the retry", async () => {
    const v = setup();
    v.scheduler.start(v.mint());
    v.advance(30_000);
    expect((await v.rest.get("sessions", {})).status).toBe(200);
    await v.knobs.handle({ v: 1, id: 1, type: "debug:spoilToken" });
    const r = await v.rest.get("sessions", { session_key: "latest" });
    expect(r).toMatchObject({ status: 200, auth: true });
    expect(v.api.seen.slice(1).map((s) => s.auth !== undefined && v.api.seen[0]!.auth !== s.auth)).toEqual([true, true]);
    expect(v.scheduler.status().refreshCount).toBe(1);
    // The spoil is over: the new token is sent as is.
    expect((await v.rest.get("sessions", {})).status).toBe(200);
    expect(v.api.seen.length).toBe(4);
  });

  test("spoil right after a refresh: the fresh-token guard gives up (401 to the caller), then unauthenticated", async () => {
    const v = setup();
    v.scheduler.start(v.mint());
    await v.knobs.handle({ v: 1, id: 1, type: "debug:spoilToken" });
    expect((await v.rest.get("sessions", {})).status).toBe(401);
    expect(await v.rest.get("sessions", {})).toMatchObject({ status: 200, auth: false });
  });

  test("fakeExpiry shortens new tokens (never lengthens them)", async () => {
    const v = setup();
    await v.knobs.handle({ v: 1, id: 1, type: "debug:fakeExpiry", seconds: 120 });
    v.scheduler.start(v.knobs.filter(v.mint()));
    expect(v.scheduler.status()).toMatchObject({ tokenExpiresAt: 1_000_000 + 120_000, nextRefreshAt: 1_000_000 + 100_000 });
    await v.knobs.handle({ v: 1, id: 2, type: "debug:fakeExpiry", seconds: 3600 });
    expect(v.knobs.filter({ accessToken: "x", issuedAt: 0, expiresAt: 60_000 }).expiresAt).toBe(60_000);
    await v.knobs.handle({ v: 1, id: 3, type: "debug:fakeExpiry", seconds: 0 });
    expect(v.knobs.filter({ accessToken: "x", issuedAt: 0, expiresAt: 3_600_000 }).expiresAt).toBe(3_600_000);
  });

  test("failToken: the next N /token calls fail without reaching OpenF1", async () => {
    const knobs = new DevKnobs({} as TokenScheduler, 0, () => ({}));
    let real = 0;
    const f = knobs.tokenFetch(async () => (real++, { status: 200, text: async () => "{}" }));
    const init = { method: "POST", headers: {}, body: "", credentials: "omit", referrerPolicy: "no-referrer" } as const;
    await knobs.handle({ v: 1, id: 1, type: "debug:failToken", status: 503, times: 2 });
    expect((await f("https://api.openf1.org/token", init)).status).toBe(503);
    expect((await f("https://example.invalid/other", init)).status).toBe(200);
    expect((await f("https://api.openf1.org/token", init)).status).toBe(503);
    expect((await f("https://api.openf1.org/token", init)).status).toBe(200);
    expect(real).toBe(2);
    await knobs.handle({ v: 1, id: 2, type: "debug:failToken", status: 401, times: 1 });
    expect((await f("https://api.openf1.org/token", init)).status).toBe(401);
  });

  test("refreshNow goes through the scheduler", async () => {
    const v = setup();
    v.scheduler.start(v.mint());
    await v.knobs.handle({ v: 1, id: 1, type: "debug:refreshNow" });
    expect(v.scheduler.status().refreshCount).toBe(1);
    v.setFail(true);
    await v.knobs.handle({ v: 1, id: 2, type: "debug:refreshNow" });
    expect(v.scheduler.status()).toMatchObject({ refresh: "retrying", lastRefresh: { ok: false, error: "server" } });
  });
});

describe("Rest with the budget", () => {
  const budgeted = (fetch: RestFetch, token: () => string | null = () => "good", onUnauthorized: TokenSource["onUnauthorized"] = async () => "give_up") => {
    const clock = new FakeClock();
    const budget = new Budget({ now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, random: () => 0.5, authenticated: () => token() !== null });
    return { clock, budget, rest: new Rest(fetch, { current: token, onUnauthorized }, undefined, budget) };
  };

  test("each request (the 401 retry too) waits for the budget; the token is read once it may start", async () => {
    const api = fakeApi(new Set(["new"]));
    let tok = "old";
    const at: number[] = [];
    const x = budgeted(
      async (u, i) => (at.push(x.clock.t), api.fetch(u, i)),
      () => tok,
      async () => ((tok = "new"), "retry"),
    );
    const all = Promise.all([x.rest.get("laps", {}, { caller: "a" }), x.rest.get("laps", {}, { caller: "a" })]);
    await x.clock.advance(5_000);
    const rs = await all;
    expect(rs.map((r) => r.status)).toEqual([200, 200]);
    expect(at.length).toBeGreaterThanOrEqual(3);
    const gaps = at.slice(1).map((t, i) => t - at[i]!);
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(Math.floor(1150 / 6));
    expect(x.budget.status().started).toBe(at.length);
  });

  test("a 429 pauses the budget and is retried after it; a persistent one goes back to the caller", async () => {
    let n = 0;
    const x = budgeted(async () => ({ status: ++n <= 1 ? 429 : 200, arrayBuffer: async () => buf("[]") }));
    const r = x.rest.get("laps", {}, { caller: "a" });
    await x.clock.advance(10_000);
    expect((await r).status).toBe(200);
    expect(n).toBe(2);
    expect(x.budget.status().rateLimited).toBe(1);
    const always = budgeted(async () => ({ status: 429, arrayBuffer: async () => buf("") }));
    const r2 = always.rest.get("laps", {}, { caller: "a" });
    await always.clock.advance(600_000);
    expect((await r2).status).toBe(429);
    expect(always.budget.status().rateLimited).toBe(RETRIES_429 + 1);
  });

  test("Retry-After (seconds or a date) when the response lets us read it", async () => {
    expect(retryAfterMs("3")).toBe(3000);
    expect(retryAfterMs(null)).toBeUndefined();
    expect(retryAfterMs("0")).toBeUndefined();
    expect(retryAfterMs(new Date(10_000).toUTCString(), 4_000)).toBe(6_000);
    const x = budgeted(async () => ({ status: 429, arrayBuffer: async () => buf(""), headers: { get: (h: string) => (h === "retry-after" ? "9" : null) } }));
    const t0 = x.clock.t;
    void x.rest.get("laps", {}, { caller: "a" }).catch(() => {});
    await x.clock.advance(1);
    expect(x.budget.status().pausedUntil).toBe(t0 + 9_000);
  });

  test("the request timeout reaches fetch (live gap-fills get a short one)", async () => {
    const seen: number[] = [];
    const rest = new Rest(async (_u, i) => (seen.push(i.timeoutMs), { status: 200, arrayBuffer: async () => buf("[]") }), { current: () => null, onUnauthorized: async () => "give_up" });
    await rest.get("laps", {}, { caller: "live", priority: "live", timeoutMs: 30_000 });
    await rest.get("laps", {});
    expect(seen).toEqual([30_000, 120_000]);
  });
});
