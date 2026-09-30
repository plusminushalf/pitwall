// A small local stand-in for OpenF1's live feed, for the vault's tests and for trying the stream by hand.
// Dev and test only: never shipped, never referenced by vault/src. Bun, no dependencies.
//
// - MQTT 3.1.1 over WebSocket at ws://HOST:PORT/mqtt (subprotocol "mqtt"): CONNECT / CONNACK, SUBSCRIBE /
//   SUBACK, UNSUBSCRIBE / UNSUBACK, PUBLISH (QoS 0), PINGREQ / PINGRESP, DISCONNECT. Any non-empty password
//   is accepted (the vault sends its token), but like OpenF1 the username must be an email (else CONNACK 5).
//   A reused clientId kicks the older session, like OpenF1.
// - REST at http://HOST:PORT/v1/<topic>?session_key=…&date>=…: everything published on v1/<topic> so far,
//   without `_id` / `_key` (like OpenF1's REST), filtered by the params the vault's gap-fill sends.
// - Controls, in process (FakeBroker) or over HTTP: publish, drop connections, refuse the next CONNECTs with
//   CONNACK 5, count concurrent sessions, a synthetic stream.
//
//   bun vault/fakebroker.ts [--port 5191] [--rate 20]     then: VAULT_FAKE_BROKER=http://localhost:5191 bun run vault
//
//   curl -X POST localhost:5191/control/stream?rate=20     start (or change) the synthetic stream; rate=0 stops it
//   curl -X POST localhost:5191/control/drop               drop every connection (the vault reconnects and gap-fills)
//   curl -X POST localhost:5191/control/refuse?n=1         the next CONNECT gets CONNACK 5 (the connection cap)
//   curl localhost:5191/control/stats                      sessions now / max, connects, refusals, published

import type { Server, ServerWebSocket } from "bun";
import {
  CONNACK,
  CONNECT,
  DISCONNECT,
  PINGREQ,
  PINGRESP,
  PUBACK,
  PUBLISH,
  PacketReader,
  ProtocolError,
  SUBACK,
  SUBSCRIBE,
  UNSUBACK,
  UNSUBSCRIBE,
  frame,
  mqttString,
  readString,
  type RawPacket,
} from "./src/mqtt";

// ---------------------------------------------------------------- server-side codec

export type Connect = { protocol: string; level: number; clean: boolean; keepaliveS: number; clientId: string; username?: string; password?: string };

export function decodeConnect(p: RawPacket): Connect {
  const b = p.body;
  let [protocol, at] = readString(b, 0);
  const level = b[at++]!;
  const flags = b[at++]!;
  const keepaliveS = (b[at]! << 8) | b[at + 1]!;
  at += 2;
  let clientId: string;
  [clientId, at] = readString(b, at);
  if (flags & 0x04) {
    // will topic + message: skip
    at = readString(b, at)[1];
    at = readString(b, at)[1];
  }
  let username: string | undefined;
  let password: string | undefined;
  if (flags & 0x80) [username, at] = readString(b, at);
  if (flags & 0x40) [password, at] = readString(b, at);
  return { protocol, level, clean: !!(flags & 0x02), keepaliveS, clientId, ...(username !== undefined && { username }), ...(password !== undefined && { password }) };
}

/** SUBSCRIBE / UNSUBSCRIBE body: packet id, then topic filters (with a QoS byte each for SUBSCRIBE). */
export function decodeTopics(p: RawPacket, withQos: boolean): { packetId: number; topics: string[] } {
  const b = p.body;
  const packetId = (b[0]! << 8) | b[1]!;
  const topics: string[] = [];
  let at = 2;
  while (at < b.length) {
    const [t, next] = readString(b, at);
    topics.push(t);
    at = next + (withQos ? 1 : 0);
  }
  if (!topics.length) throw new ProtocolError("no topics");
  return { packetId, topics };
}

export const encodeConnack = (code: number, sessionPresent = false) => frame(CONNACK, 0, new Uint8Array([sessionPresent ? 1 : 0, code]));
export const encodeSuback = (packetId: number, granted: number[]) => frame(SUBACK, 0, new Uint8Array([packetId >> 8, packetId & 0xff, ...granted]));
export const encodeUnsuback = (packetId: number) => frame(UNSUBACK, 0, new Uint8Array([packetId >> 8, packetId & 0xff]));
export const encodePingresp = () => frame(PINGRESP, 0);

