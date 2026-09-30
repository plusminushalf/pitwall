import { describe, expect, test } from "bun:test";
import { decodeConnect, decodeTopics, encodeConnack, encodePingresp, encodePublish, encodeSuback, encodeUnsuback } from "../fakebroker";
import { FakeClock, FakeSocket } from "../testkit";
import {
  CONNECT,
  KEEPALIVE_S,
  MAX_REMAINING,
  MqttError,
  MqttSession,
  PacketReader,
  ProtocolError,
  PUBLISH,
  decodePublish,
  encodeConnect,
  encodeDisconnect,
  encodeLength,
  encodePingreq,
  encodePuback,
  encodeSubscribe,
  encodeUnsubscribe,
  frame,
  type CloseInfo,
} from "./mqtt";

const hex = (b: Uint8Array | number[]) => [...b].map((x) => x.toString(16).padStart(2, "0")).join(" ");
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));

describe("remaining length", () => {
  const cases: [number, number[]][] = [
    [0, [0x00]],
    [1, [0x01]],
    [127, [0x7f]],
    [128, [0x80, 0x01]],
    [321, [0xc1, 0x02]],
    [16_383, [0xff, 0x7f]],
    [16_384, [0x80, 0x80, 0x01]],
    [2_097_151, [0xff, 0xff, 0x7f]],
    [2_097_152, [0x80, 0x80, 0x80, 0x01]],
    [268_435_455, [0xff, 0xff, 0xff, 0x7f]],
  ];
  test.each(cases)("%d encodes as the spec's bytes", (n, bytes) => {
    expect(encodeLength(n)).toEqual(bytes);
  });
  test("out of range throws", () => {
    expect(() => encodeLength(MAX_REMAINING + 1)).toThrow(RangeError);
    expect(() => encodeLength(-1)).toThrow(RangeError);
    expect(() => encodeLength(1.5)).toThrow(RangeError);
  });
  test.each(cases.filter(([n]) => n <= 2_097_152))("a %d-byte body is read back whole, fed one byte at a time", (n) => {
    const body = new Uint8Array(n).map((_, i) => i % 251);
    const bytes = frame(PUBLISH, 0, body);
    const r = new PacketReader(4 << 20);
    if (n <= 16_384) {
      const got = [];
      for (let i = 0; i < bytes.length; i++) got.push(...r.push(bytes.subarray(i, i + 1)));
      expect(got.length).toBe(1);
      expect(got[0]!.body).toEqual(body);
    } else {
      // Big ones in 3 chunks, split inside the length bytes and inside the body.
      const got = [...r.push(bytes.subarray(0, 2)), ...r.push(bytes.subarray(2, 1000)), ...r.push(bytes.subarray(1000))];
      expect(got.length).toBe(1);
      expect(got[0]!.body.length).toBe(n);
      expect(got[0]!.body[n - 1]).toBe((n - 1) % 251);
    }
    expect(r.pending).toBe(0);
  });
  test("a fifth length byte is a protocol error", () => {
    expect(() => new PacketReader().push(new Uint8Array([0x30, 0xff, 0xff, 0xff, 0xff, 0x01]))).toThrow(ProtocolError);
  });
  test("a packet over the size cap is a protocol error (not buffered)", () => {
    expect(() => new PacketReader(100).push(new Uint8Array([0x30, 0x65]))).toThrow(ProtocolError);
    expect(new PacketReader(100).push(new Uint8Array([0x30, 0x64]))).toEqual([]);
  });
});

describe("packet reader", () => {
  const a = encodePublish("v1/laps", '{"a":1}');
  const b = encodePingresp();
  const c = encodePublish("v1/position", '{"b":2}');
  const all = new Uint8Array([...a, ...b, ...c]);

  test("several packets in one frame", () => {
    const got = new PacketReader().push(all);
    expect(got.map((p) => p.type)).toEqual([3, 13, 3]);
    expect(decodePublish(got[2]!).topic).toBe("v1/position");
  });
  test("split at every offset: same packets", () => {
    for (let i = 0; i <= all.length; i++) {
      const r = new PacketReader();
      const got = [...r.push(all.subarray(0, i)), ...r.push(all.subarray(i))];
      expect(got.map((p) => hex(p.body))).toEqual([a, b, c].map((x) => hex(new PacketReader().push(x)[0]!.body)));
    }
  });
  test("split into three at every pair of offsets", () => {
    for (let i = 0; i <= all.length; i += 3)
      for (let j = i; j <= all.length; j += 2) {
        const r = new PacketReader();
        const got = [...r.push(all.subarray(0, i)), ...r.push(all.subarray(i, j)), ...r.push(all.subarray(j))];
        expect(got.length).toBe(3);
      }
  });
  test("an empty frame is fine", () => {
    expect(new PacketReader().push(new Uint8Array(0))).toEqual([]);
  });
});

