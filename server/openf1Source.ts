// Live data from OpenF1 (sponsor tier): polls for the current session, and while a race or sprint
// is on, backfills it over REST and follows it over MQTT (secure WebSocket).

import mqtt, { type MqttClient } from "mqtt";
import {
  AuthError,
  accessToken,
  credentials,
  fetchCircuit,
  fetchEndpoint,
  invalidateToken,
  tokenExpiresAt,
  type RawCircuit,
  type RawMeeting,
  type RawSession,
} from "../scripts/openf1";
import type { LiveStatus } from "../src/live/protocol";
import type { Hub } from "./hub";
import { LiveStore, TOPICS, type Topic } from "./store";

const MQTT_URL = "wss://mqtt.openf1.org:8084/mqtt";
const POLL_MS = 60_000;
const NEXT_REFRESH_MS = 60 * 60_000;
const BEFORE_START_MS = 15 * 60_000; // go live this long before the scheduled start
const AFTER_END_MS = 30 * 60_000; // ...and stay live at least this long after the scheduled end
const MAX_OVERRUN_MS = 3 * 60 * 60_000; // red flags can stretch a race; give up after this
const QUIET_MS = 10 * 60_000; // no data for this long (after the scheduled end): it's over
const T0_BEFORE_START_MS = 10 * 60_000;
const ROTATE_BEFORE_EXPIRY_MS = 3 * 60_000; // new MQTT connection with a fresh token
const GAP_BACKFILL_AFTER_MS = 5_000; // after a reconnect, re-fetch over REST what may have been missed

// Documents first (drivers are needed for the per-driver telemetry), then time series.
const BACKFILL: Topic[] = [
  "drivers",
  "laps",
  "stints",
  "pit",
  "session_result",
  "race_control",
  "position",
  "intervals",
  "weather",
  "team_radio",
  "overtakes",
];
const TIME_SERIES = new Set<Topic>(["race_control", "position", "intervals", "weather", "team_radio", "overtakes"]);

type Rec = Record<string, any>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const iso = (t: number) => new Date(t).toISOString();
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export const isRaceSession = (s: RawSession) => s.session_type === "Race" && !s.is_cancelled;

/** Within [scheduled start - 15 min, scheduled end + 30 min]. */
export function inLiveWindow(s: RawSession, now: number): boolean {
  return now >= Date.parse(s.date_start) - BEFORE_START_MS && now <= Date.parse(s.date_end) + AFTER_END_MS;
}

