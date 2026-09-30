// Dev vault only (simulate mode, VAULT_SIMULATE on the vault dev server): a cached session replayed as if it
// were live, with the vault's REAL code paths from the socket up. frame.ts uses this only behind
// __VAULT_DEV__ && __VAULT_SIMULATE__, so a build drops it (e2e checks dist/).
//
// The substitution is at the transport boundary:
// - MQTT: SimBroker.socket() is the socket factory. It returns a SocketLike (what mqtt.ts drives a WebSocket
//   through) behind which this module plays OpenF1's broker in real MQTT 3.1.1 bytes: CONNECT (the token is
//   checked by the dev server: CONNACK 5 when invalid, expired, or when a refusal is armed), SUBSCRIBE /
//   UNSUBSCRIBE, PINGREQ, a 1.5 x keepalive timeout, clientId kicks, PUBLISH frames that may split packets
//   anywhere. So mqtt.ts, live.ts (handover, dedupe, gap-fill), the scheduler and the cross-tab leader all run
//   unchanged.
// - The published messages come from the vault dev server (simserver.ts: /__sim/feed), which built the
//   session's timeline from data/raw; each frame's broker fetches the part it needs just ahead of the sim
//   clock. Every frame computes the same clock from the server's anchor, and numbers messages (`_id`) by their
//   place in the timeline, so the stream is the same whichever frame leads.
// - REST (the Rest class, real fetch) and /token go to the dev server too (/__sim/v1/, /__sim/token): fake
//   tokens with a configurable lifetime, REST answered from the same data up to the current sim time.
// - The dev server also counts sessions across frames (so ≤ 2 concurrent sessions is measurable), and holds the
//   faults: forced drops (every N minutes, or on demand) and CONNACK 5 refusals.
//
// Nothing here is OpenF1's: the app shows "SIMULATED" whenever status.sim is set.

import { decodeConnect, decodeTopics, encodeConnack, encodePingresp, encodePublish, encodeSuback, encodeUnsuback } from "./brokercodec";
import { CONNECT, DISCONNECT, PINGREQ, PUBACK, PacketReader, SUBSCRIBE, UNSUBSCRIBE, type SocketFactory, type SocketLike } from "./mqtt";
import type { SimAction, SimStatus } from "./protocol";
import type { Timers } from "./scheduler";

/** What /__sim/config answers. */
export type SimConfig = SimStatus & { topics: string[]; keepaliveCheck: boolean };

/** Deliver every this often (wall ms). */
export const PUMP_MS = 100;
/** Fetch the feed this far (sim ms) ahead of the clock, in pieces this long. */
export const LOOKAHEAD_MS = 20_000;
/** Report the open sessions to the dev server (and learn about drops and resets) this often. */
export const SYNC_MS = 1_000;
/** The biggest WebSocket frame the broker sends. */
const FRAME_MAX = 32 * 1024;

type Feed = { ids: number[]; at: number[]; topic: number[]; payload: string[] };

export type SimDeps = {
  /** The dev server's simulation endpoints, e.g. http://localhost:5174/__sim */
  base: string;
  config: SimConfig;
  timers: Timers;
  fetch: typeof fetch;
  random?: () => number;
};

export const simNowOf = (c: Pick<SimStatus, "anchorWall" | "speed">, wall: number) => c.anchorWall + (wall - c.anchorWall) * c.speed;

/** Load the simulation's config from the dev server (the frame waits for it before starting). */
export async function loadSimConfig(base: string, f: typeof fetch = fetch): Promise<SimConfig> {
  const r = await f(`${base}/config`, { credentials: "omit" });
  if (r.status !== 200) throw new Error(`simulation config: HTTP ${r.status}`);
  return (await r.json()) as SimConfig;
}

type Conn = {
  id: string;
  sock: SimSocket;
  reader: PacketReader;
  state: "new" | "connecting" | "open" | "closed";
  clientId: string;
  keepaliveMs: number;
  lastClientAt: number;
  /** v1/<topic> -> the broker's publish mark (sentTo) when it subscribed: only messages after it go to it. */
  subs: Map<string, number>;
  /** Frames waiting for delivery (jitter keeps their order). */
  out: Uint8Array[];
  deliverAt: number;
  timer: unknown;
};

/** The client's end of a simulated connection: what mqtt.ts sees as a WebSocket. */
class SimSocket implements SocketLike {
  binaryType = "blob";
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  closed = false;

  constructor(
    private broker: SimBroker,
    readonly conn: () => Conn,
  ) {}

  send(data: Uint8Array) {
    if (this.closed) throw new Error("closed");
    const copy = new Uint8Array(data);
    this.broker.fromClient(this.conn(), copy);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.broker.clientClosed(this.conn());
  }
}

