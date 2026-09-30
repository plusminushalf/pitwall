import { describe, expect, test } from "bun:test";
import { corrupt, DevKnobs } from "./debug";
import { loginError, type Token } from "./openf1";
import { ANON_LIMIT, AUTH_LIMIT, Pacer, Rest, RestError, restUrl, type RestFetch, type TokenSource } from "./rest";
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

  test("one request at a time, in order", async () => {
    let active = 0;
    let peak = 0;
    const order: string[] = [];
    const fetch: RestFetch = async (url) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 2));
      active--;
      order.push(url.split("?")[1]!);
      return { status: 200, arrayBuffer: async () => buf("[]") };
    };
    const rest = new Rest(fetch, { current: () => null, onUnauthorized: async () => "give_up" });
    await Promise.all([1, 2, 3, 4].map((k) => rest.get("laps", { session_key: k })));
    expect(peak).toBe(1);
    expect(order).toEqual(["session_key=1", "session_key=2", "session_key=3", "session_key=4"]);
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

describe("Pacer (the REST budget)", () => {
  const clockAt = () => {
    let t = 0;
    const sleeps: number[] = [];
    return { now: () => t, sleep: async (ms: number) => void (sleeps.push(ms), (t += ms)), sleeps, get t() { return t; } };
  };
  test("spaces request starts 1/perSecond apart: no bursts", async () => {
    const c = clockAt();
    const p = new Pacer(c);
    const starts: number[] = [];
    for (let i = 0; i < 7; i++) {
      await p.take(AUTH_LIMIT);
      starts.push(c.now());
    }
    const gaps = starts.slice(1).map((x, i) => x - starts[i]!);
    expect(gaps.every((g) => g >= 1000 / 6 - 1)).toBe(true);
    // Never more than 6 starts in any second.
    for (const s of starts) expect(starts.filter((x) => x >= s && x < s + 1000).length).toBeLessThanOrEqual(6);
  });
  test("at most perMinute starts in any 60 s; unauthenticated is half", async () => {
    const c = clockAt();
    const p = new Pacer(c);
    const starts: number[] = [];
    for (let i = 0; i < 35; i++) {
      await p.take(ANON_LIMIT);
      starts.push(c.now());
    }
    for (const s of starts) expect(starts.filter((x) => x >= s && x < s + 60_000).length).toBeLessThanOrEqual(30);
    expect(starts[30]! - starts[0]!).toBeGreaterThanOrEqual(60_000);
  });
  test("Rest waits for the budget before each request (the 401 retry too)", async () => {
    const c = clockAt();
    const api = fakeApi(new Set(["good"]));
    const at: number[] = [];
    const rest = new Rest(async (u, i) => (at.push(c.now()), api.fetch(u, i)), { current: () => "good", onUnauthorized: async () => "give_up" }, undefined, new Pacer(c));
    await Promise.all([rest.get("laps", {}), rest.get("laps", {}), rest.get("laps", {})]);
    expect(at.length).toBe(3);
    expect(at[2]! - at[0]!).toBeGreaterThanOrEqual(2 * (1000 / 6) - 1);
  });
});
