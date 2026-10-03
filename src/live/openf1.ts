// Live data from OpenF1 (sponsor tier): polls for the current session, and while a race, sprint, qualifying or free practice
// session is on, backfills it over REST and follows its live feed. Shared by the relay (server/openf1Source.ts: REST with the credentials in
// .env, its own MQTT connection) and the browser's live worker (./worker.ts: REST and the stream through the
// credential vault). The transport is injected (LiveDeps): no I/O here.

import { AuthError } from "../../scripts/lib/openf1Http";
import type { RawCircuit, RawMeeting, RawSession } from "../../scripts/lib/openf1Types";
import { endingFlag } from "../../scripts/lib/normalize";
import { isFollowedLive } from "../../scripts/lib/season";
import type { LiveSink } from "./hub";
import type { LiveStatus } from "./protocol";
import { LiveStore, type Rec, type Topic } from "./store";

export const POLL_MS = 60_000;
/** After a failed attempt to go live (not a refused login), the next poll comes this soon. */
const RETRY_MS = 10_000;
const NEXT_REFRESH_MS = 60 * 60_000;
const BEFORE_START_MS = 15 * 60_000; // go live this long before the scheduled start
const AFTER_END_MS = 30 * 60_000; // ...and stay live at least this long after the scheduled end
const MAX_OVERRUN_MS = 3 * 60 * 60_000; // red flags can stretch a race; give up after this
const QUIET_MS = 10 * 60_000; // no data for this long (after the scheduled end): it's over
export const T0_BEFORE_START_MS = 10 * 60_000;
/** Telemetry is backfilled for every car at once, in pieces this long (one request each per endpoint). */
export const TELEMETRY_PIECE_MS = 10 * 60_000;
/** A refill after a gap in the feed starts this long before the last sample received before it. */
export const REFILL_OVERLAP_MS = 30_000;
/** The status says how the backfill is going at most this often. */
const PROGRESS_EVERY_MS = 2_000;

// Each one request (time series after `since` in a refill; the rest whole).
const DOCS: Topic[] = ["drivers", "laps", "stints", "pit", "session_result", "race_control", "position", "intervals", "weather", "team_radio", "overtakes"];
const TIME_SERIES = new Set<Topic>(["race_control", "position", "intervals", "weather", "team_radio", "overtakes"]);

export type Params = Record<string, string | number>;
export type Endpoint = Topic | "meetings";

const iso = (t: number) => new Date(t).toISOString();
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** A session live mode follows: a race, sprint, qualifying or free practice that goes ahead. */
export const isRaceSession = (s: RawSession) => isFollowedLive(s) && !s.is_cancelled;

/** Within [scheduled start - 15 min, scheduled end + 30 min]. */
export function inLiveWindow(s: RawSession, now: number): boolean {
  return now >= Date.parse(s.date_start) - BEFORE_START_MS && now <= Date.parse(s.date_end) + AFTER_END_MS;
}

/** Over after the scheduled end once the data dries up (or long after the flag). */
export function finished(store: LiveStore, now: number): boolean {
  const end = Date.parse(store.session.date_end);
  if (now > end + MAX_OVERRUN_MS) return true;
  if (now <= end + AFTER_END_MS) return false;
  const quiet = store.lastMessageAt == null || now - store.lastMessageAt > QUIET_MS;
  // (Qualifying: the last segment's flag, not Q1's.)
  const flag = endingFlag(store.list<{ flag: string | null; date: string }>("race_control"), store.session);
  return quiet || (flag != null && now - Date.parse(flag.date) > AFTER_END_MS);
}

/** A session's live feed (the relay's MQTT connection, the vault's stream). */
export interface LiveFeed {
  /** Start receiving the session's messages (FeedHooks.deliver). Resolves once subscribed, or rejects and keeps trying by itself. */
  start(): Promise<void>;
  stop(): void;
}

export interface FeedHooks {
  /** A message, as it arrives. */
  deliver(topic: Topic, rec: Rec): void;
  /** The feed had a gap that began after the store's latest sample was `since` (absolute ms): fetch what it may have missed. */
  refill(since: number): Promise<void>;
}

export interface LiveDeps {
  /** One OpenF1 REST read; [] for "no results". Throws AuthError when OpenF1 refuses the login. */
  rest<T = Rec>(endpoint: Endpoint, params: Params): Promise<T[]>;
  /** The circuit map (MultiViewer, meeting.circuit_info_url). */
  circuit(url: string): Promise<RawCircuit>;
  /** The live feed for a session. */
  feed(store: LiveStore, hooks: FeedHooks): LiveFeed;
  /** The session clock: Date.now, or a simulation's (shifted, maybe faster). */
  now?: () => number;
  /** Keep raw telemetry in the store (the relay writes it to the raw cache). */
  keepRaw?: boolean;
  /** The session is over, or the source is shutting down during one: the relay saves it. Returns words for the status. */
  save?(store: LiveStore): Promise<string | undefined>;
  log?: (line: string) => void;
  warn?: (line: string) => void;
}