export class SimBroker {
  readonly instance = randomId();
  private conns = new Set<Conn>();
  private feed: Feed = { ids: [], at: [], topic: [], payload: [] };
  /** Everything up to here (sim ms) has been delivered (or had nobody to go to). */
  private sentTo: number;
  /** The feed has been fetched up to here (sim ms). */
  private fedTo: number;
  private fetching = false;
  private pumpTimer: unknown = null;
  private syncTimer: unknown = null;
  private lastDrop: number | null = null;
  private random: () => number;
  private nextConn = 1;
  /** Counters for the debug panel. */
  stats = { published: 0, frames: 0, dropped: 0, feedFetches: 0, feedErrors: 0 };

  constructor(private deps: SimDeps) {
    this.random = deps.random ?? Math.random;
    this.sentTo = this.fedTo = this.now();
    this.sync();
  }

  get config() {
    return this.deps.config;
  }

  /** The sim clock now. */
  now() {
    return simNowOf(this.deps.config, this.deps.timers.now());
  }

  status(): SimStatus {
    const { topics, keepaliveCheck, ...s } = this.deps.config;
    return s;
  }

  /** The socket factory for live.ts (the URL is ignored: it's OpenF1's, unchanged). */
  socket: SocketFactory = () => {
    let conn: Conn;
    const sock = new SimSocket(this, () => conn);
    conn = { id: `${this.instance}-${this.nextConn++}`, sock, reader: new PacketReader(), state: "new", clientId: "", keepaliveMs: 0, lastClientAt: this.deps.timers.now(), subs: new Map(), out: [], deliverAt: 0, timer: null };
    this.conns.add(conn);
    this.deps.timers.setTimeout(() => {
      if (!sock.closed) sock.onopen?.({});
    }, 1);
    return sock;
  };

  /** A dev-server control (the debug panel's buttons; any frame may call it). */
  async control(action: SimAction): Promise<void> {
    await this.deps.fetch(`${this.deps.base}/control/${action}`, { method: "POST", credentials: "omit" });
    if (action === "drop") this.syncNow();
  }

  /** The tab is going away: its sessions end with it (a closed tab's sockets close). */
  bye() {
    try {
      navigator.sendBeacon(`${this.deps.base}/bye`, JSON.stringify({ instance: this.instance }));
    } catch {}
  }

  // ---------------------------------------------------------------- the broker side

  fromClient(c: Conn, bytes: Uint8Array) {
    // The network: the broker sees it a moment later.
    this.deps.timers.setTimeout(() => this.onBytes(c, bytes), 1);
  }

  clientClosed(c: Conn) {
    this.end(c, null);
  }

