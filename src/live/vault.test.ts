// Live through the vault, page and worker together (./vault.ts + ./vaultEngine.ts, with the shared ./openf1.ts,
// ./hub.ts and ./store.ts): a fake vault (account state, subscriptions, the stream's status, data, REST) and the
// engine run in-process instead of in a worker.

import { describe, expect, test } from "bun:test";
import type { VaultState } from "../vault/client";
import type { LiveMessage } from "./protocol";
import { TOPICS } from "./topics";
import { accountNeed, connectVaultLive, stallOf, type LiveAccount, type VaultLike, type WorkerLike } from "./vault";
import { MAX_IN_FLIGHT, VaultEngine, type FromEngine, type ToEngine } from "./vaultEngine";

type Rec = Record<string, any>;
const MIN = 60_000;
const iso = (t: number) => new Date(t).toISOString();
const until = async (what: string, pred: () => boolean, ms = 5_000) => {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(5);
  }
};

/** A race started 5 min ago: two cars, telemetry for the last 2 minutes. */
function openf1() {
  const start = Date.now() - 5 * MIN;
  const session = {
    session_key: 9001,
    meeting_key: 900,
    session_name: "Race",
    session_type: "Race",
    date_start: iso(start),
    date_end: iso(start + 2 * 60 * MIN),
    year: 2026,
    circuit_short_name: "Test",
    country_name: "Testland",
    location: "Testville",
    gmt_offset: "00:00:00",
  };
  const rows: Record<string, Rec[]> = {
    meetings: [{ meeting_key: 900, meeting_name: "Test Grand Prix" }],
    drivers: [1, 44].map((n) => ({ session_key: 9001, driver_number: n, name_acronym: `D${n}`, full_name: `Driver ${n}`, team_name: "Team", team_colour: "ff0000" })),
    car_data: [],
    location: [],
  };
  for (let t = Date.now() - 2 * MIN; t < Date.now(); t += 1000) {
    for (const n of [1, 44]) {
      rows.car_data.push({ session_key: 9001, driver_number: n, date: iso(t), speed: 200, rpm: 11000, n_gear: 7, throttle: 100, brake: 0, drs: 0 });
      rows.location.push({ session_key: 9001, driver_number: n, date: iso(t + 100), x: Math.round(t / 100) % 5000, y: n, z: 0 });
    }
  }
  return {
    session,
    rows,
    answer(endpoint: string, params: Rec): Rec[] {
      if (endpoint === "sessions") return params.session_key === "latest" ? [session] : [];
      let out = rows[endpoint] ?? [];
      if (params["date>"] != null) out = out.filter((r) => Date.parse(r.date) > Date.parse(params["date>"]));
      if (params["date<="] != null) out = out.filter((r) => Date.parse(r.date) <= Date.parse(params["date<="]));
      return out;
    },
  };
}

