import { describe, expect, test } from "bun:test";
import { FakeClock, settle } from "../testkit";
import { Budget, BudgetError, LIVE_RESERVE, MAX_IN_FLIGHT, PAUSE_429_BASE_MS, PER_CALLER_IN_FLIGHT, PER_CALLER_QUEUE, SHRINK_MS, type Priority, type Slot } from "./budget";
import { SPACING } from "./rest";

function setup(opts: { auth?: boolean } = {}) {
  const clock = new FakeClock();
  let auth = opts.auth ?? true;
  let changes = 0;
  const budget = new Budget({ now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, random: () => 0.5, authenticated: () => auth, onChange: () => changes++ });
  /** Every start: [time, caller, tag]. */
  const starts: [number, string, string][] = [];
  const slots: Slot[] = [];
  /** Queue a request; it holds its slot until released (by hand, or `hold` ms after it starts). */
  const req = (caller: string, tag = "", priority: Priority = "normal", hold: number | null = 0) =>
    budget.acquire(caller, priority).then((s) => {
      starts.push([clock.t, caller, tag]);
      slots.push(s);
      if (hold !== null) clock.setTimeout(() => s.release({ status: 200 }), hold);
      return s;
    });
  return { clock, budget, starts, slots, req, setAuth: (a: boolean) => (auth = a), changes: () => changes };
}

/** The most starts in any window of `ms`. */
const peak = (times: number[], ms: number) => Math.max(0, ...times.map((t) => times.filter((x) => x >= t && x < t + ms).length));

describe("the rate limits (fake clock)", () => {
  test("with a token: 6/s and 60/min, starts spaced, no bursts", async () => {
    const x = setup();
    for (let i = 0; i < 70; i++) void x.req("dl", String(i), "normal", 500);
    await x.clock.advance(120_000);
    const t = x.starts.map((s) => s[0]);
    expect(t.length).toBe(70);
    expect(peak(t, 1000)).toBeLessThanOrEqual(6);
    expect(peak(t, 60_000)).toBeLessThanOrEqual(60);
    const gaps = t.slice(1).map((v, i) => v - t[i]!);
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(Math.floor(SPACING / 6));
    // The first 60 go in about 60 x 192 ms; the 61st waits for the first minute to roll over.
    expect(t[59]! - t[0]!).toBeLessThan(12_000);
    expect(t[60]! - t[0]!).toBeGreaterThanOrEqual(60_000);
  });

  test("without a token: 3/s and 30/min", async () => {
    const x = setup({ auth: false });
    for (let i = 0; i < 35; i++) void x.req("dl", String(i), "normal", 300);
    await x.clock.advance(120_000);
    const t = x.starts.map((s) => s[0]);
    expect(t.length).toBe(35);
    expect(peak(t, 1000)).toBeLessThanOrEqual(3);
    expect(peak(t, 60_000)).toBeLessThanOrEqual(30);
    expect(t[30]! - t[0]!).toBeGreaterThanOrEqual(60_000);
    expect(x.budget.status()).toMatchObject({ auth: false, perSecond: 3, perMinute: 30 });
  });

  test("in parallel: requests overlap, at most MAX_IN_FLIGHT at once, PER_CALLER_IN_FLIGHT per caller", async () => {
    const x = setup();
    let live = 0;
    let most = 0;
    for (let i = 0; i < 20; i++)
      void x.budget.acquire(i % 2 ? "a" : "b").then((s) => {
        live++;
        most = Math.max(most, live);
        x.clock.setTimeout(() => (live--, s.release({ status: 200 })), 5_000);
      });
    await x.clock.advance(3_000);
    expect(x.budget.status().inFlight).toBe(MAX_IN_FLIGHT);
    await x.clock.advance(60_000);
    expect(most).toBe(MAX_IN_FLIGHT);
    const one = setup();
    for (let i = 0; i < 10; i++) void one.req("solo", "", "normal", null);
    await one.clock.advance(10_000);
    expect(one.budget.status()).toMatchObject({ inFlight: PER_CALLER_IN_FLIGHT, queued: 10 - PER_CALLER_IN_FLIGHT });
    one.slots[0]!.release({ status: 200 });
    await one.clock.advance(1_000);
    expect(one.budget.status().inFlight).toBe(PER_CALLER_IN_FLIGHT);
  });

  test("status: in flight, queued, used this minute; the minute slides", async () => {
    const x = setup();
    for (let i = 0; i < 3; i++) void x.req("dl", "", "normal", null);
    await x.clock.advance(1_000);
    expect(x.budget.status()).toMatchObject({ auth: true, perSecond: 6, perMinute: 60, inFlight: 3, queued: 0, usedThisMinute: 3, callers: 1, started: 3 });
    for (const s of x.slots) s.release({ status: 200 });
    await x.clock.advance(60_000);
    expect(x.budget.status()).toMatchObject({ inFlight: 0, usedThisMinute: 0, callers: 0, started: 3 });
    expect(x.changes()).toBeGreaterThan(0);
  });
});