  private onBytes(c: Conn, bytes: Uint8Array) {
    if (c.state === "closed") return;
    c.lastClientAt = this.deps.timers.now();
    let packets;
    try {
      packets = c.reader.push(bytes);
    } catch {
      return this.end(c, 1002);
    }
    for (const p of packets) {
      if (closed(c)) return; // a packet before this one ended it
      if (c.state === "new" && p.type !== CONNECT) return this.end(c, 1002);
      switch (p.type) {
        case CONNECT:
          if (c.state !== "new") return this.end(c, 1002);
          c.state = "connecting";
          void this.connect(c, decodeConnect(p));
          break;
        case SUBSCRIBE: {
          const { packetId, topics } = decodeTopics(p, true);
          // Like a broker: it gets whatever is published from now on, i.e. everything the pump hasn't sent yet
          // (not "everything after the sim clock": the pump may lag behind it while the feed loads).
          if (!this.subscribed()) this.sentTo = this.fedTo = Math.max(this.sentTo, this.now());
          for (const t of topics) c.subs.set(t, this.sentTo);
          this.send(c, encodeSuback(packetId, topics.map((t) => (this.deps.config.topics.includes(t.replace(/^v1\//, "")) ? 0 : 0x80))));
          this.ensurePump();
          break;
        }
        case UNSUBSCRIBE: {
          const { packetId, topics } = decodeTopics(p, false);
          for (const t of topics) c.subs.delete(t);
          this.send(c, encodeUnsuback(packetId));
          break;
        }
        case PINGREQ:
          this.send(c, encodePingresp());
          break;
        case PUBACK:
          break;
        case DISCONNECT:
          return this.end(c, 1000);
        default:
          return this.end(c, 1002);
      }
    }
  }

  private async connect(c: Conn, m: ReturnType<typeof decodeConnect>) {
    let code = 3; // server unavailable, if the dev server can't be asked
    try {
      const r = await this.deps.fetch(`${this.deps.base}/connect`, {
        method: "POST",
        credentials: "omit",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instance: this.instance, session: c.id, clientId: m.clientId, username: m.username ?? "", password: m.password ?? "", keepaliveS: m.keepaliveS }),
      });
      if (r.status === 200) code = ((await r.json()) as { code: number }).code;
    } catch {}
    if (c.state !== "connecting") return;
    if (code !== 0) {
      this.send(c, encodeConnack(code));
      // OpenF1 closes the connection after a refusal: after the CONNACK is delivered (end() drops what's still
      // queued, and with delivery jitter above 20 ms the refusal was lost: the client saw a bare close).
      this.deps.timers.setTimeout(() => this.end(c, 1000, false), Math.max(0, c.deliverAt - this.deps.timers.now()) + 20);
      return;
    }
    // A reused clientId kicks the older session (OpenF1 does too).
    for (const o of this.conns) if (o !== c && o.state === "open" && o.clientId === m.clientId) this.end(o, 1000);
    c.state = "open";
    c.clientId = m.clientId;
    c.keepaliveMs = m.keepaliveS * 1000;
    this.send(c, encodeConnack(0));
  }

  /** Queue bytes for the client, in order, after the configured jitter. */
  private send(c: Conn, bytes: Uint8Array) {
    if (c.state === "closed") return;
    c.out.push(bytes);
    if (c.timer !== null) return;
    const now = this.deps.timers.now();
    const jitter = this.deps.config.jitterMs > 0 ? this.random() * this.deps.config.jitterMs : 0;
    c.deliverAt = Math.max(c.deliverAt, now + jitter);
    c.timer = this.deps.timers.setTimeout(() => this.flushTo(c), Math.max(0, c.deliverAt - now));
  }

  private flushTo(c: Conn) {
    c.timer = null;
    if (c.state === "closed" || c.sock.closed) return;
    const all = c.out;
    c.out = [];
    let total = 0;
    for (const b of all) total += b.length;
    const buf = new Uint8Array(total);
    let at = 0;
    for (const b of all) {
      buf.set(b, at);
      at += b.length;
    }
    // WebSocket frames of up to FRAME_MAX, cut anywhere (a packet may span frames, a frame may hold several).
    let from = 0;
    while (from < buf.length) {
      const cut = Math.min(buf.length, from + Math.max(1, Math.floor(FRAME_MAX * (0.5 + this.random() / 2))));
      const piece = buf.slice(from, cut);
      from = cut;
      this.stats.frames++;
      c.sock.onmessage?.({ data: piece.buffer });
      if (closed(c) || c.sock.closed) return;
    }
  }

  /** End a session. `code`: the broker (or network) closed it (the client gets onclose); null: the client did. */
  private end(c: Conn, code: number | null, report = true) {
    if (c.state === "closed") return;
    const wasOpen = c.state === "open";
    c.state = "closed";
    this.conns.delete(c);
    if (c.timer !== null) this.deps.timers.clearTimeout(c.timer);
    c.out = [];
    if (wasOpen && report) void this.deps.fetch(`${this.deps.base}/close`, { method: "POST", credentials: "omit", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ instance: this.instance, session: c.id }) }).catch(() => {});
    if (code !== null && !c.sock.closed) {
      c.sock.closed = true;
      this.deps.timers.setTimeout(() => c.sock.onclose?.({ code, reason: "" }), 1);
    }
  }

  /** Every session, abruptly (a network blip, or the dev server's forced drop). */
  dropAll() {
    for (const c of [...this.conns]) if (c.state === "open" || c.state === "connecting") {
      this.stats.dropped++;
      this.end(c, 1006);
    }
  }

  // ---------------------------------------------------------------- publishing

  private subscribed() {
    for (const c of this.conns) if (c.state === "open" && c.subs.size) return true;
    return false;
  }

  private ensurePump() {
    if (this.pumpTimer === null) this.pumpTimer = this.deps.timers.setTimeout(() => this.pump(), 0);
  }

  private pump() {
    this.pumpTimer = null;
    const now = this.now();
    const wall = this.deps.timers.now();
    // The broker drops a client that has sent nothing for 1.5 x its keepalive.
    if (this.deps.config.keepaliveCheck) for (const c of [...this.conns]) if (c.state === "open" && c.keepaliveMs > 0 && wall - c.lastClientAt > c.keepaliveMs * 1.5) this.end(c, 1006);
    if (!this.subscribed()) {
      // Published to nobody: forget it, and fetch from here when someone subscribes.
      this.sentTo = Math.max(this.sentTo, now);
      if (!this.fetching) this.fedTo = Math.max(this.fedTo, this.sentTo);
      this.trimFeed(this.sentTo);
      if (this.conns.size) this.pumpTimer = this.deps.timers.setTimeout(() => this.pump(), PUMP_MS);
      return;
    }
    if (this.fedTo < now + LOOKAHEAD_MS / 2) void this.fetchFeed();
    const limit = Math.min(now, this.fedTo);
    if (limit > this.sentTo) {
      const f = this.feed;
      let i = 0;
      while (i < f.at.length && f.at[i]! <= limit) {
        if (f.at[i]! > this.sentTo) this.publish(i);
        i++;
      }
      this.sentTo = limit;
      this.trimFeed(limit);
    }
    this.pumpTimer = this.deps.timers.setTimeout(() => this.pump(), PUMP_MS);
  }

  private publish(i: number) {
    const f = this.feed;
    const topic = `v1/${this.deps.config.topics[f.topic[i]!]}`;
    const at = f.at[i]!;
    let bytes: Uint8Array | undefined;
    for (const c of this.conns) {
      if (c.state !== "open") continue;
      const since = c.subs.get(topic);
      if (since === undefined || at <= since) continue;
      bytes ??= encodePublish(topic, f.payload[i]!);
      this.send(c, bytes);
    }
    if (bytes) this.stats.published++;
  }

  /** Drop fed events at or before `upTo`. */
  private trimFeed(upTo: number) {
    const f = this.feed;
    let n = 0;
    while (n < f.at.length && f.at[n]! <= upTo) n++;
    if (!n) return;
    f.ids.splice(0, n);
    f.at.splice(0, n);
    f.topic.splice(0, n);
    f.payload.splice(0, n);
  }

  private async fetchFeed() {
    if (this.fetching) return;
    this.fetching = true;
    const from = this.fedTo;
    const to = this.now() + LOOKAHEAD_MS;
    try {
      this.stats.feedFetches++;
      const r = await this.deps.fetch(`${this.deps.base}/feed?from=${from}&to=${to}`, { credentials: "omit" });
      if (r.status !== 200) throw new Error(String(r.status));
      const got = (await r.json()) as { to: number; events: [number, number, number, string][] };
      if (this.fedTo !== from) return; // reset meanwhile
      for (const [id, at, topic, payload] of got.events) {
        this.feed.ids.push(id);
        this.feed.at.push(at);
        this.feed.topic.push(topic);
        this.feed.payload.push(payload);
      }
      this.fedTo = got.to;
    } catch {
      this.stats.feedErrors++;
    } finally {
      this.fetching = false;
    }
  }

  // ---------------------------------------------------------------- the dev server

  private syncNow() {
    if (this.syncTimer !== null) this.deps.timers.clearTimeout(this.syncTimer);
    this.syncTimer = null;
    void this.doSync();
  }

  private sync() {
    this.syncTimer = this.deps.timers.setTimeout(() => {
      this.syncTimer = null;
      void this.doSync();
    }, SYNC_MS);
  }

  private async doSync() {
    try {
      // "connecting" too: its /connect may already have registered it, and the dev server forgets every session
      // of ours this list leaves out (which would hide it from the concurrent-session count).
      const open = [...this.conns].filter((c) => c.state === "open" || c.state === "connecting").map((c) => c.id);
      const r = await this.deps.fetch(`${this.deps.base}/sync`, { method: "POST", credentials: "omit", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ instance: this.instance, sessions: open }) });
      if (r.status === 200) {
        const s = (await r.json()) as { version: number; drop: number; kick?: string[] };
        // Kicked by another frame's session with the same clientId (a steal): closed by the broker.
        for (const id of s.kick ?? []) for (const c of [...this.conns]) if (c.id === id) this.end(c, 1000, false);
        if (s.version !== this.deps.config.version) {
          // The simulation was reset: a new clock. Like a broker restart: every session drops.
          this.deps.config = await loadSimConfig(this.deps.base, this.deps.fetch);
          this.feed = { ids: [], at: [], topic: [], payload: [] };
          this.sentTo = this.fedTo = this.now();
          this.lastDrop = null;
          this.dropAll();
        }
        if (this.lastDrop !== null && s.drop > this.lastDrop) this.dropAll();
        this.lastDrop = s.drop;
      }
    } catch {}
    if (this.syncTimer === null) this.sync();
  }
}

/** (A function, so TypeScript doesn't narrow the state across calls that change it.) */
const closed = (c: Conn) => c.state === "closed";

function randomId() {
  return [...crypto.getRandomValues(new Uint8Array(6))].map((b) => b.toString(16).padStart(2, "0")).join("");
}
