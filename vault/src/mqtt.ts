// A hand-written MQTT 3.1.1-over-WebSocket client: the subset the vault needs to follow OpenF1's live feed
// (wss://mqtt.openf1.org:8084/mqtt), and nothing else. No dependencies. Pure apart from the injected socket
// factory and timers, so bun tests drive it with byte fixtures and a fake clock.
//
// What it does: CONNECT (clean session, username + password, keepalive), CONNACK, SUBSCRIBE / SUBACK,
// UNSUBSCRIBE / UNSUBACK, PUBLISH receive (QoS 0; a QoS 1 PUBLISH is PUBACKed; QoS 2 is refused because we
// only ever subscribe at QoS 0), PINGREQ / PINGRESP with a dead-connection timeout, DISCONNECT.
// WebSocket framing: subprotocol "mqtt", binary frames; one frame may hold part of a packet or several.
//
// OpenF1 facts (docs/modular-hypotheses.md): the password is the access token and the username the account's
// email (measured 2026-09-30: another username is refused with CONNACK 5 even with a valid token); CONNACK 5 means an expired token OR the 10-connection cap (live.ts tells them apart); reusing a
// clientId kicks the older session, so every session gets a fresh one (live.ts).

import type { Timers } from "./scheduler";

// ---------------------------------------------------------------- packets

export const CONNECT = 1;
export const CONNACK = 2;
export const PUBLISH = 3;
export const PUBACK = 4;
export const SUBSCRIBE = 8;
export const SUBACK = 9;
export const UNSUBSCRIBE = 10;
export const UNSUBACK = 11;
export const PINGREQ = 12;
export const PINGRESP = 13;
export const DISCONNECT = 14;

/** The largest remaining length MQTT can express (4 length bytes). */
export const MAX_REMAINING = 268_435_455;
/** Anything bigger from the broker is a protocol error, not a buffer we grow forever. OpenF1 messages are < 10 kB. */
export const MAX_PACKET = 1 << 20;

/** One packet as framed on the wire: the fixed header's type and flags, and the rest. */
export type RawPacket = { type: number; flags: number; body: Uint8Array };

export class ProtocolError extends Error {}

const utf8 = new TextEncoder();
const strictUtf8 = new TextDecoder("utf-8", { fatal: true });

/** The remaining-length varint: 7 bits per byte, low group first, high bit = more. 1 to 4 bytes. */
export function encodeLength(n: number): number[] {
  if (!Number.isInteger(n) || n < 0 || n > MAX_REMAINING) throw new RangeError(`remaining length ${n}`);
  const out: number[] = [];
  do {
    let b = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) b |= 0x80;
    out.push(b);
  } while (n > 0);
  return out;
}

/** A whole packet: fixed header byte, remaining length, body. */
export function frame(type: number, flags: number, body: Uint8Array = new Uint8Array(0)): Uint8Array {
  const len = encodeLength(body.length);
  const out = new Uint8Array(1 + len.length + body.length);
  out[0] = (type << 4) | (flags & 0x0f);
  out.set(len, 1);
  out.set(body, 1 + len.length);
  return out;
}

/** A length-prefixed UTF-8 string (or binary data) as MQTT writes it. */
export function mqttString(s: string | Uint8Array): Uint8Array {
  const b = typeof s === "string" ? utf8.encode(s) : s;
  if (b.length > 0xffff) throw new RangeError("string too long");
  const out = new Uint8Array(2 + b.length);
  out[0] = b.length >> 8;
  out[1] = b.length & 0xff;
  out.set(b, 2);
  return out;
}

const concat = (parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};
const u16 = (n: number) => new Uint8Array([n >> 8, n & 0xff]);

export type ConnectOptions = { clientId: string; username: string; password: string; keepaliveS: number };

