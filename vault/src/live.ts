// The live stream: OpenF1's MQTT feed for the union of every tab's subscriptions, run by the leader frame.
// Pure apart from what's injected (clock and timers, the socket factory, the token, the REST fetcher), so
// bun tests drive it against an in-memory broker.
//
// - Username = the account's email, password = the token. (Measured 2026-09-30: any other username gets
//   CONNACK 5 even with a valid token, contrary to the earlier note that any non-empty string works.)
// - Every session gets a fresh random clientId (reusing one kicks the older session at the broker).
// - Handover: when the scheduler has a new token, open session B with it, subscribe, and once B's SUBACK
//   is in, close A after OVERLAP_MS. (Not at once: a message published just before B subscribed may still be
//   in flight on A's socket.) The overlap's duplicates are dropped by message identity.
// - CONNACK 5 is ambiguous (docs/modular-hypotheses.md): an expired token or the account's 10-connection
//   cap. With a token that is still valid locally it's the cap: keep A, keep the token, back off, phase
//   "connection-limit". With an expired one: refresh first, then retry.
// - An unexpected drop: reconnect with backoff (a fresh token first if needed), then fill the gap over REST
//   per topic with `date>=lastSeen` (>=, not >: several records share a timestamp, and dedupe drops the one we
//   had), merged through the same dedupe and emitted in order before live resumes. Live messages that arrive
//   meanwhile are held back and follow.
// - Identity: OpenF1's `_id` when present (MQTT), and always topic + date + a hash of the content without
//   `_id` / `_key` (REST rows have neither). A message is a duplicate if either key was seen. Bounded memory:
//   the newest SEEN_PER_TOPIC keys of each topic.
// - Out: batches every FLUSH_MS, {topic, messages[]}, sorted by date within the batch.

import type { MqttError, SessionOptions, SocketFactory } from "./mqtt";
import { MqttSession, describeClose } from "./mqtt";
import type { LiveMessage, LiveTopic, Params, RestEndpoint, StreamPhase, StreamStatus } from "./protocol";
import type { Timers } from "./scheduler";

/** OpenF1's broker (MQTT over secure WebSocket). The dev vault can point at the local fake instead. */
export const MQTT_URL = "wss://mqtt.openf1.org:8084/mqtt";
export const TOPIC_PREFIX = "v1/";
/** How long A stays open after B's SUBACK. */
export const OVERLAP_MS = 2_000;
export const FLUSH_MS = 150;
/** Status pushes caused by data (lastSeen, counters) at most this often; phase changes go at once. */
export const STATUS_EVERY_MS = 1_000;
export const RECONNECT_BASE_MS = 500;
export const RECONNECT_CAP_MS = 30_000;
/** Backoff after CONNACK 5 with a valid token (the connection cap won't clear in a second). */
export const LIMIT_BASE_MS = 5_000;
export const LIMIT_CAP_MS = 120_000;
export const JITTER = 0.2;
/**
 * Dedupe memory: this many keys per topic. An MQTT message takes two (`_id` and content), so for car_data
 * (~4 Hz x 20 drivers) about 2 minutes: far more than any overlap needs (gap-fill starts at lastSeen).
 */
export const SEEN_PER_TOPIC = 20_000;
/** A topic with nothing delivered yet is gap-filled from when it started streaming, minus this. */
export const GAP_MARGIN_MS = 30_000;
/** Gap-fill attempts per topic before giving up on it (the gap is then reported in lastError). */
export const GAP_TRIES = 3;

/** Topics whose records carry a `date`: gap-filled with date>=lastSeen. The others are refetched whole (small). */
export const DATED: ReadonlySet<LiveTopic> = new Set<LiveTopic>(["car_data", "intervals", "location", "overtakes", "pit", "position", "race_control", "team_radio", "weather"]);

// ---------------------------------------------------------------- identity