describe("priorities and fairness", () => {
  test("live gap-fills go before queued downloads", async () => {
    const x = setup();
    for (let i = 0; i < 20; i++) void x.req("dl", `d${i}`);
    await x.clock.advance(1);
    for (let i = 0; i < 3; i++) void x.req("live", `l${i}`, "live");
    await x.clock.advance(2_000);
    const order = x.starts.map((s) => s[2]);
    const firstLive = order.indexOf("l0");
    expect(order.slice(firstLive, firstLive + 3)).toEqual(["l0", "l1", "l2"]);
    expect(firstLive).toBeLessThanOrEqual(1); // right after the one that started when they were queued
  });

  test("while the stream runs, downloads leave LIVE_RESERVE of the minute for gap-fills", async () => {
    const x = setup();
    x.budget.setReserve(true);
    for (let i = 0; i < 60; i++) void x.req("dl", `d${i}`);
    await x.clock.advance(20_000);
    expect(x.starts.length).toBe(60 - LIVE_RESERVE);
    for (let i = 0; i < 14; i++) void x.req("live", `l${i}`, "live");
    await x.clock.advance(5_000);
    expect(x.starts.filter((s) => s[1] === "live").length).toBe(14); // not waiting for the minute
    expect(peak(x.starts.map((s) => s[0]), 60_000)).toBeLessThanOrEqual(60);
    x.budget.setReserve(false);
    await x.clock.advance(60_000);
    expect(x.starts.length).toBe(74);
  });

  test("callers take turns: a caller with 50 queued doesn't starve one with 2", async () => {
    const x = setup();
    for (let i = 0; i < 50; i++) void x.req("greedy", `g${i}`);
    await x.clock.advance(1);
    void x.req("app", "a0");
    void x.req("app", "a1");
    await x.clock.advance(3_000);
    const order = x.starts.map((s) => s[2]);
    expect(order.indexOf("a0")).toBeLessThanOrEqual(2);
    expect(order.indexOf("a1") - order.indexOf("a0")).toBe(2); // one greedy start between them
  });

  test("a misbehaving caller can't queue without bound, or burn more than the account's limit", async () => {
    const x = setup();
    const rejected: unknown[] = [];
    for (let i = 0; i < PER_CALLER_QUEUE + 20; i++) x.budget.acquire("bad").then((s) => s.release({ status: 200 }), (e) => rejected.push(e));
    await settle();
    expect(rejected.length).toBe(19); // (the first one started at once: 128 queued behind it)
    expect(rejected.every((e) => e instanceof BudgetError && e.code === "rate_limited")).toBe(true);
    // Everyone else still gets through, and the total stays at 60/min.
    for (let i = 0; i < 5; i++) void x.req("good", `ok${i}`);
    await x.clock.advance(60_000);
    expect(x.starts.filter((s) => s[1] === "good").length).toBe(5);
    x.budget.cancel("bad");
  });

  test("cancel: a closed port's queued requests are dropped; in-flight ones finish", async () => {
    const x = setup();
    const errs: unknown[] = [];
    for (let i = 0; i < 10; i++) x.budget.acquire("w:p1").then((s) => x.slots.push(s), (e) => errs.push(e));
    await x.clock.advance(1_000);
    expect(x.budget.status().inFlight).toBe(PER_CALLER_IN_FLIGHT);
    expect(x.budget.cancelPrefix("w:")).toBe(10 - PER_CALLER_IN_FLIGHT);
    await settle();
    expect(errs.length).toBe(10 - PER_CALLER_IN_FLIGHT);
    expect((errs[0] as BudgetError).code).toBe("cancelled");
    for (const s of x.slots) s.release({ status: 200 });
    expect(x.budget.status()).toMatchObject({ inFlight: 0, queued: 0, callers: 0 });
  });
});