/** CONNECT, MQTT 3.1.1 (level 4), clean session, username and password. */
export function encodeConnect(o: ConnectOptions): Uint8Array {
  const flags = 0x80 | 0x40 | 0x02; // username, password, clean session
  const header = concat([mqttString("MQTT"), new Uint8Array([4, flags]), u16(o.keepaliveS)]);
  return frame(CONNECT, 0, concat([header, mqttString(o.clientId), mqttString(o.username), mqttString(o.password)]));
}

/** SUBSCRIBE (fixed-header flags 0b0010, as the spec requires), every topic at QoS 0. */
export function encodeSubscribe(packetId: number, topics: string[]): Uint8Array {
  return frame(SUBSCRIBE, 2, concat([u16(packetId), ...topics.flatMap((t) => [mqttString(t), new Uint8Array([0])])]));
}

export function encodeUnsubscribe(packetId: number, topics: string[]): Uint8Array {
  return frame(UNSUBSCRIBE, 2, concat([u16(packetId), ...topics.map((t) => mqttString(t))]));
}

export const encodePuback = (packetId: number) => frame(PUBACK, 0, u16(packetId));
export const encodePingreq = () => frame(PINGREQ, 0);
export const encodeDisconnect = () => frame(DISCONNECT, 0);

/**
 * Turns a stream of WebSocket frames into packets: a frame may end mid-packet (even mid-length) or hold
 * several. Throws ProtocolError on a remaining length over 4 bytes or a packet over `maxPacket`.
 */
export class PacketReader {
  private buf: Uint8Array = new Uint8Array(0);

  constructor(private maxPacket = MAX_PACKET) {}

  push(chunk: Uint8Array): RawPacket[] {
    this.buf = this.buf.length ? concat([this.buf, chunk]) : chunk;
    const out: RawPacket[] = [];
    let at = 0;
    for (;;) {
      if (this.buf.length - at < 2) break;
      let len = 0;
      let mul = 1;
      let i = at + 1;
      let complete = false;
      for (let n = 0; n < 4; n++, i++) {
        if (i >= this.buf.length) break;
        const b = this.buf[i]!;
        len += (b & 0x7f) * mul;
        mul *= 128;
        if (!(b & 0x80)) {
          complete = true;
          i++;
          break;
        }
        if (n === 3) throw new ProtocolError("remaining length over 4 bytes");
      }
      if (!complete) break; // the length itself is split across frames
      if (len > this.maxPacket) throw new ProtocolError(`packet of ${len} bytes`);
      if (this.buf.length - i < len) break;
      const h = this.buf[at]!;
      out.push({ type: h >> 4, flags: h & 0x0f, body: this.buf.slice(i, i + len) });
      at = i + len;
    }
    this.buf = at === 0 ? this.buf : this.buf.slice(at);
    return out;
  }

  /** Bytes waiting for the rest of a packet. */
  get pending() {
    return this.buf.length;
  }
}

export type Publish = { topic: string; payload: Uint8Array; qos: 0 | 1 | 2; dup: boolean; retain: boolean; packetId?: number };

const readU16 = (b: Uint8Array, at: number) => {
  if (at + 2 > b.length) throw new ProtocolError("truncated");
  return (b[at]! << 8) | b[at + 1]!;
};

/** A length-prefixed UTF-8 string at `at`: [value, next offset]. Invalid UTF-8 is a protocol error. */
export function readString(b: Uint8Array, at: number): [string, number] {
  const n = readU16(b, at);
  if (at + 2 + n > b.length) throw new ProtocolError("truncated string");
  try {
    return [strictUtf8.decode(b.subarray(at + 2, at + 2 + n)), at + 2 + n];
  } catch {
    throw new ProtocolError("invalid UTF-8");
  }
}

export function decodePublish(p: RawPacket): Publish {
  const qos = (p.flags >> 1) & 3;
  if (qos === 3) throw new ProtocolError("PUBLISH with QoS 3");
  const [topic, next] = readString(p.body, 0);
  if (!topic.length) throw new ProtocolError("PUBLISH without a topic");
  let at = next;
  let packetId: number | undefined;
  if (qos > 0) {
    packetId = readU16(p.body, at);
    at += 2;
  }
  return { topic, payload: p.body.subarray(at), qos: qos as 0 | 1 | 2, dup: !!(p.flags & 8), retain: !!(p.flags & 1), ...(packetId !== undefined && { packetId }) };
}