export function encodePublish(topic: string, payload: Uint8Array | string, opts: { qos?: 0 | 1; packetId?: number; retain?: boolean } = {}): Uint8Array {
  const t = mqttString(topic);
  const body = typeof payload === "string" ? new TextEncoder().encode(payload) : payload;
  const id = opts.qos ? new Uint8Array([(opts.packetId ?? 1) >> 8, (opts.packetId ?? 1) & 0xff]) : new Uint8Array(0);
  const out = new Uint8Array(t.length + id.length + body.length);
  out.set(t, 0);
  out.set(id, t.length);
  out.set(body, t.length + id.length);
  return frame(PUBLISH, ((opts.qos ?? 0) << 1) | (opts.retain ? 1 : 0), out);
}

// ---------------------------------------------------------------- the broker

type Client = { id: number; clientId: string | null; subs: Set<string>; reader: PacketReader; open: boolean; connectedAt: number };
type Rec = Record<string, unknown>;

export type Stats = { current: number; max: number; connects: number; refused: number; kicked: number; dropped: number; published: number; restRequests: number; restAuthorized: number };

/** A date the way OpenF1 writes them: `2025-03-22T02:18:36.428000+00:00`. */
export const openf1Date = (ms: number) => new Date(ms).toISOString().replace("Z", "000+00:00");

export const SESSION_KEY = 9999;
const STREAM_TOPICS = ["car_data", "position", "intervals", "race_control", "location", "weather", "laps"] as const;

export class FakeBroker {
  readonly server: Server<Client>;
  private clients = new Set<ServerWebSocket<Client>>();
  private nextClient = 1;
  private nextMsgId = 1;
  /** Everything published, per topic (without v1/): the REST side. */
  readonly records = new Map<string, Rec[]>();
  /** Every publish in order (for tests: what the app should have received). */
  readonly log: { topic: string; msg: Rec }[] = [];
  refuseNext = 0;
  stats: Stats = { current: 0, max: 0, connects: 0, refused: 0, kicked: 0, dropped: 0, published: 0, restRequests: 0, restAuthorized: 0 };
  private stream: ReturnType<typeof setInterval> | null = null;
  private n = 0;

  constructor(opts: { port?: number; hostname?: string } = {}) {
    const broker = this;
    this.server = Bun.serve<Client>({
      port: opts.port ?? 0,
      hostname: opts.hostname ?? "127.0.0.1",
      fetch(req, server) {
        const url = new URL(req.url);
        if (url.pathname === "/mqtt") {
          const protocols = (req.headers.get("sec-websocket-protocol") ?? "").split(",").map((s) => s.trim());
          if (!protocols.includes("mqtt")) return new Response("subprotocol mqtt required", { status: 400 });
          const ok = server.upgrade(req, {
            headers: { "Sec-WebSocket-Protocol": "mqtt" },
            data: { id: broker.nextClient++, clientId: null, subs: new Set(), reader: new PacketReader(), open: false, connectedAt: 0 },
          });
          return ok ? undefined : new Response("upgrade failed", { status: 400 });
        }
        return broker.http(req, url);
      },
      websocket: {
        open(ws) {
          broker.clients.add(ws);
        },
        message(ws, data) {
          const bytes = typeof data === "string" ? null : new Uint8Array(data);
          if (!bytes) return ws.close(1003, "binary only");
          try {
            for (const p of ws.data.reader.push(bytes)) broker.onPacket(ws, p);
          } catch {
            ws.close(1002, "protocol error");
          }
        },
        close(ws) {
          broker.clients.delete(ws);
          if (ws.data.open) {
            ws.data.open = false;
            broker.stats.current--;
          }
        },
      },
    });
  }

  get port() {
    return this.server.port!;
  }
  /** http://127.0.0.1:PORT */
  get origin() {
    return `http://${this.server.hostname}:${this.port}`;
  }

