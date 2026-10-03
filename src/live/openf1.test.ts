// The OpenF1 follower shared by the relay and the browser (./openf1.ts): when it goes live, what it fetches, how the
// feed and the backfill fit together, and when a session is over. The transport is faked.

import { describe, expect, test } from "bun:test";
import { AuthError } from "../../scripts/lib/openf1Http";
import type { RawSession } from "../../scripts/lib/openf1Types";
import type { LiveSink, StatusPatch } from "./hub";
import { backfill, finished, OpenF1Live, TELEMETRY_PIECE_MS, type FeedHooks, type Params } from "./openf1";
import type { LiveState } from "./protocol";
import { LiveStore, type Rec } from "./store";

const MIN = 60_000;
const now = Date.parse("2026-10-04T07:20:00Z");
const race: RawSession = {
  session_key: 11731,
  meeting_key: 1300,
  session_name: "Race",
  session_type: "Race",
  date_start: "2026-10-04T07:00:00+00:00",
  date_end: "2026-10-04T09:00:00+00:00",
  year: 2026,
  circuit_short_name: "Sakhir",
  country_name: "Bahrain",
  location: "Sakhir",
  gmt_offset: "03:00:00",
};
const iso = (t: number) => new Date(t).toISOString();

/** A LiveSink that records what the follower does with it. */
function sink() {
  const s = {
    state: "idle" as LiveState,
    session: null,
    log: [] as string[],
    status: {} as StatusPatch,
    stores: [] as LiveStore[],
    setStatus(p: StatusPatch) {
      if (p.state) s.state = p.state;
      Object.assign(s.status, p);
      s.log.push(`status ${p.state ?? "-"}${p.detail ? `: ${p.detail}` : ""}`);
    },
    startSession(store: LiveStore) {
      s.stores.push(store);
      s.state = "live";
      s.log.push("start");
    },
    endSession(detail?: string) {
      s.state = "ended";
      s.log.push(`end${detail ? `: ${detail}` : ""}`);
    },
  };
  return s satisfies LiveSink;
}

/** OpenF1's REST over a few rows: `session_key=latest`, `year`, `date>` / `date<=` like OpenF1. */
function api(rows: Record<string, Rec[]>, latest: RawSession | null = race) {
  const calls: [string, Params][] = [];
  const rest = async <T,>(endpoint: string, params: Params): Promise<T[]> => {
    calls.push([endpoint, params]);
    await Bun.sleep(1);
    if (endpoint === "sessions" && params.session_key === "latest") return (latest ? [latest] : []) as T[];
    let out = rows[endpoint] ?? [];
    const after = params["date>"];
    const upTo = params["date<="];
    if (after != null) out = out.filter((r) => Date.parse(r.date) > Date.parse(String(after)));
    if (upTo != null) out = out.filter((r) => Date.parse(r.date) <= Date.parse(String(upTo)));
    return out as T[];
  };
  return { rest, calls };
}

/** A feed that hands its hooks to the test. */
function feeds() {
  const made: { hooks: FeedHooks; started: boolean; stopped: boolean }[] = [];
  const feed = (_store: LiveStore, hooks: FeedHooks) => {
    const f = { hooks, started: false, stopped: false };
    made.push(f);
    return {
      start: async () => {
        f.started = true;
      },
      stop: () => {
        f.stopped = true;
      },
    };
  };
  return { made, feed };
}

const quiet = { log: () => {}, warn: () => {} };
const car = (n: number, t: number) => ({ session_key: 11731, driver_number: n, date: iso(t), speed: 200, rpm: 11000, n_gear: 7, throttle: 100, brake: 0, drs: 0 });