describe("429", () => {
  test("pause everything (backoff doubling), halve the limits for a minute, then back to normal", async () => {
    const x = setup();
    const s = await x.budget.acquire("dl");
    x.clock.t += 100;
    s.release({ status: 429 });
    const st = x.budget.status();
    expect(st).toMatchObject({ perSecond: 3, perMinute: 30, rateLimited: 1 });
    expect(st.pausedUntil).toBe(x.clock.t + PAUSE_429_BASE_MS);
    expect(st.shrunkUntil).toBe(x.clock.t + SHRINK_MS);
    void x.req("dl", "after", "normal", null);
    await x.clock.advance(PAUSE_429_BASE_MS - 1);
    expect(x.starts.length).toBe(0);
    await x.clock.advance(1);
    expect(x.starts.length).toBe(1);
    // A second 429 in a row: twice the pause.
    x.slots[0]!.release({ status: 429 });
    expect(x.budget.status().pausedUntil).toBe(x.clock.t + 2 * PAUSE_429_BASE_MS);
    // Shrunk: at most 30 in the next minute.
    for (let i = 0; i < 40; i++) void x.req("dl", `s${i}`);
    await x.clock.advance(SHRINK_MS - 1_000);
    expect(x.starts.filter((v) => v[2].startsWith("s")).length).toBeLessThanOrEqual(30);
    await x.clock.advance(62_000);
    expect(x.budget.status()).toMatchObject({ perSecond: 6, perMinute: 60 });
    expect(x.budget.status().shrunkUntil).toBeUndefined();
  });

  test("Retry-After, when readable, sets the pause", async () => {
    const x = setup();
    const s = await x.budget.acquire("dl");
    s.release({ status: 429, retryAfterMs: 7_000 });
    expect(x.budget.status().pausedUntil).toBe(x.clock.t + 7_000);
  });

  test("a success after a 429 resets the doubling", async () => {
    const x = setup();
    const take = async () => {
      const p = x.budget.acquire("dl");
      await x.clock.advance(5_000);
      return p;
    };
    (await take()).release({ status: 429 });
    (await take()).release({ status: 200 });
    (await take()).release({ status: 429 });
    expect(x.budget.status().pausedUntil).toBe(x.clock.t + PAUSE_429_BASE_MS);
  });
});

describe("takeover", () => {
  test("a new leader seeds the previous leader's starts: the minute's budget stays one budget", async () => {
    const old = setup();
    for (let i = 0; i < 50; i++) void old.req("dl");
    await old.clock.advance(15_000);
    const seedStarts = old.budget.recentStarts();
    expect(seedStarts.length).toBe(50);
    const x = setup();
    x.clock.t = old.clock.t;
    x.budget.seed(seedStarts);
    x.budget.seed(seedStarts); // (twice: no double counting)
    for (let i = 0; i < 20; i++) void x.req("dl");
    await x.clock.advance(10_000);
    expect(x.starts.length).toBe(10);
    expect(x.budget.status().usedThisMinute).toBe(60);
  });
});
