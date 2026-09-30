// Test helpers for the vault's bun tests (not shipped): a fake clock and an in-memory MQTT broker that
// speaks real MQTT bytes to the client through fake sockets.

import { CONNECT, DISCONNECT, PINGREQ, PUBACK, PacketReader, SUBSCRIBE, UNSUBSCRIBE, type SocketLike } from "./src/mqtt";
import { decodeConnect, decodeTopics, encodeConnack, encodePingresp, encodePublish, encodeSuback, encodeUnsuback } from "./fakebroker";

/** Let pending promise callbacks (several levels deep) run. */
export async function settle(rounds = 3) {
  for (let r = 0; r < rounds; r++) {
    for (let i = 0; i < 20; i++) await Promise.resolve();
    await new Promise((res) => setImmediate(res));
  }
}

export class FakeClock {
  t = 1_700_000_000_000;
  private timers: { at: number; fn: () => void; seq: number }[] = [];
  private seq = 0;
  now = () => this.t;
  setTimeout = (fn: () => void, ms: number) => {
    const h = { at: this.t + Math.max(0, ms), fn, seq: this.seq++ };
    this.timers.push(h);
    return h;
  };
  clearTimeout = (h: unknown) => {
    this.timers = this.timers.filter((x) => x !== h);
  };
  /** Advance the clock, firing due timers in order (and letting their async work run between them). */
  async advance(ms: number) {
    const to = this.t + ms;
    for (;;) {
      await settle(1);
      this.timers.sort((a, b) => a.at - b.at || a.seq - b.seq);
      const next = this.timers[0];
      if (!next || next.at > to) break;
      this.timers.shift();
      this.t = Math.max(this.t, next.at);
      next.fn();
    }
    this.t = to;
    await settle();
  }
  get pending() {
    return this.timers.length;
  }
}

/** A socket that records what the client sends and lets a test play the server. */
export class FakeSocket implements SocketLike {
  binaryType = "blob";
  sent: Uint8Array[] = [];
  closed: { code?: number } | null = null;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onSend: ((b: Uint8Array) => void) | null = null;
  constructor(
    readonly url: string,
    readonly protocols: string[],
  ) {}
  send(data: Uint8Array) {
    if (this.closed) throw new Error("closed");
    this.sent.push(new Uint8Array(data));
    this.onSend?.(new Uint8Array(data));
  }
  close(code?: number) {
    this.closed ??= { ...(code !== undefined && { code }) };
  }
  // server side
  open() {
    this.onopen?.({});
  }
  receive(bytes: Uint8Array | number[]) {
    const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    this.onmessage?.({ data: u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) });
  }
  /** The server (or network) closed it. */
  drop(code = 1006) {
    this.closed ??= { code };
    this.onclose?.({ code, reason: "" });
  }
}

type MemClient = { sock: FakeSocket; reader: PacketReader; clientId: string | null; username: string | null; password: string | null; subs: Set<string>; open: boolean };

/**
 * An in-memory broker: every socket the client opens talks to it with real MQTT bytes. Delivery is on a
 * microtask, so a message can be in flight on one socket while another gets its SUBACK.
 */
export class MemBroker {
  clients: MemClient[] = [];
  refuseNext = 0;
  /** Refuse CONNECTs whose password is in here (e.g. "expired" tokens). */
  refusePasswords = new Set<string>();
  /** Don't answer CONNECT at all (a hung broker). */
  silent = false;
  max = 0;
  connects = 0;
  refused = 0;
  records = new Map<string, Record<string, unknown>[]>();
  private nextId = 1;

  socket = (url: string, protocols: string[]): SocketLike => {
    const sock = new FakeSocket(url, protocols);
    const c: MemClient = { sock, reader: new PacketReader(), clientId: null, username: null, password: null, subs: new Set(), open: false };
    this.clients.push(c);
    sock.onSend = (b) => queueMicrotask(() => this.onBytes(c, b));
    queueMicrotask(() => sock.open());
    return sock;
  };

  get current() {
    return this.clients.filter((c) => c.open && !c.sock.closed).length;
  }

  private onBytes(c: MemClient, b: Uint8Array) {
    if (c.sock.closed) return;
    for (const p of c.reader.push(b)) {
      switch (p.type) {
        case CONNECT: {
          const m = decodeConnect(p);
          if (this.silent) return;
          if (this.refuseNext > 0 || (m.password && this.refusePasswords.has(m.password))) {
            if (this.refuseNext > 0) this.refuseNext--;
            this.refused++;
            this.reply(c, encodeConnack(5));
            queueMicrotask(() => c.sock.drop(1000));
            return;
          }
          for (const o of this.clients) if (o !== c && o.open && !o.sock.closed && o.clientId === m.clientId) queueMicrotask(() => o.sock.drop(1000));
          c.clientId = m.clientId;
          c.password = m.password ?? null;
          c.username = m.username ?? null;
          c.open = true;
          this.connects++;
          this.max = Math.max(this.max, this.current);
          this.reply(c, encodeConnack(0));
          break;
        }
        case SUBSCRIBE: {
          const { packetId, topics } = decodeTopics(p, true);
          for (const t of topics) c.subs.add(t);
          this.reply(c, encodeSuback(packetId, topics.map(() => 0)));
          break;
        }
        case UNSUBSCRIBE: {
          const { packetId, topics } = decodeTopics(p, false);
          for (const t of topics) c.subs.delete(t);
          this.reply(c, encodeUnsuback(packetId));
          break;
        }
        case PINGREQ:
          this.reply(c, encodePingresp());
          break;
        case DISCONNECT:
          c.open = false;
          break;
        case PUBACK:
          break;
      }
    }
  }

  private reply(c: MemClient, bytes: Uint8Array) {
    queueMicrotask(() => {
      if (!c.sock.closed) c.sock.receive(bytes);
    });
  }

  /** Publish on v1/<topic> to every subscribed session; REST keeps it without `_id`. */
  publish(topic: string, msg: Record<string, unknown>) {
    const withId = { ...msg, _id: this.nextId++ };
    const bytes = encodePublish(`v1/${topic}`, JSON.stringify(withId));
    for (const c of this.clients) if (c.open && !c.sock.closed && c.subs.has(`v1/${topic}`)) this.reply(c, bytes);
    const { _id, _key, ...rest } = withId as Record<string, unknown>;
    let list = this.records.get(topic);
    if (!list) this.records.set(topic, (list = []));
    list.push(rest);
    return withId;
  }

  /** Drop every open session (network blip). */
  dropAll() {
    for (const c of this.clients) if (c.open && !c.sock.closed) {
      c.open = false;
      c.sock.drop(1006);
    }
  }

  /** REST: rows of a topic with date >= the `date>=` param. */
  rest = async (endpoint: string, params: Record<string, string | number>) => {
    let rows = this.records.get(endpoint) ?? [];
    const from = params["date>="];
    if (typeof from === "string") rows = rows.filter((r) => Date.parse(String(r.date)) >= Date.parse(from));
    return { status: 200, body: new TextEncoder().encode(JSON.stringify(rows)).buffer as ArrayBuffer };
  };
}