export function decodeConnack(p: RawPacket): { sessionPresent: boolean; code: number } {
  if (p.body.length !== 2) throw new ProtocolError("CONNACK length");
  return { sessionPresent: !!(p.body[0]! & 1), code: p.body[1]! };
}

export function decodeSuback(p: RawPacket): { packetId: number; granted: number[] } {
  if (p.body.length < 3) throw new ProtocolError("SUBACK length");
  return { packetId: readU16(p.body, 0), granted: [...p.body.subarray(2)] };
}

/** CONNACK return codes (3.1.1). 4 and 5 are both "your credentials": OpenF1 sends 5. */
export const CONNACK_CODES: Record<number, string> = {
  1: "unacceptable protocol version",
  2: "identifier rejected",
  3: "server unavailable",
  4: "bad user name or password",
  5: "not authorized",
};

// ---------------------------------------------------------------- the session

/** The part of a browser WebSocket the session uses (Bun's WebSocket fits too). */
export type SocketLike = {
  binaryType: string;
  send(data: Uint8Array): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
};
export type SocketFactory = (url: string, protocols: string[]) => SocketLike;

/** Why a session ended. */
export type CloseInfo =
  | { reason: "refused"; code: number } // CONNACK != 0
  | { reason: "closed"; code: number } // the socket closed under us (broker, network)
  | { reason: "timeout"; what: "connect" | "ping" | "subscribe" }
  | { reason: "protocol"; detail: string }
  | { reason: "error" } // the socket reported an error (failed handshake, CSP, DNS)
  | { reason: "local" }; // close() was called

export class MqttError extends Error {
  constructor(readonly info: CloseInfo) {
    super(describeClose(info));
  }
}

export function describeClose(i: CloseInfo): string {
  switch (i.reason) {
    case "refused":
      return `refused: CONNACK ${i.code} (${CONNACK_CODES[i.code] ?? "unknown"})`;
    case "closed":
      return `connection closed (${i.code})`;
    case "timeout":
      return `${i.what} timed out`;
    case "protocol":
      return `protocol error: ${i.detail}`;
    case "error":
      return "connection error";
    case "local":
      return "closed";
  }
}

export type SessionOptions = {
  url: string;
  clientId: string;
  username: string;
  password: string;
  socket: SocketFactory;
  timers: Timers;
  /** Every PUBLISH, in arrival order. */
  onMessage(topic: string, payload: Uint8Array): void;
  /** The session ended after connect() had resolved (never for close() itself). Called once. */
  onClose(info: CloseInfo): void;
  keepaliveS?: number;
  connectTimeoutMs?: number;
  /** No packet at all this long after a PINGREQ: the connection is dead. */
  pingTimeoutMs?: number;
  /** A SUBSCRIBE / UNSUBSCRIBE without its ack after this long closes the session. */
  ackTimeoutMs?: number;
};

export const KEEPALIVE_S = 30;
export const CONNECT_TIMEOUT_MS = 15_000;
export const PING_TIMEOUT_MS = 10_000;
export const ACK_TIMEOUT_MS = 15_000;

/**
 * One MQTT connection. connect() resolves on CONNACK 0 and rejects with MqttError otherwise; after that,
 * an unexpected end is reported once through onClose.
 *
 * Keepalive: a PINGREQ when nothing has been sent for keepalive/2, checked by a timer and also on every
 * inbound packet. Background tabs throttle timers (Chrome aligns them to one minute after 5 minutes hidden),
 * which would let the broker drop us at 1.5 x keepalive; while data flows, the inbound check keeps pings going
 * regardless.
 */