  private onPacket(ws: ServerWebSocket<Client>, p: RawPacket) {
    const c = ws.data;
    if (!c.open && p.type !== CONNECT) return ws.close(1002, "CONNECT first");
    switch (p.type) {
      case CONNECT: {
        if (c.open) return ws.close(1002, "second CONNECT");
        const m = decodeConnect(p);
        if (m.protocol !== "MQTT" || m.level !== 4) {
          ws.sendBinary(encodeConnack(1));
          return ws.close(1000);
        }
        if (this.refuseNext > 0 || !m.password || !m.username?.includes("@")) {
          if (this.refuseNext > 0) this.refuseNext--;
          this.stats.refused++;
          ws.sendBinary(encodeConnack(5));
          return ws.close(1000);
        }
        // A reused clientId kicks the older session (OpenF1 does this too).
        for (const other of this.clients) {
          if (other !== ws && other.data.open && other.data.clientId === m.clientId) {
            this.stats.kicked++;
            other.close(1000, "session taken over");
          }
        }
        c.clientId = m.clientId;
        c.open = true;
        c.connectedAt = Date.now();
        this.stats.connects++;
        this.stats.current++;
        this.stats.max = Math.max(this.stats.max, this.stats.current);
        ws.sendBinary(encodeConnack(0));
        return;
      }
      case SUBSCRIBE: {
        const { packetId, topics } = decodeTopics(p, true);
        for (const t of topics) c.subs.add(t);
        ws.sendBinary(encodeSuback(packetId, topics.map(() => 0)));
        return;
      }
      case UNSUBSCRIBE: {
        const { packetId, topics } = decodeTopics(p, false);
        for (const t of topics) c.subs.delete(t);
        ws.sendBinary(encodeUnsuback(packetId));
        return;
      }
      case PINGREQ:
        ws.sendBinary(encodePingresp());
        return;
      case PUBACK:
        return;
      case DISCONNECT:
        return ws.close(1000);
      default:
        return ws.close(1002, "unexpected packet");
    }
  }

  /** Publish one record on v1/<topic> (an `_id` is added like OpenF1's MQTT; REST keeps it without). */
  publish(topic: string, msg: Rec): Rec {
    const withId = { ...msg, _id: this.nextMsgId++ };
    const bytes = encodePublish(`v1/${topic}`, JSON.stringify(withId));
    for (const ws of this.clients) if (ws.data.open && (ws.data.subs.has(`v1/${topic}`) || ws.data.subs.has("v1/#") || ws.data.subs.has("#"))) ws.sendBinary(bytes);
    const { _id, _key, ...rest } = withId as Rec;
    let list = this.records.get(topic);
    if (!list) this.records.set(topic, (list = []));
    list.push(rest);
    this.log.push({ topic, msg: withId });
    this.stats.published++;
    return withId;
  }

  /** The next synthetic record for a topic: a unique `n`, the current date, OpenF1-like fields. */
  synthetic(topic: string): Rec {
    const n = ++this.n;
    const base = { session_key: SESSION_KEY, meeting_key: 1, date: openf1Date(Date.now()), n };
    const driver = [1, 4, 16, 44, 63, 81][n % 6]!;
    switch (topic) {
      case "car_data":
        return { ...base, driver_number: driver, speed: 200 + (n % 120), rpm: 11000, n_gear: 7, throttle: 99, brake: 0, drs: 0 };
      case "location":
        return { ...base, driver_number: driver, x: n % 1000, y: 0, z: 0 };
      case "position":
        return { ...base, driver_number: driver, position: 1 + (n % 20) };
      case "intervals":
        return { ...base, driver_number: driver, interval: (n % 50) / 10, gap_to_leader: n % 100 };
      case "race_control":
        return { ...base, category: "Other", flag: null, scope: null, message: `message ${n}`, lap_number: 1 };
      case "weather":
        return { ...base, air_temperature: 21, track_temperature: 33, humidity: 26, rainfall: 0 };
      case "laps": {
        const { date, ...rest } = base;
        return { ...rest, date_start: date, driver_number: driver, lap_number: n, lap_duration: 90 + (n % 5) };
      }
      default:
        return base;
    }
  }

  /** Publish `rate` messages per second, round-robin over `topics`. rate 0 stops. */
  startStream(rate: number, topics: readonly string[] = STREAM_TOPICS) {
    this.stopStream();
    if (rate <= 0) return;
    let i = 0;
    this.stream = setInterval(() => {
      const topic = topics[i++ % topics.length]!;
      this.publish(topic, this.synthetic(topic));
    }, 1000 / rate);
  }

  stopStream() {
    if (this.stream) clearInterval(this.stream);
    this.stream = null;
  }