describe("OpenF1Live", () => {
  test("in the live window: subscribe first, backfill, apply what arrived meanwhile, then stream", async () => {
    const hub = sink();
    const { rest, calls } = api({
      meetings: [{ meeting_key: 1300, meeting_name: "Bahrain Grand Prix", circuit_info_url: "https://example.invalid/c.json" }],
      drivers: [1, 44].map((n) => ({ session_key: 11731, driver_number: n, name_acronym: `D${n}` })),
      car_data: [car(1, now - 2 * MIN)],
    });
    const { made, feed } = feeds();
    const live = new OpenF1Live(hub, { rest, circuit: async () => ({}) as never, feed, now: () => now, ...quiet });
    // A message during the backfill waits for it.
    const poll = live.poll();
    while (!made.length) await Bun.sleep(1);
    made[0].hooks.deliver("car_data", car(44, now - 1000));
    await poll;
    expect(made[0].started).toBe(true);
    expect(hub.log[0]).toBe("status connecting: backfilling from OpenF1");
    expect(hub.log.at(-1)).toBe("start");
    const store = hub.stores[0];
    expect(store.sessionKey).toBe(11731);
    expect(store.t0).toBe(Date.parse(race.date_start) - 10 * MIN);
    expect(store.list("drivers")).toHaveLength(2);
    expect(store.samples.get(1)?.car.t).toHaveLength(1);
    expect(store.samples.get(44)?.car.t).toHaveLength(1);
    // After that, straight into the store.
    made[0].hooks.deliver("car_data", car(44, now));
    expect(store.samples.get(44)?.car.t).toHaveLength(2);
    expect(calls.some(([e, p]) => e === "meetings" && p.meeting_key === 1300)).toBe(true);
    await live.shutdown();
    expect(made[0].stopped).toBe(true);
  });

  test("free practice is followed too; qualifying and testing aren't", async () => {
    for (const [s, follows] of [
      [{ ...race, session_type: "Practice", session_name: "Practice 3" }, true],
      [{ ...race, session_type: "Qualifying", session_name: "Qualifying" }, false],
      [{ ...race, session_type: "Practice", session_name: "Day 2" }, false],
    ] as const) {
      const hub = sink();
      const { rest } = api({}, s);
      const live = new OpenF1Live(hub, { rest, circuit: async () => ({}) as never, feed: feeds().feed, now: () => now, ...quiet });
      await live.poll();
      expect(hub.stores.length).toBe(follows ? 1 : 0);
      await live.shutdown();
    }
  });

  test("outside the window: idle, with the next race, sprint or practice", async () => {
    const hub = sink();
    const next = { ...race, session_key: 11800, session_type: "Practice", session_name: "Practice 1", location: "Lusail", date_start: "2026-10-23T10:30:00+00:00", date_end: "2026-10-23T11:30:00+00:00" };
    const { rest, calls } = api({ sessions: [race, next] }, { ...race, date_start: "2026-10-04T12:00:00+00:00", date_end: "2026-10-04T14:00:00+00:00" });
    const live = new OpenF1Live(hub, { rest, circuit: async () => ({}) as never, feed: feeds().feed, now: () => now + 3 * 60 * MIN, ...quiet });
    // (The fake's `year` query returns both: the race has started by then, so the practice is next.)
    await live.poll();
    expect(hub.state).toBe("idle");
    expect(hub.status.next).toEqual({ sessionKey: 11800, name: "Lusail Practice 1", dateStart: next.date_start });
    expect(calls.find(([e, p]) => e === "sessions" && p.year === 2026)).toBeTruthy();
    await live.shutdown();
  });

  test("a refused login is an error; other failures say they retry", async () => {
    const hub = sink();
    const live = new OpenF1Live(hub, {
      rest: async () => {
        throw new AuthError("live timing needs a connected OpenF1 account");
      },
      circuit: async () => ({}) as never,
      feed: feeds().feed,
      ...quiet,
    });
    await live.poll();
    expect(hub.state).toBe("error");
    expect(hub.status.detail).toBe("live timing needs a connected OpenF1 account");
    await live.shutdown();

    const hub2 = sink();
    let n = 0;
    const { rest } = api({});
    const live2 = new OpenF1Live(hub2, {
      rest: async <T,>(e: string, p: Params) => {
        // The meeting fails once: goLive gives up, the next poll starts over.
        if (e === "meetings" && n++ === 0) throw new Error("OpenF1 503");
        return rest<T>(e, p);
      },
      circuit: async () => ({}) as never,
      feed: feeds().feed,
      now: () => now,
      ...quiet,
    });
    await live2.poll();
    expect(hub2.status.detail).toBe("retrying: OpenF1 503");
    await live2.poll();
    expect(hub2.log.at(-1)).toBe("start");
    await live2.shutdown();
  });

  test("a gap reported while backfilling is refilled once the backfill is in, from before the gap", async () => {
    const hub = sink();
    const { rest, calls } = api({ position: [{ session_key: 11731, driver_number: 1, position: 1, date: iso(now - MIN) }] });
    const { made, feed } = feeds();
    const live = new OpenF1Live(hub, { rest, circuit: async () => ({}) as never, feed, now: () => now, ...quiet });
    const poll = live.poll();
    while (!made.length) await Bun.sleep(1);
    void made[0].hooks.refill(now - 5 * MIN);
    await poll;
    while (calls.filter(([e]) => e === "position").length < 2) await Bun.sleep(1);
    const refill = calls.filter(([e]) => e === "position")[1][1];
    expect(refill["date>"]).toBe(iso(now - 5 * MIN - 30_000));
    await live.shutdown();
  });
});

