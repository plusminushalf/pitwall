// The relay's live data from OpenF1 (sponsor tier). Finding the session, the REST backfill and when it's over are
// src/live/openf1.ts, shared with the browser; this adds the credentials from .env, the MQTT connection (secure
// WebSocket) and writing what was received to the raw cache at the end.

import mqtt, { type MqttClient } from "mqtt";
import { AuthError, accessToken, credentials, fetchCircuit, fetchEndpoint, invalidateToken, tokenExpiresAt } from "../scripts/openf1";
import { OpenF1Live, type FeedHooks, type LiveFeed } from "../src/live/openf1";
import type { Hub } from "./hub";
import { TOPICS, writeRawCache, type LiveStore, type Rec, type Topic } from "./store";

export { inLiveWindow, isRaceSession } from "../src/live/openf1";

const MQTT_URL = "wss://mqtt.openf1.org:8084/mqtt";
const ROTATE_BEFORE_EXPIRY_MS = 3 * 60_000; // new MQTT connection with a fresh token
const GAP_BACKFILL_AFTER_MS = 5_000; // after a reconnect, re-fetch over REST what may have been missed

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export class OpenF1Source {
  private live: OpenF1Live | null = null;

  constructor(private hub: Hub) {}

  start(): void {
    if (!credentials()) {
      this.hub.setStatus({
        state: "error",
        sessionKey: null,
        detail: "OPENF1_USERNAME / OPENF1_PASSWORD are not set: live timing needs an OpenF1 sponsor account (see README, Live mode)",
      });
      return;
    }
    this.live = new OpenF1Live(this.hub, {
      rest: fetchEndpoint,
      circuit: fetchCircuit,
      feed: (store, hooks) => new MqttFeed(store, hooks),
      keepRaw: true,
      save: (store) => saveRaw(store),
    });
    this.live.start();
  }

  /** Ctrl-C during a session: keep what was received. */
  async shutdown(): Promise<void> {
    await this.live?.shutdown();
  }
}

async function saveRaw(store: LiveStore): Promise<string> {
  const key = store.sessionKey;
  const dir = `data/raw/${key}`;
  try {
    const files = await writeRawCache(store, dir);
    console.log(`[live] wrote ${files} raw cache files to ${dir}; turn it into a replay with: bun run ingest ${key}`);
    return `raw data saved to ${dir}: run \`bun run ingest ${key}\` for a replay`;
  } catch (e) {
    console.error(`[live] could not write the raw cache: ${errorText(e)}`);
    return "could not save the raw data";
  }
}

/** One live session's MQTT feed, reconnecting and rotating tokens as needed; after a gap it asks for a refill. */
class MqttFeed implements LiveFeed {
  private client: MqttClient | null = null;
  private stopped = false;
  private reconnecting = false;
  private rotateTimer: ReturnType<typeof setTimeout> | null = null;
  private attempts = 0;

  constructor(
    private store: LiveStore,
    private hooks: FeedHooks,
  ) {}

  async start(): Promise<void> {
    try {
      await this.connect();
    } catch (e) {
      console.warn(`[live] MQTT connect failed (${errorText(e)}); retrying in the background`);
      void this.reconnect();
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.rotateTimer) clearTimeout(this.rotateTimer);
    this.client?.end(true);
    this.client = null;
  }

  private onMessage(topic: string, payload: Buffer): void {
    const t = topic.startsWith("v1/") ? (topic.slice(3) as Topic) : null;
    if (!t || !(TOPICS as readonly string[]).includes(t)) return;
    let rec: Rec;
    try {
      rec = JSON.parse(payload.toString());
    } catch {
      return;
    }
    this.hooks.deliver(t, rec);
  }

  /** A new MQTT connection with a fresh token; resolves once subscribed. Replaces the current one. */
  private async connect(): Promise<void> {
    const creds = credentials();
    const password = await accessToken();
    if (!creds || !password) throw new AuthError("OpenF1 credentials missing");
    const expiresAt = tokenExpiresAt();
    const client = mqtt.connect(MQTT_URL, {
      username: creds.username,
      password,
      clientId: `f1-replay-${crypto.randomUUID().slice(0, 8)}`,
      reconnectPeriod: 0, // reconnect ourselves, with a fresh token
      forceNativeWebSocket: true, // Bun's WebSocket (mqtt.js's default `ws` stream isn't supported by Bun)
      connectTimeout: 20_000,
      keepalive: 30,
      clean: true,
    });
    let settled = false;
    const onError = (e: Error) => {
      if (/not authori[sz]ed|bad user ?name or password/i.test(e.message)) invalidateToken();
      if (settled) console.warn(`[live] MQTT error: ${e.message}`);
    };
    client.on("error", onError); // an 'error' without a listener would throw
    await new Promise<void>((resolve, reject) => {
      const fail = (e: Error) => {
        if (settled) return;
        settled = true;
        client.off("close", onClose);
        client.end(true);
        reject(e);
      };
      const onClose = () => fail(new Error("connection closed (rejected token?)"));
      client.once("error", fail);
      client.on("close", onClose);
      client.once("connect", () => {
        client.subscribe(
          TOPICS.map((t) => `v1/${t}`),
          { qos: 0 },
          (err, granted) => {
            if (err) return fail(err);
            const refused = (granted ?? []).filter((g) => g.qos === 128).map((g) => g.topic);
            if (refused.length) return fail(new Error(`subscription refused: ${refused.join(", ")}`));
            settled = true;
            client.off("close", onClose);
            client.off("error", fail);
            resolve();
          },
        );
      });
    });
    client.on("message", (topic, payload) => this.onMessage(topic, payload));
    client.on("close", () => {
      if (this.client === client && !this.stopped) void this.reconnect();
    });
    // Make before break: the old connection (if any) goes once the new one is subscribed.
    const old = this.client;
    this.client = client;
    old?.end(true);
    this.attempts = 0;
    console.log(`[live] MQTT subscribed to ${TOPICS.length} topics`);
    if (this.rotateTimer) clearTimeout(this.rotateTimer);
    if (expiresAt) {
      this.rotateTimer = setTimeout(() => void this.rotate(), Math.max(60_000, expiresAt - ROTATE_BEFORE_EXPIRY_MS - Date.now()));
    }
  }

  private async rotate(): Promise<void> {
    if (this.stopped) return;
    try {
      await this.connect();
    } catch (e) {
      console.warn(`[live] MQTT token rotation failed (${errorText(e)})`);
      void this.reconnect();
    }
  }

  /** Reconnect with backoff; then have whatever the gap may have lost re-fetched over REST. */
  private async reconnect(): Promise<void> {
    if (this.reconnecting || this.stopped) return;
    this.reconnecting = true;
    const since = this.store.latestDataTime;
    const lostAt = Date.now();
    try {
      while (!this.stopped) {
        const delay = Math.min(60_000, 2_000 * 2 ** this.attempts++);
        await sleep(delay);
        try {
          await this.connect();
          break;
        } catch (e) {
          console.warn(`[live] MQTT reconnect failed (${errorText(e)}); next try in ${Math.min(60, 2 * 2 ** this.attempts)}s`);
        }
      }
      if (!this.stopped && Date.now() - lostAt > GAP_BACKFILL_AFTER_MS) await this.hooks.refill(since);
    } finally {
      this.reconnecting = false;
    }
  }
}