describe("encoders (byte fixtures)", () => {
  test("CONNECT: MQTT 3.1.1, clean session, username + password, keepalive", () => {
    const bytes = encodeConnect({ clientId: "c", username: "u", password: "p", keepaliveS: 30 });
    expect(hex(bytes)).toBe(hex([0x10, 19, 0, 4, ...ascii("MQTT"), 4, 0xc2, 0, 30, 0, 1, ...ascii("c"), 0, 1, ...ascii("u"), 0, 1, ...ascii("p")]));
    const back = decodeConnect(new PacketReader().push(bytes)[0]!);
    expect(back).toEqual({ protocol: "MQTT", level: 4, clean: true, keepaliveS: 30, clientId: "c", username: "u", password: "p" });
  });
  test("CONNECT with a long token uses a 2-byte remaining length", () => {
    const token = "eyJ" + "x".repeat(1200);
    const bytes = encodeConnect({ clientId: "f1-vault-abc", username: "f1-replay-vault", password: token, keepaliveS: 30 });
    expect(bytes[1]! & 0x80).toBe(0x80);
    expect(decodeConnect(new PacketReader().push(bytes)[0]!).password).toBe(token);
  });
  test("SUBSCRIBE: fixed-header flags 0010, packet id, topic + QoS 0 each", () => {
    expect(hex(encodeSubscribe(1, ["v1/laps"]))).toBe(hex([0x82, 12, 0, 1, 0, 7, ...ascii("v1/laps"), 0]));
    const two = encodeSubscribe(0x1234, ["v1/a", "v1/bb"]);
    expect(decodeTopics(new PacketReader().push(two)[0]!, true)).toEqual({ packetId: 0x1234, topics: ["v1/a", "v1/bb"] });
  });
  test("UNSUBSCRIBE, PUBACK, PINGREQ, DISCONNECT", () => {
    expect(hex(encodeUnsubscribe(2, ["v1/x"]))).toBe(hex([0xa2, 8, 0, 2, 0, 4, ...ascii("v1/x")]));
    expect(hex(encodePuback(0x0102))).toBe("40 02 01 02");
    expect(hex(encodePingreq())).toBe("c0 00");
    expect(hex(encodeDisconnect())).toBe("e0 00");
  });
  test("UTF-8 topics are length-prefixed in bytes, not characters", () => {
    const bytes = encodeSubscribe(1, ["v1/ü€"]);
    // "v1/" (3) + ü (2) + € (3) = 8 bytes
    expect([...bytes.subarray(4, 6)]).toEqual([0, 8]);
  });
});

describe("decoders", () => {
  test("PUBLISH QoS 0 with a UTF-8 topic and payload", () => {
    const p = decodePublish(new PacketReader().push(encodePublish("v1/ümlaut/€", '{"x":"é"}'))[0]!);
    expect(p.topic).toBe("v1/ümlaut/€");
    expect(p.qos).toBe(0);
    expect(new TextDecoder().decode(p.payload)).toBe('{"x":"é"}');
  });
  test("PUBLISH QoS 1 carries a packet id", () => {
    const p = decodePublish(new PacketReader().push(encodePublish("v1/laps", "{}", { qos: 1, packetId: 77 }))[0]!);
    expect(p).toMatchObject({ qos: 1, packetId: 77, topic: "v1/laps" });
  });
  test("invalid UTF-8 in a topic is a protocol error", () => {
    const bad = frame(PUBLISH, 0, new Uint8Array([0, 2, 0xc3, 0x28, 0x7b, 0x7d]));
    expect(() => decodePublish(new PacketReader().push(bad)[0]!)).toThrow(ProtocolError);
  });
  test("a truncated topic is a protocol error", () => {
    expect(() => decodePublish(new PacketReader().push(frame(PUBLISH, 0, new Uint8Array([0, 9, 0x61])))[0]!)).toThrow(ProtocolError);
  });
  test("QoS 3 is a protocol error", () => {
    expect(() => decodePublish(new PacketReader().push(frame(PUBLISH, 6, new Uint8Array([0, 1, 0x61, 0, 1])))[0]!)).toThrow(ProtocolError);
  });
});

// ---------------------------------------------------------------- the session