export class MqttSession {
  private ws: SocketLike | null = null;
  private reader = new PacketReader();
  private state: "idle" | "connecting" | "open" | "closed" = "idle";
  private connectWaiter: { resolve: () => void; reject: (e: MqttError) => void } | null = null;
  private acks = new Map<number, { resolve: (granted: number[]) => void; reject: (e: MqttError) => void }>();
  private nextId = 1;
  private lastSent = 0;
  private pingDeadline: number | null = null;
  private timer: unknown = null;
  private connectTimer: unknown = null;
  private ackTimers = new Map<number, unknown>();
  private keepaliveMs: number;

  constructor(private o: SessionOptions) {
    this.keepaliveMs = (o.keepaliveS ?? KEEPALIVE_S) * 1000;
  }

  get open() {
    return this.state === "open";
  }

  get closed() {
    return this.state === "closed";
  }

  connect(): Promise<void> {
    if (this.state !== "idle") return Promise.reject(new MqttError({ reason: "protocol", detail: "connect called twice" }));
    this.state = "connecting";
    return new Promise<void>((resolve, reject) => {
      this.connectWaiter = { resolve, reject };
      this.connectTimer = this.o.timers.setTimeout(() => this.end({ reason: "timeout", what: "connect" }), this.o.connectTimeoutMs ?? CONNECT_TIMEOUT_MS);
      let ws: SocketLike;
      try {
        ws = this.o.socket(this.o.url, ["mqtt"]);
      } catch {
        return this.end({ reason: "error" });
      }
      this.ws = ws;
      ws.binaryType = "arraybuffer";
      ws.onopen = () => {
        if (this.state !== "connecting") return;
        this.send(encodeConnect({ clientId: this.o.clientId, username: this.o.username, password: this.o.password, keepaliveS: this.keepaliveMs / 1000 }));
      };
      ws.onmessage = (e) => this.onData(e.data);
      ws.onclose = (e) => this.end({ reason: "closed", code: e.code });
      ws.onerror = () => this.end({ reason: "error" });
    });
  }

  /** SUBSCRIBE at QoS 0; resolves with the granted codes (0x80 = refused), one per topic. */
  subscribe(topics: string[]): Promise<number[]> {
    return this.request(topics, encodeSubscribe);
  }

  unsubscribe(topics: string[]): Promise<number[]> {
    return this.request(topics, encodeUnsubscribe);
  }

  /** DISCONNECT and close. Silent: onClose isn't called. */
  close() {
    if (this.state === "closed") return;
    if (this.state === "open") this.send(encodeDisconnect());
    this.end({ reason: "local" });
  }

  // ---------------------------------------------------------------- internals

  private request(topics: string[], encode: (id: number, topics: string[]) => Uint8Array): Promise<number[]> {
    if (this.state !== "open") return Promise.reject(new MqttError({ reason: "protocol", detail: "not connected" }));
    if (!topics.length) return Promise.resolve([]);
    const id = this.nextId;
    this.nextId = (this.nextId % 0xffff) + 1;
    return new Promise<number[]>((resolve, reject) => {
      this.acks.set(id, { resolve, reject });
      this.ackTimers.set(
        id,
        this.o.timers.setTimeout(() => this.end({ reason: "timeout", what: "subscribe" }), this.o.ackTimeoutMs ?? ACK_TIMEOUT_MS),
      );
      this.send(encode(id, topics));
    });
  }

  private settleAck(id: number, granted: number[]) {
    const a = this.acks.get(id);
    if (!a) return;
    this.acks.delete(id);
    this.o.timers.clearTimeout(this.ackTimers.get(id));
    this.ackTimers.delete(id);
    a.resolve(granted);
  }

  private send(bytes: Uint8Array) {
    try {
      this.ws?.send(bytes);
      this.lastSent = this.o.timers.now();
    } catch {
      this.end({ reason: "error" });
    }
  }

