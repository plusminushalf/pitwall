// The broker's side of the MQTT 3.1.1 codec (mqtt.ts is the client's): decode CONNECT / SUBSCRIBE /
// UNSUBSCRIBE, encode CONNACK / SUBACK / UNSUBACK / PINGRESP / PUBLISH. Used by the dev/test brokers only:
// fakebroker.ts (a local server), testkit.ts (in memory) and sim.ts (the dev vault's simulate mode). Nothing
// in a production vault imports it, so the build drops it.

import { CONNACK, PINGRESP, PUBLISH, ProtocolError, SUBACK, UNSUBACK, frame, mqttString, readString, type RawPacket } from "./mqtt";

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