describe("backfill", () => {
  test("documents whole; telemetry for every car in pieces, the last open-ended, in time order", async () => {
    const t0 = now - 25 * MIN;
    const store = new LiveStore({ session: race, meeting: null, circuit: null, t0, clock: () => now });
    // Telemetry out of order across pieces: the pieces still land in time order.
    const { rest, calls } = api({ car_data: [car(1, now - MIN), car(1, t0 + MIN), car(1, t0 + 12 * MIN)], laps: [{ session_key: 11731, driver_number: 1, lap_number: 1 }] });
    const n = await backfill(store, rest);
    expect(n).toBe(4);
    const tel = calls.filter(([e]) => e === "car_data").map(([, p]) => [p["date>"], p["date<="] ?? null] as (string | number | null)[]);
    expect(tel).toEqual([
      [iso(t0), iso(t0 + TELEMETRY_PIECE_MS)],
      [iso(t0 + TELEMETRY_PIECE_MS), iso(t0 + 2 * TELEMETRY_PIECE_MS)],
      [iso(t0 + 2 * TELEMETRY_PIECE_MS), null],
    ]);
    expect(calls.filter(([e]) => e === "location")).toHaveLength(3);
    expect(calls.every(([, p]) => p.session_key === 11731)).toBe(true);
    expect(calls.some(([, p]) => "driver_number" in p)).toBe(false);
    expect(store.samples.get(1)!.car.t).toEqual([MIN, 12 * MIN, 24 * MIN]);
  });

  test("a refill: the documents again, time series and telemetry only after `since`", async () => {
    const store = new LiveStore({ session: race, meeting: null, circuit: null, t0: now - 60 * MIN, clock: () => now });
    const { rest, calls } = api({});
    await backfill(store, rest, { since: now - 2 * MIN });
    const p = Object.fromEntries(calls.map(([e, q]) => [e, q]));
    expect(p.laps).toEqual({ session_key: 11731 });
    expect(p.race_control).toEqual({ session_key: 11731, "date>": iso(now - 2 * MIN) });
    expect(p.car_data).toEqual({ session_key: 11731, "date>": iso(now - 2 * MIN) });
  });
});

describe("finished", () => {
  test("not before 30 min after the scheduled end; then once the data dries up or 30 min after the flag", () => {
    const end = Date.parse(race.date_end);
    let clock = end + 20 * MIN;
    const store = new LiveStore({ session: race, meeting: null, circuit: null, t0: Date.parse(race.date_start) - 10 * MIN, clock: () => clock });
    store.ingest("race_control", { session_key: 11731, date: iso(end - 5 * MIN), category: "Flag", flag: "CHEQUERED", message: "CHEQUERED FLAG" });
    expect(finished(store, clock)).toBe(false);
    clock = end + 31 * MIN;
    expect(finished(store, clock)).toBe(true); // the flag was 36 min ago
    const store2 = new LiveStore({ session: race, meeting: null, circuit: null, t0: 0, clock: () => clock });
    store2.ingest("position", { session_key: 11731, driver_number: 1, position: 1, date: iso(clock) });
    expect(finished(store2, clock)).toBe(false); // red flag overrun: data still coming
    expect(finished(store2, clock + 11 * MIN)).toBe(true); // quiet for 10 min
    expect(finished(store2, end + 3 * 60 * MIN + 1)).toBe(true);
  });
});