  private onData(data: unknown) {
    if (this.state === "closed") return;
    if (!(data instanceof ArrayBuffer) && !ArrayBuffer.isView(data)) return this.end({ reason: "protocol", detail: "text frame" });
    const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    let packets: RawPacket[];
    try {
      packets = this.reader.push(bytes);
    } catch (e) {
      return this.end({ reason: "protocol", detail: e instanceof Error ? e.message : "bad frame" });
    }
    for (const p of packets) {
      if (this.closed) return; // a packet before this one ended the session
      try {
        this.onPacket(p);
      } catch (e) {
        return this.end({ reason: "protocol", detail: e instanceof ProtocolError ? e.message : "bad packet" });
      }
    }
    if (packets.length && this.state === "open") {
      this.pingDeadline = null;
      // Opportunistic keepalive (see the class comment).
      if (this.o.timers.now() - this.lastSent >= this.keepaliveMs / 2) this.ping();
    }
  }

  private onPacket(p: RawPacket) {
    if (this.state === "connecting") {
      if (p.type !== CONNACK) throw new ProtocolError(`packet ${p.type} before CONNACK`);
      const { code } = decodeConnack(p);
      if (code !== 0) return this.end({ reason: "refused", code });
      this.state = "open";
      this.o.timers.clearTimeout(this.connectTimer);
      this.connectTimer = null;
      this.arm();
      const w = this.connectWaiter;
      this.connectWaiter = null;
      w?.resolve();
      return;
    }
    switch (p.type) {
      case PUBLISH: {
        const m = decodePublish(p);
        if (m.qos === 2) throw new ProtocolError("PUBLISH with QoS 2 (we subscribe at QoS 0)");
        if (m.qos === 1) this.send(encodePuback(m.packetId!));
        this.o.onMessage(m.topic, m.payload);
        return;
      }
      case SUBACK: {
        const { packetId, granted } = decodeSuback(p);
        return this.settleAck(packetId, granted);
      }
      case UNSUBACK:
        if (p.body.length !== 2) throw new ProtocolError("UNSUBACK length");
        return this.settleAck(readU16(p.body, 0), []);
      case PINGRESP:
        return;
      default:
        throw new ProtocolError(`unexpected packet type ${p.type}`);
    }
  }

  private ping() {
    this.send(encodePingreq());
    if (this.pingDeadline === null) this.pingDeadline = this.o.timers.now() + (this.o.pingTimeoutMs ?? PING_TIMEOUT_MS);
    this.arm();
  }

  /** One timer: the next ping due, or the ping deadline, whichever is first. */
  private arm() {
    if (this.timer !== null) this.o.timers.clearTimeout(this.timer);
    this.timer = null;
    if (this.state !== "open" || this.keepaliveMs <= 0) return;
    const now = this.o.timers.now();
    const pingAt = this.lastSent + this.keepaliveMs / 2;
    const at = this.pingDeadline !== null ? Math.min(this.pingDeadline, pingAt) : pingAt;
    this.timer = this.o.timers.setTimeout(() => this.tick(), Math.max(0, at - now));
  }

  private tick() {
    this.timer = null;
    if (this.state !== "open") return;
    const now = this.o.timers.now();
    if (this.pingDeadline !== null && now >= this.pingDeadline) return this.end({ reason: "timeout", what: "ping" });
    if (now - this.lastSent >= this.keepaliveMs / 2) return this.ping();
    this.arm();
  }

  private end(info: CloseInfo) {
    if (this.state === "closed") return;
    const wasOpen = this.state === "open";
    this.state = "closed";
    for (const t of [this.timer, this.connectTimer, ...this.ackTimers.values()]) if (t !== null) this.o.timers.clearTimeout(t);
    this.timer = this.connectTimer = null;
    this.ackTimers.clear();
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
      try {
        ws.close(1000);
      } catch {}
    }
    const err = new MqttError(info);
    for (const a of this.acks.values()) a.reject(err);
    this.acks.clear();
    const w = this.connectWaiter;
    this.connectWaiter = null;
    if (w) return w.reject(err);
    if (wasOpen && info.reason !== "local") this.o.onClose(info);
  }
}