/**
 * Fetch a session over REST into `store`: everything, or (`since`, absolute ms) the documents again and only what is
 * newer of the time series and telemetry. Requests go out together (`rest` paces them); telemetry is ingested in time
 * order. Returns the number of records.
 */
export async function backfill(
  store: LiveStore,
  rest: LiveDeps["rest"],
  opts: { since?: number; alive?: () => boolean; progress?: (done: number, total: number) => void } = {},
): Promise<number> {
  const { since, alive = () => true } = opts;
  const key = store.sessionKey;
  // Telemetry from t0 on (the replay window never starts earlier), every car at once, the last piece open-ended.
  const from = since ?? store.t0;
  const end = store.clock();
  const pieces: { from: number; to: number | null }[] = [];
  for (let t = from; ; t += TELEMETRY_PIECE_MS) {
    const last = t + TELEMETRY_PIECE_MS >= end;
    pieces.push({ from: t, to: last ? null : t + TELEMETRY_PIECE_MS });
    if (last) break;
  }
  const requests: { topic: Topic; params: Params }[] = [
    ...DOCS.map((topic) => ({ topic, params: { session_key: key, ...(since != null && TIME_SERIES.has(topic) ? { "date>": iso(since) } : {}) } })),
    ...pieces.flatMap((p) =>
      (["location", "car_data"] as const).map((topic) => ({ topic, params: { session_key: key, "date>": iso(p.from), ...(p.to != null ? { "date<=": iso(p.to) } : {}) } })),
    ),
  ];
  let done = 0;
  const pending = requests.map(({ topic, params }) => {
    const p = rest<Rec>(topic, params).then((recs) => {
      opts.progress?.(++done, requests.length);
      return recs;
    });
    p.catch(() => {}); // awaited below, in order; a failure there stops the backfill
    return p;
  });
  let count = 0;
  for (let i = 0; i < requests.length; i++) {
    const recs = await pending[i];
    if (!alive()) return count;
    for (const r of recs) store.ingest(requests[i].topic, r);
    count += recs.length;
  }
  return count;
}

/** The session being followed. */
interface Following {
  store: LiveStore;
  feed: LiveFeed;
}

export class OpenF1Live {
  private live: Following | null = null;
  private polling = false;
  private stopped = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private next: { at: number; value: LiveStatus["next"] } | null = null;
  /** REST failed while following a session (said once until it answers again). */
  private restDown = false;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private readonly warn: (line: string) => void;

  constructor(
    private hub: LiveSink,
    private deps: LiveDeps,
  ) {
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? ((line) => console.log(line));
    this.warn = deps.warn ?? ((line) => console.warn(line));
  }

  /** Poll now and every POLL_MS. */
  start(): void {
    void this.poll();
    this.timer = setInterval(() => void this.poll(), POLL_MS);
  }

  /** The session followed now, if any. */
  get store(): LiveStore | null {
    return this.live?.store ?? null;
  }

  async poll(): Promise<void> {
    if (this.polling || this.stopped) return;
    this.polling = true;
    try {
      if (this.live) {
        // The session's record when REST answers (the stream carries it too). REST failing while the stream flows
        // changes nothing on screen, and the end is told without it.
        const live = this.live;
        try {
          const [latest] = await this.deps.rest<RawSession>("sessions", { session_key: "latest" });
          if (latest?.session_key === live.store.sessionKey) live.store.ingest("sessions", latest);
          this.restDown = false;
        } catch (e) {
          if (!this.restDown) this.warn(`[live] OpenF1 REST unavailable (${errorText(e)}); following the stream alone`);
          this.restDown = true;
        }
        if (finished(live.store, this.now())) await this.endLive();
        else if (this.hub.state === "error") this.hub.setStatus({ state: "live" });
        return;
      }
      const [latest] = await this.deps.rest<RawSession>("sessions", { session_key: "latest" });
      const now = this.now();
      if (latest && isRaceSession(latest) && inLiveWindow(latest, now)) {
        await this.goLive(latest);
        return;
      }
      const next = await this.nextRace(now);
      this.hub.setStatus({ state: this.hub.session ? "ended" : "idle", sessionKey: this.hub.session?.store.sessionKey ?? null, next });
    } catch (e) {
      if (e instanceof AuthError) this.hub.setStatus({ state: "error", detail: e.message });
      else {
        this.warn(`[live] OpenF1 poll failed: ${errorText(e)}`);
        if (this.hub.state === "connecting") this.hub.setStatus({ detail: `retrying: ${errorText(e)}` });
        if (!this.live && !this.stopped && !this.retry) {
          this.retry = setTimeout(() => {
            this.retry = null;
            void this.poll();
          }, RETRY_MS);
        }
      }
    } finally {
      this.polling = false;
    }
  }