  /** Drop connections abruptly (no DISCONNECT, no close handshake): "all", or the oldest / newest session. */
  drop(which: "all" | "oldest" | "newest" = "all"): number {
    const open = [...this.clients].filter((c) => c.data.open).sort((a, b) => a.data.connectedAt - b.data.connectedAt);
    const victims = which === "all" ? open : which === "oldest" ? open.slice(0, 1) : open.slice(-1);
    for (const ws of victims) {
      this.stats.dropped++;
      ws.terminate();
    }
    return victims.length;
  }

  refuse(n = 1) {
    this.refuseNext = n;
  }

  resetStats() {
    this.stats = { ...this.stats, max: this.stats.current, connects: 0, refused: 0, kicked: 0, dropped: 0, published: 0, restRequests: 0, restAuthorized: 0 };
  }

  sessions(): { clientId: string | null; subs: string[] }[] {
    return [...this.clients].filter((c) => c.data.open).map((c) => ({ clientId: c.data.clientId, subs: [...c.data.subs] }));
  }

  stop() {
    this.stopStream();
    this.server.stop(true);
  }

  // ---------------------------------------------------------------- HTTP: REST and controls

  private http(req: Request, url: URL): Response {
    const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization", "Access-Control-Allow-Methods": "GET, POST" };
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    const json = (x: unknown, status = 200) => new Response(JSON.stringify(x), { status, headers: { ...cors, "Content-Type": "application/json" } });
    const rest = /^\/v1\/([a-z_]+)$/.exec(url.pathname);
    if (rest && req.method === "GET") {
      this.stats.restRequests++;
      if (req.headers.get("authorization")?.startsWith("Bearer ")) this.stats.restAuthorized++;
      return json(this.query(rest[1]!, url.search.slice(1)));
    }
    if (url.pathname.startsWith("/control/") && req.method === "POST") {
      const q = url.searchParams;
      switch (url.pathname) {
        case "/control/stream":
          this.startStream(Number(q.get("rate") ?? 20));
          return json({ ok: true });
        case "/control/drop":
          return json({ dropped: this.drop((q.get("which") as "all" | "oldest" | "newest") ?? "all") });
        case "/control/refuse":
          this.refuse(Number(q.get("n") ?? 1));
          return json({ ok: true });
        case "/control/reset":
          this.resetStats();
          return json({ ok: true });
      }
    }
    if (url.pathname === "/control/stats") return json({ ...this.stats, sessions: this.sessions() });
    return new Response("not found", { status: 404, headers: cors });
  }

  /** OpenF1-style filters: `session_key=`, `date>=`, `date>`, `date<=`, `date<` (and any other field `=`). */
  query(topic: string, search: string): Rec[] {
    let rows = this.records.get(topic) ?? [];
    for (const part of search.split("&").filter(Boolean)) {
      let raw: string;
      try {
        raw = decodeURIComponent(part.replaceAll("+", " "));
      } catch {
        continue;
      }
      // (A literal "+" in a value arrives as %2B, decoded above; a bare "+" would be a space.)
      const m = /^([a-z_]+)(>=|<=|>|<|=)(.*)$/.exec(raw);
      if (!m) continue;
      const [, key, op, value] = m as unknown as [string, string, string, string];
      if (key === "session_key" && value === "latest") continue;
      rows = rows.filter((r) => {
        const v = r[key];
        if (key === "date" || key === "date_start") {
          const a = Date.parse(String(v));
          const b = Date.parse(value);
          return op === ">=" ? a >= b : op === ">" ? a > b : op === "<=" ? a <= b : op === "<" ? a < b : a === b;
        }
        return op === "=" ? String(v) === value : true;
      });
    }
    return rows;
  }
}

if (import.meta.main) {
  const arg = (name: string, d: string) => {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 ? process.argv[i + 1]! : d;
  };
  const broker = new FakeBroker({ port: Number(arg("port", "5191")), hostname: "localhost" });
  const rate = Number(arg("rate", "20"));
  broker.startStream(rate);
  console.log(`fake OpenF1 broker on ws://localhost:${broker.port}/mqtt, REST on http://localhost:${broker.port}/v1/ (${rate} msg/s)`);
  console.log(`vault: VAULT_FAKE_BROKER=http://localhost:${broker.port} bun run vault`);
  console.log("controls: POST /control/stream?rate=N, /control/drop, /control/refuse?n=1; GET /control/stats");
}