/** The vault client, faked: tests drive its account and stream; subscriptions start and stop the stream. */
function fakeVault(api: ReturnType<typeof openf1>) {
  let state: VaultState = { phase: "loading", origin: "https://vault.test" };
  const stateFns = new Set<(s: VaultState) => void>();
  const dataFns = new Set<(t: any, m: Rec[]) => void>();
  const topics = new Set<string>();
  const gets: string[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const emit = () => {
    for (const fn of [...stateFns]) fn(state);
  };
  const stream = () => ({ phase: topics.size ? "connected" : "off", topics: [...topics].sort(), sessions: topics.size ? 1 : 0, maxSessions: 1, handovers: 0, reconnects: 0, delivered: 0, duplicates: 0, gapFilled: 0, lastSeen: {}, since: {} });
  const v = {
    getState: () => state,
    onState(fn: (s: VaultState) => void) {
      stateFns.add(fn);
      return () => void stateFns.delete(fn);
    },
    onData(fn: (t: any, m: Rec[]) => void) {
      dataFns.add(fn);
      return () => void dataFns.delete(fn);
    },
    start: async () => {},
    async subscribe(ts: string[]) {
      await Bun.sleep(2);
      for (const t of ts) topics.add(t);
      state = { ...state, status: { ...state.status!, stream: stream() as never } };
      emit();
      return { topics: [...topics] };
    },
    async unsubscribe(ts: string[]) {
      await Bun.sleep(2);
      for (const t of ts) topics.delete(t);
      state = { ...state, status: { ...state.status!, stream: stream() as never } };
      emit();
      return { topics: [...topics] };
    },
    async get(endpoint: string, params: Rec) {
      gets.push(endpoint);
      maxInFlight = Math.max(maxInFlight, ++inFlight);
      await Bun.sleep(3);
      inFlight--;
      const rows = api.answer(endpoint, params);
      return { status: rows.length ? 200 : 404, auth: true, body: new TextEncoder().encode(JSON.stringify(rows.length ? rows : { detail: "No results found." })).buffer as ArrayBuffer };
    },
    // ---- the test's side
    account(s: "connected" | "disconnected" | "locked") {
      state = { ...state, phase: "ready", status: { state: s, live: "off", version: "test", ...(state.status?.stream && { stream: state.status.stream }) } };
      emit();
    },
    remount() {
      state = { ...state, remounts: (state.remounts ?? 0) + 1 };
      emit();
    },
    push(topic: string, messages: Rec[]) {
      for (const fn of [...dataFns]) fn(topic, messages);
    },
    topics,
    gets,
    maxInFlight: () => maxInFlight,
  };
  return v;
}

/** The live worker, in-process: messages both ways go through structuredClone, as postMessage does. */
function inProcess() {
  const spawned: (WorkerLike & { terminated: boolean })[] = [];
  const spawn = () => {
    let terminated = false;
    const engine = new VaultEngine({
      post: (m: FromEngine) => queueMicrotask(() => !terminated && w.onmessage?.({ data: structuredClone(m) })),
      circuit: async () => {
        throw new Error("no circuit in tests");
      },
      log: () => {},
      warn: () => {},
    });
    const w = {
      onmessage: null as WorkerLike["onmessage"],
      onerror: null as WorkerLike["onerror"],
      get terminated() {
        return terminated;
      },
      postMessage(m: ToEngine) {
        const copy = structuredClone(m);
        queueMicrotask(() => !terminated && engine.handle(copy));
      },
      terminate() {
        terminated = true;
        engine.stop();
      },
    };
    spawned.push(w);
    return w;
  };
  return { spawned, spawn };
}

describe("live through the vault", () => {
  test("no account: says so; connected: the worker follows the session and the app gets the relay's messages; the account goes: it stops and unsubscribes", async () => {
    const api = openf1();
    const vault = fakeVault(api);
    const { spawned, spawn } = inProcess();
    const accounts: (LiveAccount | null)[] = [];
    const msgs: LiveMessage[] = [];
    let opened = 0;
    const conn = connectVaultLive(
      { onOpen: () => opened++, onDown: () => {}, onMessage: (m) => msgs.push(m), onAccount: (a) => accounts.push(a), onStall: () => {} },
      { vault: vault as unknown as VaultLike, spawn },
    );
    expect(accounts).toEqual(["loading"]);
    vault.account("disconnected");
    expect(accounts).toEqual(["loading", "connect"]);
    expect(spawned).toHaveLength(0);

    // Signed in: the worker starts, finds the session, subscribes, backfills, and the snapshot comes.
    vault.account("connected");
    expect(accounts.at(-1)).toBeNull();
    expect(spawned).toHaveLength(1);
    await until("the snapshot", () => msgs.some((m) => m.type === "snapshot"));
    expect(opened).toBe(1);
    expect(msgs[0]).toMatchObject({ type: "status", state: "connecting" });
    expect([...vault.topics].sort()).toEqual([...TOPICS].sort());
    const snap = msgs.find((m) => m.type === "snapshot")!;
    if (snap.type !== "snapshot") throw new Error();
    expect(snap.meta.sessionKey).toBe(9001);
    expect(snap.meta.drivers.map((d) => d.number).sort()).toEqual([1, 44]);
    expect(msgs.some((m) => m.type === "status" && m.state === "live")).toBe(true);
    expect(vault.maxInFlight()).toBeLessThanOrEqual(MAX_IN_FLIGHT);

    // The stream: a new sample reaches the app in the next `tel`.
    const t = Date.now() + 500;
    vault.push("car_data", [{ session_key: 9001, driver_number: 44, date: iso(t), speed: 311, rpm: 12000, n_gear: 8, throttle: 100, brake: 0, drs: 0, _id: 1, _key: "x" }]);
    await until("the new sample", () => msgs.some((m) => m.type === "tel" && m.chunks.some((c) => c.driver === 44 && c.car.speed.includes(311))));
    await until("a meta", () => msgs.some((m) => m.type === "meta"));

    // The vault's frame was replaced: what this tab may have missed is fetched again.
    const laps = vault.gets.filter((g) => g === "laps").length;
    vault.remount();
    await until("the refill", () => vault.gets.filter((g) => g === "laps").length > laps);

    // The account goes: the worker stops, the subscription goes, the app is told.
    vault.account("disconnected");
    expect(spawned[0].terminated).toBe(true);
    expect(accounts.at(-1)).toBe("connect");
    await until("unsubscribed", () => vault.topics.size === 0);

    // Back: a new worker, the same session again.
    const before = msgs.length;
    vault.account("connected");
    expect(spawned).toHaveLength(2);
    await until("the snapshot again", () => msgs.slice(before).some((m) => m.type === "snapshot" && m.meta.sessionKey === 9001));

    // Leaving live: no worker, no subscription.
    conn.close();
    expect(spawned[1].terminated).toBe(true);
    await until("unsubscribed on close", () => vault.topics.size === 0);
  });

  test("detached, the worker keeps the session; attached again, the app gets it at once, with no second backfill", async () => {
    const api = openf1();
    const vault = fakeVault(api);
    const { spawned, spawn } = inProcess();
    const noop = { onDown: () => {}, onStall: () => {} };
    const first: LiveMessage[] = [];
    const conn = connectVaultLive({ ...noop, onOpen: () => {}, onMessage: (m) => first.push(m), onAccount: () => {} }, { vault: vault as unknown as VaultLike, spawn });
    vault.account("connected");
    await until("the snapshot", () => first.some((m) => m.type === "snapshot"));

    conn.detach();
    const seen = first.length;
    await Bun.sleep(600); // a `tel` tick or so: it goes nowhere
    expect(first.length).toBe(seen);

    const gets = vault.gets.length;
    const back: LiveMessage[] = [];
    const accounts: (LiveAccount | null)[] = [];
    let opened = 0;
    conn.attach({ ...noop, onOpen: () => opened++, onMessage: (m) => back.push(m), onAccount: (a) => accounts.push(a) });
    expect(accounts).toEqual([null]);
    expect(opened).toBe(1);
    await until("the snapshot again", () => back.some((m) => m.type === "snapshot" && m.meta.sessionKey === 9001));
    expect(back[0]).toMatchObject({ type: "status", state: "live" });
    expect(spawned).toHaveLength(1);
    expect(vault.gets.length).toBe(gets);

    conn.close();
    expect(spawned[0].terminated).toBe(true);
  });

  test("a locked or failing account doesn't start it; a login re-checked while it runs doesn't stop it", () => {
    const base = { origin: "https://vault.test" } as const;
    const s = (state: string): VaultState => ({ ...base, phase: "ready", status: { state, live: "off", version: "t" } as never });
    expect(accountNeed({ ...base, phase: "loading" })).toBe("loading");
    expect(accountNeed({ ...base, phase: "unavailable", reason: "x" })).toBe("unavailable");
    expect(accountNeed(s("disconnected"))).toBe("connect");
    expect(accountNeed(s("locked"))).toBe("unlock");
    expect(accountNeed(s("error"))).toBe("reconnect");
    expect(accountNeed(s("unavailable"))).toBe("blocked");
    expect(accountNeed(s("connecting"))).toBe("checking");
    expect(accountNeed(s("connected"))).toBeNull();

    const api = openf1();
    const vault = fakeVault(api);
    const { spawned, spawn } = inProcess();
    const conn = connectVaultLive({ onOpen: () => {}, onDown: () => {}, onMessage: () => {}, onAccount: () => {}, onStall: () => {} }, { vault: vault as unknown as VaultLike, spawn });
    vault.account("locked");
    expect(spawned).toHaveLength(0);
    vault.account("connected");
    expect(spawned).toHaveLength(1);
    vault.account("connecting" as never);
    expect(spawned[0].terminated).toBe(false);
    conn.close();
  });

  test("the stream's stalls, as the header says them", () => {
    const st = (phase: string, sessions = 1) => ({ phase, sessions, topics: [] }) as never;
    expect(stallOf(st("connected"))).toBeNull();
    expect(stallOf(st("reconnecting"))).toBe("reconnecting");
    expect(stallOf(st("connection-limit", 1))).toBeNull(); // the old session still streams
    expect(stallOf(st("connection-limit", 0))).toBe("limit");
    expect(stallOf(st("waiting"))).toBe("waiting");
  });
});