  /** The feed had a gap it can't fill by itself (e.g. the vault's frame was replaced): fetch what it may have missed. */
  refill(since: number): Promise<void> {
    return this.live ? this.refillStore(this.live.store, since) : Promise.resolve();
  }

  private async refillStore(store: LiveStore, since: number): Promise<void> {
    const started = Date.now();
    try {
      const n = await backfill(store, this.deps.rest, {
        since: Number.isFinite(since) ? since - REFILL_OVERLAP_MS : undefined,
        alive: () => this.live?.store === store,
      });
      this.log(`[live] gap backfill: ${n} records in ${((Date.now() - started) / 1000).toFixed(0)}s`);
    } catch (e) {
      this.warn(`[live] gap backfill failed: ${errorText(e)}`);
    }
  }

  /** The next race, sprint, qualifying or free practice that hasn't started (this year, else next year). */
  private async nextRace(now: number): Promise<LiveStatus["next"]> {
    if (this.next && now - this.next.at < NEXT_REFRESH_MS && (!this.next.value || Date.parse(this.next.value.dateStart) > now)) {
      return this.next.value;
    }
    const year = new Date(now).getUTCFullYear();
    let value: LiveStatus["next"] = null;
    for (const y of [year, year + 1]) {
      const sessions = await this.deps.rest<RawSession>("sessions", { year: y });
      const s = sessions
        .filter((x) => isRaceSession(x) && Date.parse(x.date_start) > now)
        .sort((a, b) => a.date_start.localeCompare(b.date_start))[0];
      if (s) {
        value = { sessionKey: s.session_key, name: `${s.location} ${s.session_name}`, dateStart: s.date_start };
        break;
      }
    }
    this.next = { at: now, value };
    return value;
  }

  /** Subscribe (holding what arrives), backfill over REST, apply what arrived meanwhile, then stream. */
  private async goLive(session: RawSession): Promise<void> {
    const key = session.session_key;
    this.hub.setStatus({ state: "connecting", sessionKey: key, next: null, detail: "backfilling from OpenF1" });
    const [meeting] = await this.deps.rest<RawMeeting>("meetings", { meeting_key: session.meeting_key });
    let circuit: RawCircuit | null = null;
    if (meeting?.circuit_info_url) {
      circuit = await this.deps.circuit(meeting.circuit_info_url).catch((e) => {
        this.warn(`[live] circuit info unavailable (${errorText(e)})`);
        return null;
      });
    }
    const store = new LiveStore({
      session,
      meeting: meeting ?? null,
      circuit,
      t0: Date.parse(session.date_start) - T0_BEFORE_START_MS,
      clock: this.now,
      keepRaw: this.deps.keepRaw,
    });
    let buffer: [Topic, Rec][] | null = [];
    // A gap while backfilling: filled once the backfill is in (from before the gap).
    const gap = { since: null as number | null };
    const feed = this.deps.feed(store, {
      deliver: (topic, rec) => {
        if (buffer) buffer.push([topic, rec]);
        else store.ingest(topic, rec);
      },
      refill: async (since) => {
        if (buffer) gap.since = Math.min(gap.since ?? Infinity, since);
        else if (this.live?.store === store) await this.refillStore(store, since);
      },
    });
    const started = Date.now();
    let shown = 0;
    try {
      try {
        await feed.start();
      } catch (e) {
        this.warn(`[live] live feed not up yet (${errorText(e)}); it keeps trying`);
      }
      const count = await backfill(store, this.deps.rest, {
        alive: () => !this.stopped,
        progress: (done, total) => {
          if (done < total && Date.now() - shown < PROGRESS_EVERY_MS) return;
          shown = Date.now();
          this.hub.setStatus({ detail: `backfilling from OpenF1: ${Math.round((100 * done) / total)}%` });
        },
      });
      this.log(`[live] backfill: ${count} records in ${((Date.now() - started) / 1000).toFixed(0)}s`);
    } catch (e) {
      feed.stop(); // the next poll starts over
      throw e;
    }
    if (this.stopped) return feed.stop();
    for (const [topic, rec] of buffer) store.ingest(topic, rec);
    buffer = null;
    this.live = { store, feed };
    this.hub.startSession(store);
    if (gap.since != null) void this.refillStore(store, gap.since);
  }

  private async endLive(): Promise<void> {
    const live = this.live;
    if (!live) return;
    this.live = null;
    live.feed.stop();
    const detail = await this.deps.save?.(live.store);
    this.hub.endSession(detail);
    this.hub.setStatus({ next: await this.nextRace(this.now()).catch(() => null) });
    this.log(`[live] #${live.store.sessionKey} over`);
  }

  /** Stop polling and the feed; the relay saves what was received (Ctrl-C during a session). */
  async shutdown(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.retry) clearTimeout(this.retry);
    const live = this.live;
    if (!live) return;
    this.live = null;
    live.feed.stop();
    if (live.store.records > 0) await this.deps.save?.(live.store);
  }
}
