// Fan-out to browser clients: status on connect and on change, a snapshot on connect and when the
// live session changes, `meta` every ~2 s and `tel` (new samples only) every ~0.5 s.

import type { Server, ServerWebSocket } from "bun";
import type { LiveMessage, LiveState, LiveStatus } from "../src/live/protocol";
import { LiveSession, type LiveStore } from "./store";

const TEL_INTERVAL_MS = 500;
const META_EVERY = 4; // tel ticks per meta (~2 s)
const STATS_INTERVAL_MS = 60_000;
const TOPIC = "live";

export type Source = LiveStatus["source"];

export class Hub {
  status: LiveStatus;
  session: LiveSession | null = null;
  private server: Server<unknown> | null = null;
  private clients = new Set<ServerWebSocket<unknown>>();
  private ticks = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private statsTimer: ReturnType<typeof setInterval> | null = null;
  private last = { metaBytes: 0, telBytes: 0, snapshotBytes: 0, telChunks: 0 };
  private recomputeMs: number[] = [];

  constructor(source: Source) {
    this.status = { type: "status", state: "idle", source, sessionKey: null, next: null };
  }

  attach(server: Server<unknown>): void {
    this.server = server;
  }

  get state(): LiveState {
    return this.status.state;
  }

  // ------------------------------------------------------------- clients

  open(ws: ServerWebSocket<unknown>): void {
    this.clients.add(ws);
    ws.subscribe(TOPIC);
    this.sendTo(ws, this.status);
    const session = this.session;
    if (!session) return;
    // Alone: a fresh result, all of it in the snapshot. Otherwise everything the others have been
    // sent so far (the rest follows in the next `tel` for everyone).
    session.recompute();
    if (this.clients.size === 1) session.markAllSent();
    const snap = session.snapshot();
    if (snap) this.last.snapshotBytes = this.sendTo(ws, snap);
  }

  close(ws: ServerWebSocket<unknown>): void {
    this.clients.delete(ws);
  }

  get clientCount(): number {
    return this.clients.size;
  }

  private sendTo(ws: ServerWebSocket<unknown>, msg: LiveMessage): number {
    const json = JSON.stringify(msg);
    ws.send(json, true);
    return json.length;
  }

  private broadcast(msg: LiveMessage): number {
    if (!this.server || !this.clients.size) return 0;
    const json = JSON.stringify(msg);
    this.server.publish(TOPIC, json, true);
    return json.length;
  }

  // ------------------------------------------------------------- state

  setStatus(patch: Partial<Omit<LiveStatus, "type" | "source">>): void {
    const next: LiveStatus = { ...this.status, ...patch };
    if (patch.detail === undefined && patch.state && patch.state !== this.status.state) delete next.detail;
    const changed = JSON.stringify(next) !== JSON.stringify(this.status);
    this.status = next;
    if (changed) {
      console.log(`[live] ${next.state}${next.sessionKey ? ` #${next.sessionKey}` : ""}${next.detail ? `: ${next.detail}` : ""}`);
      this.broadcast(next);
    }
  }

  /** A (new) live session: everyone gets a snapshot, then the stream starts. */
  startSession(store: LiveStore): void {
    this.stopTicking();
    this.session = new LiveSession(store);
    this.setStatus({ state: "live", sessionKey: store.sessionKey });
    if (this.clients.size) {
      this.session.recompute();
      this.session.markAllSent();
      const snap = this.session.snapshot();
      if (snap) this.last.snapshotBytes = this.broadcast(snap);
    }
    this.ticks = 0;
    this.timer = setInterval(() => this.tick(), TEL_INTERVAL_MS);
    this.statsTimer = setInterval(() => this.logStats(), STATS_INTERVAL_MS);
  }

  /** The session is over: stream what's left, then keep the data for new clients. */
  endSession(detail?: string): void {
    this.stopTicking();
    this.session?.recompute();
    this.session?.freeze();
    if (this.clients.size) this.flush(true);
    this.setStatus({ state: "ended", ...(detail ? { detail } : {}) });
  }

  private stopTicking(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.statsTimer) clearInterval(this.statsTimer);
    this.timer = this.statsTimer = null;
  }

  /** Every ~2 s a full recompute (meta + telemetry); in between, new samples only. */
  private tick(): void {
    const session = this.session;
    if (!session || this.state !== "live" || !this.clients.size) return;
    this.ticks++;
    if (this.ticks % META_EVERY === 0) {
      session.recompute();
      this.recomputeMs.push(session.stats.normalizeMs);
      this.flush(true);
    } else this.flush(false, session.quickChunks());
  }

  private flush(full: boolean, quick?: ReturnType<LiveSession["quickChunks"]>): void {
    const session = this.session;
    const latest = session?.latest;
    if (!session || !latest) return;
    const now = quick ? session.store.now() - session.store.t0 : latest.meta.duration;
    const chunks = quick ?? session.telemetryChunks();
    if (chunks.length) {
      this.last.telBytes = this.broadcast({ type: "tel", now, chunks });
      this.last.telChunks = chunks.length;
    }
    if (full) this.last.metaBytes = this.broadcast({ type: "meta", meta: latest.meta, now });
  }

  // ------------------------------------------------------------- health

  health() {
    const store = this.session?.store;
    const latest = this.session?.latest;
    return {
      state: this.status.state,
      source: this.status.source,
      sessionKey: this.status.sessionKey,
      clients: this.clients.size,
      lastMessageAt: store?.lastMessageAt ? new Date(store.lastMessageAt).toISOString() : null,
      detail: this.status.detail ?? null,
      next: this.status.next ?? null,
      now: latest?.meta.duration ?? null,
      records: store?.records ?? 0,
      normalizeMs: this.session ? Math.round(this.session.stats.normalizeMs) : null,
      lastBytes: this.last,
    };
  }

  private logStats(): void {
    const session = this.session;
    if (!session || !this.recomputeMs.length) return;
    const times = this.recomputeMs.splice(0);
    const avg = times.reduce((a, b) => a + b, 0) / times.length;
    const max = Math.max(...times);
    const lap = Math.max(0, ...(session.latest?.meta.laps.map((l) => l.lap) ?? []));
    const kb = (b: number) => `${(b / 1024).toFixed(0)} KB`;
    console.log(
      `[live] lap ${lap}: normalize avg ${avg.toFixed(0)} ms / max ${max.toFixed(0)} ms, meta ${kb(this.last.metaBytes)}, tel ${kb(this.last.telBytes)} (${this.last.telChunks} drivers), ${this.clients.size} client(s), ${session.store.records} records`,
    );
  }
}