export class OpenF1Source {
  private live: LiveConnection | null = null;
  private polling = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private next: { at: number; value: LiveStatus["next"] } | null = null;

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
    void this.poll();
    this.timer = setInterval(() => void this.poll(), POLL_MS);
  }

  async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const [latest] = await fetchEndpoint<RawSession>("sessions", { session_key: "latest" });
      const now = Date.now();
      if (this.live) {
        if (latest?.session_key === this.live.store.sessionKey) this.live.store.ingest("sessions", latest);
        if (this.live.finished(now)) await this.endLive();
        else if (this.hub.state === "error") this.hub.setStatus({ state: "live" });
        return;
      }
      if (latest && isRaceSession(latest) && inLiveWindow(latest, now)) {
        await this.goLive(latest);
        return;
      }
      const next = await this.nextRace(now);
      this.hub.setStatus({ state: this.hub.session ? "ended" : "idle", sessionKey: this.hub.session?.store.sessionKey ?? null, next });
    } catch (e) {
      if (e instanceof AuthError) this.hub.setStatus({ state: "error", detail: e.message });
      else {
        console.warn(`[live] OpenF1 poll failed: ${errorText(e)}`);
        if (this.hub.state === "connecting") this.hub.setStatus({ detail: `retrying: ${errorText(e)}` });
      }
    } finally {
      this.polling = false;
    }
  }

  /** The next race or sprint that hasn't started (this year, else next year). */
  private async nextRace(now: number): Promise<LiveStatus["next"]> {
    if (this.next && now - this.next.at < NEXT_REFRESH_MS && (!this.next.value || Date.parse(this.next.value.dateStart) > now)) {
      return this.next.value;
    }
    const year = new Date(now).getUTCFullYear();
    let value: LiveStatus["next"] = null;
    for (const y of [year, year + 1]) {
      const sessions = await fetchEndpoint<RawSession>("sessions", { year: y, session_type: "Race" });
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

  private async goLive(session: RawSession): Promise<void> {
    const key = session.session_key;
    this.hub.setStatus({ state: "connecting", sessionKey: key, next: null, detail: "backfilling from OpenF1" });
    const [meeting] = await fetchEndpoint<RawMeeting>("meetings", { meeting_key: session.meeting_key });
    let circuit: RawCircuit | null = null;
    if (meeting?.circuit_info_url) {
      circuit = await fetchCircuit(meeting.circuit_info_url).catch((e) => {
        console.warn(`[live] circuit info unavailable (${errorText(e)})`);
        return null;
      });
    }
    const store = new LiveStore({
      session,
      meeting: meeting ?? null,
      circuit,
      t0: Date.parse(session.date_start) - T0_BEFORE_START_MS,
      keepRaw: true,
    });
    const conn = new LiveConnection(store);
    try {
      await conn.start();
    } catch (e) {
      conn.stop(); // the next poll starts over
      throw e;
    }
    this.live = conn;
    this.hub.startSession(store);
  }

  private async endLive(): Promise<void> {
    const conn = this.live;
    if (!conn) return;
    this.live = null;
    conn.stop();
    const key = conn.store.sessionKey;
    const detail = await this.saveRaw(conn);
    this.hub.endSession(detail);
    this.hub.setStatus({ next: await this.nextRace(Date.now()).catch(() => null) });
    console.log(`[live] #${key} over`);
  }

  private async saveRaw(conn: LiveConnection): Promise<string> {
    const key = conn.store.sessionKey;
    const dir = `data/raw/${key}`;
    try {
      const files = await conn.store.writeRawCache(dir);
      console.log(`[live] wrote ${files} raw cache files to ${dir}; turn it into a replay with: bun run ingest ${key}`);
      return `raw data saved to ${dir}: run \`bun run ingest ${key}\` for a replay`;
    } catch (e) {
      console.error(`[live] could not write the raw cache: ${errorText(e)}`);
      return "could not save the raw data";
    }
  }

  /** Ctrl-C during a session: keep what was received. */
  async shutdown(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    const conn = this.live;
    if (!conn) return;
    this.live = null;
    conn.stop();
    if (conn.store.records > 0) await this.saveRaw(conn);
  }
}

/** One live session's feed: REST backfill + MQTT, reconnecting and rotating tokens as needed. */
class LiveConnection {
  private client: MqttClient | null = null;
  private buffering = true;
  private buffer: [Topic, Rec][] = [];
  private stopped = false;
  private reconnecting = false;
  private rotateTimer: ReturnType<typeof setTimeout> | null = null;
  private attempts = 0;

  constructor(readonly store: LiveStore) {}

  /** Subscribe (buffering), backfill over REST, then apply what arrived meanwhile. */
  async start(): Promise<void> {
    try {
      await this.connect();
    } catch (e) {
      console.warn(`[live] MQTT connect failed (${errorText(e)}); retrying in the background`);
      void this.reconnect();
    }
    await this.backfill();
    for (const [topic, rec] of this.buffer) this.store.ingest(topic, rec);
    this.buffer = [];
    this.buffering = false;
  }

  stop(): void {
    this.stopped = true;
    if (this.rotateTimer) clearTimeout(this.rotateTimer);
    this.client?.end(true);
    this.client = null;
  }

  /** Over after the scheduled end once the data dries up (or long after the flag). */
  finished(now: number): boolean {
    const end = Date.parse(this.store.session.date_end);
    if (now > end + MAX_OVERRUN_MS) return true;
    if (now <= end + AFTER_END_MS) return false;
    const quiet = this.store.lastMessageAt == null || now - this.store.lastMessageAt > QUIET_MS;
    const flag = this.store.list<{ flag: string | null; date: string }>("race_control").find((m) => m.flag === "CHEQUERED");
    return quiet || (flag != null && now - Date.parse(flag.date) > AFTER_END_MS);
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
    if (this.buffering) this.buffer.push([t, rec]);
    else this.store.ingest(t, rec);
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

  /** Reconnect with backoff; then re-fetch over REST whatever the gap may have lost. */
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
      if (!this.stopped && !this.buffering && Date.now() - lostAt > GAP_BACKFILL_AFTER_MS) {
        await this.backfill(Number.isFinite(since) ? since - 30_000 : undefined);
      }
    } finally {
      this.reconnecting = false;
    }
  }

  /** Everything so far over REST (time series only after `since`, when given). */
  private async backfill(since?: number): Promise<void> {
    const key = this.store.sessionKey;
    const started = Date.now();
    let count = 0;
    const get = async (topic: Topic, params: Record<string, string | number>) => {
      const recs = await fetchEndpoint<Rec>(topic, { session_key: key, ...params });
      for (const r of recs) this.store.ingest(topic, r);
      count += recs.length;
    };
    for (const topic of BACKFILL) {
      if (this.stopped) return;
      await get(topic, since != null && TIME_SERIES.has(topic) ? { "date>": iso(since) } : {});
    }
    // Telemetry from t0 on (the replay window never starts earlier).
    const from = iso(since ?? this.store.t0);
    const numbers = this.store.list<{ driver_number: number }>("drivers").map((d) => d.driver_number);
    for (const n of numbers) {
      for (const topic of ["car_data", "location"] as const) {
        if (this.stopped) return;
        await get(topic, { driver_number: n, "date>": from });
      }
    }
    console.log(`[live] ${since != null ? "gap " : ""}backfill: ${count} records in ${((Date.now() - started) / 1000).toFixed(0)}s`);
  }
}