function setup(opts: { keepaliveS?: number } = {}) {
  const clock = new FakeClock();
  const sockets: FakeSocket[] = [];
  const messages: [string, string][] = [];
  const closes: CloseInfo[] = [];
  const s = new MqttSession({
    url: "wss://broker/mqtt",
    clientId: "client-1",
    username: "user",
    password: "token",
    socket: (url, protocols) => {
      const sock = new FakeSocket(url, protocols);
      sockets.push(sock);
      return sock;
    },
    timers: clock,
    onMessage: (t, p) => messages.push([t, new TextDecoder().decode(p)]),
    onClose: (i) => closes.push(i),
    ...(opts.keepaliveS !== undefined && { keepaliveS: opts.keepaliveS }),
  });
  const sock = () => sockets[0]!;
  const sentTypes = () => sock().sent.map((b) => b[0]! >> 4);
  return { clock, s, sock, messages, closes, sentTypes };
}

async function connected(opts: { keepaliveS?: number } = {}) {
  const x = setup(opts);
  const p = x.s.connect();
  x.sock().open();
  x.sock().receive(encodeConnack(0));
  await p;
  return x;
}

describe("MqttSession", () => {
  test("opens with subprotocol mqtt and binary frames, sends CONNECT on open, resolves on CONNACK 0", async () => {
    const x = setup();
    const p = x.s.connect();
    expect(x.sock().protocols).toEqual(["mqtt"]);
    expect(x.sock().binaryType).toBe("arraybuffer");
    expect(x.sock().sent.length).toBe(0);
    x.sock().open();
    expect(x.sentTypes()).toEqual([CONNECT]);
    const c = decodeConnect(new PacketReader().push(x.sock().sent[0]!)[0]!);
    expect(c).toMatchObject({ clientId: "client-1", username: "user", password: "token", clean: true, keepaliveS: KEEPALIVE_S });
    expect(KEEPALIVE_S).toBe(90);
    x.sock().receive(encodeConnack(0));
    await p;
    expect(x.s.open).toBe(true);
  });

  test("CONNACK 5 rejects with the code and closes the socket; onClose isn't called", async () => {
    const x = setup();
    const p = x.s.connect();
    x.sock().open();
    x.sock().receive(encodeConnack(5));
    const e = await p.catch((e) => e);
    expect(e).toBeInstanceOf(MqttError);
    expect((e as MqttError).info).toEqual({ reason: "refused", code: 5 });
    expect((e as MqttError).message).toBe("refused: CONNACK 5 (not authorized)");
    expect(x.sock().closed).not.toBeNull();
    expect(x.closes).toEqual([]);
  });

  test("the socket closing before CONNACK rejects (closed, with the code)", async () => {
    const x = setup();
    const p = x.s.connect();
    x.sock().drop(1006);
    expect(((await p.catch((e) => e)) as MqttError).info).toEqual({ reason: "closed", code: 1006 });
  });

  test("no CONNACK within the connect timeout", async () => {
    const x = setup();
    const p = x.s.connect().catch((e) => e);
    x.sock().open();
    await x.clock.advance(15_000);
    expect(((await p) as MqttError).info).toEqual({ reason: "timeout", what: "connect" });
  });

  test("a packet other than CONNACK first is a protocol error", async () => {
    const x = setup();
    const p = x.s.connect().catch((e) => e);
    x.sock().open();
    x.sock().receive(encodePingresp());
    expect(((await p) as MqttError).info.reason).toBe("protocol");
  });

  test("CONNACK split across two frames, with a PUBLISH in the second", async () => {
    const x = setup();
    const p = x.s.connect();
    x.sock().open();
    const both = new Uint8Array([...encodeConnack(0), ...encodePublish("v1/laps", '{"n":1}')]);
    x.sock().receive(both.subarray(0, 3));
    x.sock().receive(both.subarray(3));
    await p;
    expect(x.messages).toEqual([["v1/laps", '{"n":1}']]);
  });

  test("subscribe resolves with SUBACK's granted codes; unsubscribe with UNSUBACK", async () => {
    const x = await connected();
    const sub = x.s.subscribe(["v1/laps", "v1/position"]);
    const sent = new PacketReader().push(x.sock().sent.at(-1)!)[0]!;
    const { packetId, topics } = decodeTopics(sent, true);
    expect(topics).toEqual(["v1/laps", "v1/position"]);
    x.sock().receive(encodeSuback(packetId, [0, 0x80]));
    expect(await sub).toEqual([0, 0x80]);
    const unsub = x.s.unsubscribe(["v1/laps"]);
    const u = decodeTopics(new PacketReader().push(x.sock().sent.at(-1)!)[0]!, false);
    x.sock().receive(encodeUnsuback(u.packetId));
    expect(await unsub).toEqual([]);
  });

  test("a SUBACK that never comes closes the session (timeout)", async () => {
    const x = await connected();
    const sub = x.s.subscribe(["v1/laps"]).catch((e) => e);
    await x.clock.advance(15_000);
    expect(((await sub) as MqttError).info).toEqual({ reason: "timeout", what: "subscribe" });
    expect(x.closes).toEqual([{ reason: "timeout", what: "subscribe" }]);
  });

  test("QoS 1 PUBLISH is PUBACKed with its packet id and delivered", async () => {
    const x = await connected();
    x.sock().receive(encodePublish("v1/laps", "{}", { qos: 1, packetId: 513 }));
    expect(hex(x.sock().sent.at(-1)!)).toBe("40 02 02 01");
    expect(x.messages.length).toBe(1);
  });

  test("many packets in one frame are delivered in order", async () => {
    const x = await connected();
    const frames = [1, 2, 3, 4, 5].map((n) => encodePublish("v1/car_data", `{"n":${n}}`));
    x.sock().receive(new Uint8Array(frames.flatMap((f) => [...f])));
    expect(x.messages.map((m) => m[1])).toEqual([1, 2, 3, 4, 5].map((n) => `{"n":${n}}`));
  });

  test("keepalive: PINGREQ after keepalive/2 (45 s) of silence; PINGRESP keeps it open", async () => {
    const x = await connected();
    await x.clock.advance(44_999);
    expect(x.sentTypes().filter((t) => t === 12).length).toBe(0);
    await x.clock.advance(1);
    expect(x.sentTypes().filter((t) => t === 12).length).toBe(1);
    await x.clock.advance(5_000);
    x.sock().receive(encodePingresp());
    await x.clock.advance(180_000);
    expect(x.s.open).toBe(false); // no answer to the later pings
    expect(x.closes).toEqual([{ reason: "timeout", what: "ping" }]);
  });

  test("keepalive: a dead connection (no PINGRESP within the ping timeout) is closed and reported", async () => {
    const x = await connected();
    await x.clock.advance(45_000);
    await x.clock.advance(9_999);
    expect(x.closes).toEqual([]);
    await x.clock.advance(1);
    expect(x.closes).toEqual([{ reason: "timeout", what: "ping" }]);
    expect(x.sock().closed).not.toBeNull();
  });

  test("keepalive: inbound data after keepalive/2 sends a PINGREQ even if timers are throttled", async () => {
    const x = await connected();
    x.clock.t += 50_000; // the timer didn't fire (throttled background tab)
    x.sock().receive(encodePublish("v1/laps", "{}"));
    expect(x.sentTypes().at(-1)).toBe(12);
  });

  test("the broker closing the socket after connect: onClose once, with the code", async () => {
    const x = await connected();
    x.sock().drop(1006);
    x.sock().drop(1006);
    expect(x.closes).toEqual([{ reason: "closed", code: 1006 }]);
  });

  test("an error event ends it (reason error)", async () => {
    const x = await connected();
    x.sock().onerror?.({});
    expect(x.closes).toEqual([{ reason: "error" }]);
  });

  test("close(): DISCONNECT, socket closed, no onClose; pending acks reject", async () => {
    const x = await connected();
    const sub = x.s.subscribe(["v1/laps"]).catch((e) => e);
    x.s.close();
    expect(x.sentTypes().at(-1)).toBe(14);
    expect(x.sock().closed).not.toBeNull();
    expect(x.closes).toEqual([]);
    expect(((await sub) as MqttError).info.reason).toBe("local");
    expect(x.clock.pending).toBe(0);
  });

  test("a text frame or malformed bytes are protocol errors", async () => {
    const x = await connected();
    x.sock().onmessage?.({ data: "hello" });
    expect(x.closes[0]?.reason).toBe("protocol");
    const y = await connected();
    y.sock().receive(new Uint8Array([0x30, 0xff, 0xff, 0xff, 0xff, 0x01]));
    expect(y.closes[0]?.reason).toBe("protocol");
  });

  test("an unexpected packet type from the broker is a protocol error", async () => {
    const x = await connected();
    x.sock().receive(frame(1, 0, new Uint8Array(0)));
    expect(x.closes[0]).toEqual({ reason: "protocol", detail: "unexpected packet type 1" });
  });
});