/** cyrb53: a fast 53-bit string hash. Collisions within one topic's 20k window are negligible. */
export function hash53(s: string, seed = 0): string {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/** JSON with sorted keys, so the same record hashes the same whichever way it was serialized. */
export function canonical(x: unknown): string {
  if (Array.isArray(x)) return `[${x.map(canonical).join(",")}]`;
  if (x && typeof x === "object") {
    const keys = Object.keys(x).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical((x as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(x) ?? "null";
}

/** The keys a message is known by: `_id` (when present) and topic + date + content hash. */
export function identity(topic: LiveTopic, m: LiveMessage): string[] {
  const { _id, _key, ...rest } = m;
  const date = typeof m.date === "string" ? m.date : "";
  const keys = [`${topic}|${date}|${hash53(canonical(rest))}`];
  if (typeof _id === "string" || typeof _id === "number") keys.push(`${topic}#${_id}`);
  return keys;
}

const dateMs = (m: LiveMessage) => (typeof m.date === "string" ? Date.parse(m.date) : NaN);

/** Stable sort by date; records without one keep their place at the front. */
export function byDate(ms: LiveMessage[]): LiveMessage[] {
  return ms
    .map((m, i) => ({ m, i, t: dateMs(m) }))
    .sort((a, b) => (Number.isNaN(a.t) ? -Infinity : a.t) - (Number.isNaN(b.t) ? -Infinity : b.t) || a.i - b.i)
    .map((x) => x.m);
}

// ---------------------------------------------------------------- what has been delivered

/** What a frame knows about the stream so far: shared from leader to followers, so a new leader continues it. */
export type LiveSnapshot = {
  lastSeen: Partial<Record<LiveTopic, string>>;
  since: Partial<Record<LiveTopic, number>>;
  sessionKey: number | null;
  seen: Partial<Record<LiveTopic, string[]>>;
};

/** Seen message keys (bounded FIFO per topic), lastSeen per topic, and the live session's key. */
export class LiveState {
  private seen = new Map<LiveTopic, { set: Set<string>; order: string[]; head: number }>();
  lastSeen: Partial<Record<LiveTopic, string>> = {};
  private lastSeenMs: Partial<Record<LiveTopic, number>> = {};
  since: Partial<Record<LiveTopic, number>> = {};
  sessionKey: number | null = null;
  delivered = 0;
  duplicates = 0;

  constructor(private cap = SEEN_PER_TOPIC) {}

  /** Record a message; false if it was already delivered (a duplicate). */
  accept(topic: LiveTopic, m: LiveMessage): boolean {
    const keys = identity(topic, m);
    let s = this.seen.get(topic);
    if (!s) this.seen.set(topic, (s = { set: new Set(), order: [], head: 0 }));
    if (keys.some((k) => s.set.has(k))) {
      this.duplicates++;
      return false;
    }
    for (const k of keys) {
      s.set.add(k);
      s.order.push(k);
    }
    while (s.order.length - s.head > this.cap) s.set.delete(s.order[s.head++]!);
    if (s.head > this.cap) {
      s.order = s.order.slice(s.head);
      s.head = 0;
    }
    const t = dateMs(m);
    if (!Number.isNaN(t) && !(t <= (this.lastSeenMs[topic] ?? -Infinity))) {
      this.lastSeenMs[topic] = t;
      this.lastSeen[topic] = m.date as string;
    }
    if (typeof m.session_key === "number" && (this.sessionKey === null || m.session_key > this.sessionKey)) this.sessionKey = m.session_key;
    this.delivered++;
    return true;
  }

  /** Keys held for a topic (tests: memory stays bounded). */
  size(topic: LiveTopic) {
    return this.seen.get(topic)?.set.size ?? 0;
  }

  /** Stop tracking a topic (unsubscribed by everyone). */
  forget(topic: LiveTopic) {
    this.seen.delete(topic);
    delete this.lastSeen[topic];
    delete this.lastSeenMs[topic];
    delete this.since[topic];
  }

  reset() {
    this.seen.clear();
    this.lastSeen = {};
    this.lastSeenMs = {};
    this.since = {};
    this.sessionKey = null;
  }

  snapshot(): LiveSnapshot {
    const seen: LiveSnapshot["seen"] = {};
    for (const [t, s] of this.seen) seen[t] = s.order.slice(s.head);
    return { lastSeen: { ...this.lastSeen }, since: { ...this.since }, sessionKey: this.sessionKey, seen };
  }

  /** Take over what another frame knew (merged with what this one saw). */
  merge(snap: LiveSnapshot) {
    for (const [t, keys] of Object.entries(snap.seen) as [LiveTopic, string[]][]) {
      let s = this.seen.get(t);
      if (!s) this.seen.set(t, (s = { set: new Set(), order: [], head: 0 }));
      for (const k of keys) if (!s.set.has(k)) (s.set.add(k), s.order.push(k));
      while (s.order.length - s.head > this.cap) s.set.delete(s.order[s.head++]!);
    }
    for (const [t, d] of Object.entries(snap.lastSeen) as [LiveTopic, string][]) {
      const ms = Date.parse(d);
      if (!(ms <= (this.lastSeenMs[t] ?? -Infinity))) {
        this.lastSeen[t] = d;
        this.lastSeenMs[t] = ms;
      }
    }
    for (const [t, at] of Object.entries(snap.since) as [LiveTopic, number][]) this.since[t] = Math.min(this.since[t] ?? Infinity, at);
    if (snap.sessionKey !== null && (this.sessionKey === null || snap.sessionKey > this.sessionKey)) this.sessionKey = snap.sessionKey;
  }
}

// ---------------------------------------------------------------- the manager

/** The token and the account it belongs to (the broker wants the email as the username). */
export type LiveToken = { accessToken: string; expiresAt: number; username: string };
export type Batch = { topic: LiveTopic; messages: LiveMessage[] };

export type LiveDeps = Timers & {
  random(): number;
  url: string;
  socket: SocketFactory;
  /** The token in hand (valid or not), or null. */
  token(): LiveToken | null;
  /** Ask for a new token now (coalesced); true if one is in place. */
  refresh(): Promise<boolean>;
  /** One REST read (the vault's `get`); rejects on a network failure. */
  rest(endpoint: RestEndpoint, params: Params): Promise<{ status: number; body: ArrayBuffer }>;
  /** Deliver batches (already deduped, in order). */
  emit(batches: Batch[]): void;
  /** Something in status() changed. */
  onStatus(): void;
  /** Session options for tests (keepalive, timeouts). */
  session?: Partial<SessionOptions>;
  /**
   * The leader's lease (tabs.ts). Before delivering anything, and before opening a session: ok() true, or
   * verify() resolves true. A frame that was frozen while another stole the lead has no lease on waking: its
   * sessions' backlog is held (raw) until verify() says it still leads, and dropped if it doesn't.
   */
  lease?: { ok(): boolean; verify(): Promise<boolean> };
};

type Conn = { session: MqttSession; topics: Set<LiveTopic>; token: LiveToken; closing: boolean; clientId: string };

const isRefusedAuth = (e: unknown): e is MqttError => {
  const i = (e as MqttError | undefined)?.info;
  return !!i && i.reason === "refused" && (i.code === 5 || i.code === 4);
};

/**
 * A fresh clientId for every session, from the CSPRNG (never the injectable jitter source: a reused
 * clientId makes the broker kick the older session, which is exactly what a handover must not do).
 */
export function randomClientId(): string {
  const b = crypto.getRandomValues(new Uint8Array(12));
  return `f1-vault-${[...b].map((x) => x.toString(36).padStart(2, "0")).join("").slice(0, 16)}`;
}

export class LiveManager {
  readonly state: LiveState;
  private topics = new Set<LiveTopic>();
  private running = false;
  private active: Conn | null = null;
  private next: Conn | null = null;
  private lingering = new Set<Conn>();
  private phase: StreamPhase = "off";
  private lastError: string | undefined;
  private retryAt: number | undefined;
  private retryTimer: unknown = null;
  private retryKind: "connect" | "handover" | null = null;
  private attempts = 0;
  private limitAttempts = 0;
  /** A gap to fill once a session is back (no overlapping session carried the stream). */
  private gapPending = false;
  private gapping = false;
  private held: [LiveTopic, LiveMessage][] = [];
  /** Raw messages that arrived without a lease, waiting for lease.verify(). */
  private unverified: [Conn, string, Uint8Array][] = [];
  private verifying = false;
  private outbox = new Map<LiveTopic, LiveMessage[]>();
  private flushTimer: unknown = null;
  private lastStatusAt = 0;
  private counters = { handovers: 0, reconnects: 0, gapFilled: 0, maxSessions: 0 };
  /** Bumped by stop(): async work of an older generation is dropped. */
  private gen = 0;
  /** After a steal: the old leader's clientId, reused once so the broker kicks its (frozen) session. */
  private reuseClientId: string | undefined;
  /** After a steal: no handover before this (the old leader's other session may still be open). */
  private handoverAfter = 0;

  constructor(
    private deps: LiveDeps,
    state?: LiveState,
  ) {
    this.state = state ?? new LiveState();
  }

  // ---------------------------------------------------------------- control

  /**
   * This frame leads: stream whatever is subscribed. `gap`: continue a stream another frame was running.
   * After a steal: `clientId`, the old leader's active session's, for our first session (the broker kicks the
   * older one: OpenF1 does on a reused clientId), and no handover before `handoverAfter` (ms since the epoch)
   * unless releaseHandovers() comes first, so the old leader's sessions and ours never add up to three.
   */
  start(opts: { gap?: boolean; clientId?: string; handoverAfter?: number } = {}) {
    if (this.running) return;
    this.running = true;
    this.reuseClientId = opts.clientId;
    this.handoverAfter = opts.handoverAfter ?? 0;
    if (opts.gap && Object.keys(this.state.since).length) this.gapPending = true;
    this.kick();
  }

  /** The old leader has closed its sessions (it demoted): handovers may go ahead (one that waited, now). */
  releaseHandovers() {
    if (!this.handoverAfter) return;
    this.handoverAfter = 0;
    if (this.retryKind === "handover" && this.active && !this.next) {
      this.clearRetry();
      void this.open("handover");
    }
  }

  /** The active session's clientId (the heartbeat carries it, for a steal). */
  activeClientId(): string | null {
    return this.active?.clientId ?? null;
  }

  /** Stop streaming (disconnect, wipe). Forgets what was delivered when `reset`. */
  stop(opts: { reset?: boolean } = {}) {
    this.gen++;
    this.running = false;
    this.clearRetry();
    for (const c of [this.active, this.next, ...this.lingering]) if (c) c.session.close();
    this.active = this.next = null;
    this.lingering.clear();
    this.held = [];
    this.handoverAfter = 0;
    this.reuseClientId = undefined;
    this.unverified = [];
    this.verifying = false;
    this.gapping = false;
    this.gapPending = false;
    this.flush();
    if (opts.reset) this.state.reset();
    this.setPhase(this.topics.size ? "waiting" : "off");
  }

  /** The union of every tab's subscriptions. */
  setTopics(list: Iterable<LiveTopic>) {
    const next = new Set(list);
    const now = this.deps.now();
    for (const t of this.topics) if (!next.has(t)) this.state.forget(t);
    for (const t of next) if (!this.topics.has(t) && this.state.since[t] === undefined && this.active) this.state.since[t] = now;
    this.topics = next;
    if (!this.running) return this.deps.onStatus();
    if (!next.size) {
      this.stop();
      this.running = true;
      return;
    }
    if (this.active) void this.sync(this.active);
    else this.kick();
    this.deps.onStatus();
  }

  /** The scheduler has a new token: hand the stream over to a session using it. */
  onToken() {
    if (!this.running || !this.topics.size) return;
    if (this.active && !this.next) return void this.open("handover");
    if (!this.active && !this.next) {
      this.clearRetry();
      void this.open("connect");
    }
  }

  status(): StreamStatus {
    return {
      phase: this.phase,
      topics: [...this.topics].sort(),
      sessions: this.sessions(),
      maxSessions: this.counters.maxSessions,
      handovers: this.counters.handovers,
      reconnects: this.counters.reconnects,
      delivered: this.state.delivered,
      duplicates: this.state.duplicates,
      gapFilled: this.counters.gapFilled,
      lastSeen: { ...this.state.lastSeen },
      since: { ...this.state.since },
      ...(this.lastError && { lastError: this.lastError }),
      ...(this.retryAt !== undefined && { retryAt: this.retryAt }),
    };
  }

  // ---------------------------------------------------------------- sessions

  private sessions() {
    return [this.active, this.next, ...this.lingering].filter((c) => c && !c.session.closed).length;
  }

  private kick() {
    if (!this.running || !this.topics.size || this.active || this.next || this.retryTimer !== null) return;
    void this.open("connect");
  }

  private setPhase(p: StreamPhase) {
    if (this.phase === p) return;
    this.phase = p;
    this.deps.onStatus();
  }

  private clearRetry() {
    if (this.retryTimer !== null) this.deps.clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.retryKind = null;
    this.retryAt = undefined;
  }

  private jitter(ms: number) {
    return Math.round(ms * (1 - JITTER + 2 * JITTER * this.deps.random()));
  }

  private retry(kind: "connect" | "handover", delay: number) {
    this.clearRetry();
    this.retryKind = kind;
    this.retryAt = this.deps.now() + delay;
    this.retryTimer = this.deps.setTimeout(() => {
      this.retryTimer = null;
      this.retryAt = undefined;
      const k = this.retryKind;
      this.retryKind = null;
      if (!this.running || !this.topics.size) return;
      if (k === "handover" && !this.active) return void this.open("connect");
      if (k === "handover" && this.next) return;
      if (k === "connect" && (this.active || this.next)) return;
      void this.open(k!);
    }, delay);
    this.deps.onStatus();
  }

  private backoff() {
    return this.jitter(Math.min(RECONNECT_CAP_MS, RECONNECT_BASE_MS * 2 ** this.attempts++));
  }

  /** Open a session with the current token and subscribe; then make it the active one. */
  private async open(kind: "connect" | "handover") {
    const gen = this.gen;
    this.clearRetry();
    if (kind === "handover" && this.deps.now() < this.handoverAfter) return this.retry("handover", this.handoverAfter - this.deps.now());
    // (No await unless the lease needs checking: a second open() in the same tick must see this.next.)
    const lease = this.deps.lease;
    if (lease && !lease.ok() && (!(await lease.verify()) || gen !== this.gen)) return;
    if (kind === "handover" && this.lingering.size) {
      // The previous handover's old session is still closing: never a third session.
      return this.retry("handover", OVERLAP_MS);
    }
    let tok = this.deps.token();
    if (!tok || this.deps.now() >= tok.expiresAt) {
      if (kind === "handover") return; // A keeps streaming; the next token triggers another handover
      if (!tok) {
        // No login (or locked): nothing to poll. onToken() starts us when there is one.
        this.lastError = undefined;
        return this.setPhase("waiting");
      }
      // Expired (refreshes failing): ask once; the scheduler keeps retrying and onToken() fires on success.
      this.setPhase("waiting");
      const ok = await this.deps.refresh();
      if (gen !== this.gen || !this.running || this.active || this.next) return;
      tok = this.deps.token();
      if (!ok || !tok || this.deps.now() >= tok.expiresAt) {
        this.lastError = "no valid token";
        return this.deps.onStatus();
      }
    }
    if (kind === "connect") this.setPhase(this.gapPending || this.counters.reconnects ? "reconnecting" : "connecting");
    const topics = new Set(this.topics);
    const clientId = (kind === "connect" && this.reuseClientId) || randomClientId();
    this.reuseClientId = undefined;
    const conn: Conn = { topics, token: tok, closing: false, clientId, session: null as unknown as MqttSession };
    conn.session = new MqttSession({
      ...this.deps.session,
      url: this.deps.url,
      clientId,
      username: tok.username,
      password: tok.accessToken,
      socket: this.deps.socket,
      timers: this.deps,
      onMessage: (topic, payload) => this.onMessage(conn, topic, payload),
      onClose: (info) => this.onDrop(conn, describeClose(info)),
    });
    this.next = conn;
    this.counters.maxSessions = Math.max(this.counters.maxSessions, this.sessions());
    this.deps.onStatus();
    try {
      await conn.session.connect();
      const granted = await conn.session.subscribe([...topics].map((t) => TOPIC_PREFIX + t));
      if (granted.some((g) => g === 0x80)) throw new Error("subscription refused");
    } catch (e) {
      conn.session.close();
      if (this.next === conn) this.next = null;
      if (gen !== this.gen || !this.running) return;
      this.lastError = e instanceof Error ? e.message : "connect failed";
      if (isRefusedAuth(e)) {
        if (this.deps.now() < conn.token.expiresAt) {
          // The token is good: this is the connection cap. Keep A and the token; back off.
          this.setPhase("connection-limit");
          return this.retry(this.active ? "handover" : "connect", this.jitter(Math.min(LIMIT_CAP_MS, LIMIT_BASE_MS * 2 ** this.limitAttempts++)));
        }
        // Expired: a fresh token first, then again.
        const ok = await this.deps.refresh();
        if (gen !== this.gen || !this.running) return;
        if (ok && !this.active && !this.next) return void this.open("connect");
        if (this.active) return this.setPhase("connected");
        return this.retry("connect", this.backoff());
      }
      if (this.active) {
        this.setPhase("connected");
        return this.retry("handover", this.backoff());
      }
      this.setPhase("reconnecting");
      return this.retry("connect", this.backoff());
    }
    if (gen !== this.gen || !this.running || this.next !== conn) {
      conn.session.close();
      return;
    }
    this.next = null;
    this.attempts = 0;
    this.limitAttempts = 0;
    this.clearRetry();
    const old = this.active;
    this.active = conn;
    const now = this.deps.now();
    for (const t of topics) this.state.since[t] ??= now;
    // Topics changed while it was connecting: bring it up to date.
    void this.sync(conn);
    if (old) {
      this.counters.handovers++;
      this.setPhase("handover");
      old.closing = true;
      this.lingering.add(old);
      this.deps.setTimeout(() => {
        old.session.close();
        this.lingering.delete(old);
        if (this.phase === "handover") this.setPhase("connected");
        else this.deps.onStatus();
      }, OVERLAP_MS);
      return;
    }
    if (this.gapPending && !this.gapping) return void this.gapFill(gen);
    if (this.gapping) return this.setPhase("gap-filling");
    this.lastError = undefined;
    this.setPhase("connected");
  }

  /** Subscribe / unsubscribe the difference between a session's topics and the wanted set. */
  private async sync(conn: Conn) {
    const add = [...this.topics].filter((t) => !conn.topics.has(t));
    const drop = [...conn.topics].filter((t) => !this.topics.has(t));
    for (const t of add) conn.topics.add(t);
    for (const t of drop) conn.topics.delete(t);
    try {
      if (add.length) await conn.session.subscribe(add.map((t) => TOPIC_PREFIX + t));
      if (drop.length) await conn.session.unsubscribe(drop.map((t) => TOPIC_PREFIX + t));
      const now = this.deps.now();
      for (const t of add) this.state.since[t] ??= now;
    } catch {
      // The session ended: onDrop takes it from here.
    }
  }

  private onDrop(conn: Conn, why: string) {
    if (this.lingering.delete(conn)) return this.deps.onStatus();
    if (conn !== this.active) return;
    this.active = null;
    this.counters.reconnects++;
    this.lastError = why;
    if (!this.running) return;
    // Nothing overlapped it: whatever was published until the next session subscribes is missing.
    this.gapPending = true;
    if (this.next) return this.setPhase("reconnecting"); // a handover in flight becomes the reconnect
    this.setPhase("reconnecting");
    this.retry("connect", this.backoff());
  }

  // ---------------------------------------------------------------- data

  /** Whether this frame still leads (the lease, or a lock check). False also when stop() came meanwhile. */
  private async leading(gen: number): Promise<boolean> {
    const lease = this.deps.lease;
    if (lease && !lease.ok() && !(await lease.verify())) return false;
    return gen === this.gen;
  }

  private onMessage(conn: Conn, topic: string, payload: Uint8Array) {
    if (conn !== this.active && conn !== this.next && !this.lingering.has(conn)) return;
    const lease = this.deps.lease;
    if (lease && !lease.ok()) {
      this.unverified.push([conn, topic, payload]);
      if (this.verifying) return;
      this.verifying = true;
      const gen = this.gen;
      void lease.verify().then((ok) => {
        if (gen !== this.gen) return;
        this.verifying = false;
        const q = this.unverified;
        this.unverified = [];
        if (ok) for (const [c, t, p] of q) this.onMessage(c, t, p);
      });
      return;
    }
    if (!topic.startsWith(TOPIC_PREFIX)) return;
    const t = topic.slice(TOPIC_PREFIX.length) as LiveTopic;
    if (!this.topics.has(t)) return;
    let m: unknown;
    try {
      m = JSON.parse(new TextDecoder().decode(payload));
    } catch {
      return;
    }
    if (!m || typeof m !== "object" || Array.isArray(m)) return;
    if (this.gapping) return void this.held.push([t, m as LiveMessage]);
    this.deliver(t, m as LiveMessage);
  }

  private deliver(topic: LiveTopic, m: LiveMessage): boolean {
    if (!this.state.accept(topic, m)) return false;
    let box = this.outbox.get(topic);
    if (!box) this.outbox.set(topic, (box = []));
    box.push(m);
    if (this.flushTimer === null) this.flushTimer = this.deps.setTimeout(() => this.flush(), FLUSH_MS);
    return true;
  }

  /** Emit what's batched now (before a snapshot of the seen keys goes to another frame). */
  flushNow() {
    this.flush();
  }

  private flush() {
    if (this.flushTimer !== null) this.deps.clearTimeout(this.flushTimer);
    this.flushTimer = null;
    if (!this.outbox.size) return;
    const batches: Batch[] = [...this.outbox].map(([topic, ms]) => ({ topic, messages: byDate(ms) }));
    this.outbox.clear();
    this.deps.emit(batches);
    const now = this.deps.now();
    if (now - this.lastStatusAt >= STATUS_EVERY_MS) {
      this.lastStatusAt = now;
      this.deps.onStatus();
    }
  }

  /** After a reconnect: fetch what was missed, per topic, emit it in order, then what arrived meanwhile. */
  private async gapFill(gen: number) {
    this.gapPending = false;
    this.gapping = true;
    this.setPhase("gap-filling");
    const key = this.state.sessionKey ?? "latest";
    const failed: string[] = [];
    for (const topic of [...this.topics]) {
      if (gen !== this.gen) return;
      const params: Params = { session_key: key };
      if (DATED.has(topic)) {
        const from = this.state.lastSeen[topic] ?? (this.state.since[topic] !== undefined ? isoDate(this.state.since[topic]! - GAP_MARGIN_MS) : undefined);
        if (from === undefined) continue; // never streamed: nothing to fill
        params["date>="] = from;
      } else if (this.state.since[topic] === undefined) continue;
      const rows = await this.fetchRows(topic, params, gen);
      if (!(await this.leading(gen))) return;
      if (!rows) {
        failed.push(topic);
        continue;
      }
      for (const r of byDate(rows)) if (this.deliver(topic, r)) this.counters.gapFilled++;
      this.flush();
    }
    if (gen !== this.gen) return;
    this.gapping = false;
    const held = this.held;
    this.held = [];
    for (const [t, m] of held) this.deliver(t, m);
    this.flush();
    this.lastError = failed.length ? `gap-fill failed for ${failed.join(", ")}` : undefined;
    // It dropped again meanwhile and is already back: that gap too.
    if (this.gapPending && this.active) return void this.gapFill(gen);
    this.setPhase(this.active ? "connected" : "reconnecting");
    this.deps.onStatus();
  }

  private async fetchRows(topic: LiveTopic, params: Params, gen: number): Promise<LiveMessage[] | null> {
    for (let i = 0; i < GAP_TRIES; i++) {
      if (i) await new Promise((r) => this.deps.setTimeout(() => r(null), this.jitter(1000 * 2 ** i)));
      if (gen !== this.gen) return null;
      try {
        const res = await this.deps.rest(topic, params);
        if (res.status === 404) return []; // OpenF1: "no results"
        if (res.status !== 200) continue;
        const rows: unknown = JSON.parse(new TextDecoder().decode(res.body));
        if (!Array.isArray(rows)) return null;
        return rows.filter((r): r is LiveMessage => !!r && typeof r === "object" && !Array.isArray(r));
      } catch {
        // network or JSON: try again
      }
    }
    return null;
  }
}

/** A local time as OpenF1 writes dates: `2025-03-22T02:18:36.428000+00:00`. */
export function isoDate(ms: number): string {
  return new Date(ms).toISOString().replace("Z", "000+00:00");
}
