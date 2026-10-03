// Live mode's message stream (./protocol.ts), shared by the relay (server/hub.ts: WebSocket clients) and the
// browser's live worker (./worker.ts: one consumer, the app): the status on connect and on change, a snapshot on
// connect and when the live session changes, `meta` every ~2 s and `tel` (new samples only) every ~0.5 s.

import type { LiveMessage, LiveState, LiveStatus } from "./protocol";
import { LiveSession, type LiveStore } from "./store";

const TEL_INTERVAL_MS = 500;
const META_EVERY = 4; // tel ticks per meta (~2 s)
const STATS_INTERVAL_MS = 60_000;

export type Source = LiveStatus["source"];
export type StatusPatch = Partial<Omit<LiveStatus, "type" | "source">>;

/** Where the hub's messages go. */
export interface HubOutput {
  /** Consumers connected now. */
  clients(): number;
  /** One message to every consumer. Returns its size in bytes when it was serialized (for the stats), else 0. */
  broadcast(msg: LiveMessage): number;
}

/** What a live source (OpenF1's feed, a simulation) drives. */
export interface LiveSink {
  readonly state: LiveState;
  readonly session: LiveSession | null;
  setStatus(patch: StatusPatch): void;
  /** A (new) live session: everyone gets a snapshot, then the stream starts. */
  startSession(store: LiveStore): void;
  /** The session is over: stream what's left, then keep the data for new consumers. */
  endSession(detail?: string): void;
}

export class LiveHub implements LiveSink {
  status: LiveStatus;
  session: LiveSession | null = null;
  private ticks = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private statsTimer: ReturnType<typeof setInterval> | null = null;
  protected last = { metaBytes: 0, telBytes: 0, snapshotBytes: 0, telChunks: 0 };
  private recomputeMs: number[] = [];

  constructor(
    source: Source,
    private out: HubOutput | null = null,
    protected log: (line: string) => void = (line) => console.log(line),
  ) {
    this.status = { type: "status", state: "idle", source, sessionKey: null, next: null };
  }

  get state(): LiveState {
    return this.status.state;
  }

  /** Consumers connected now (the relay overrides this and broadcast()). */
  protected clients(): number {
    return this.out?.clients() ?? 0;
  }

  protected broadcast(msg: LiveMessage): number {
    return this.out?.broadcast(msg) ?? 0;
  }

  /**
   * What a consumer that just connected (already counted in clients()) is sent: the status, and the session so far.
   * Alone, a fresh result, all of it in the snapshot. Otherwise everything the others have been sent so far (the
   * rest follows in the next `tel` for everyone).
   */
  welcome(): LiveMessage[] {
    const out: LiveMessage[] = [this.status];
    const session = this.session;
    if (!session) return out;
    session.recompute();
    if (this.clients() === 1) session.markAllSent();
    const snap = session.snapshot();
    if (snap) out.push(snap);
    return out;
  }

  setStatus(patch: StatusPatch): void {
    const next: LiveStatus = { ...this.status, ...patch };
    if (patch.detail === undefined && patch.state && patch.state !== this.status.state) delete next.detail;
    const changed = JSON.stringify(next) !== JSON.stringify(this.status);
    this.status = next;
    if (changed) {
      this.log(`[live] ${next.state}${next.sessionKey ? ` #${next.sessionKey}` : ""}${next.detail ? `: ${next.detail}` : ""}`);
      this.broadcast(next);
    }
  }

  startSession(store: LiveStore): void {
    this.stopTicking();
    this.session = new LiveSession(store);
    this.setStatus({ state: "live", sessionKey: store.sessionKey });
    if (this.clients()) {
      this.session.recompute();
      this.session.markAllSent();
      const snap = this.session.snapshot();
      if (snap) this.last.snapshotBytes = this.broadcast(snap);
    }
    this.ticks = 0;
    this.timer = setInterval(() => this.tick(), TEL_INTERVAL_MS);
    this.statsTimer = setInterval(() => this.logStats(), STATS_INTERVAL_MS);
  }

  endSession(detail?: string): void {
    this.stopTicking();
    this.session?.recompute();
    this.session?.freeze();
    if (this.clients()) this.flush(true);
    this.setStatus({ state: "ended", ...(detail ? { detail } : {}) });
  }

  /** No more ticks (the consumer is gone for good). */
  stop(): void {
    this.stopTicking();
  }

  private stopTicking(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.statsTimer) clearInterval(this.statsTimer);
    this.timer = this.statsTimer = null;
  }

  /** Every ~2 s a full recompute (meta + telemetry); in between, new samples only. */
  private tick(): void {
    const session = this.session;
    if (!session || this.state !== "live" || !this.clients()) return;
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

  health() {
    const store = this.session?.store;
    const latest = this.session?.latest;
    return {
      state: this.status.state,
      source: this.status.source,
      sessionKey: this.status.sessionKey,
      clients: this.clients(),
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
    const bytes = this.last.metaBytes ? `, meta ${kb(this.last.metaBytes)}, tel ${kb(this.last.telBytes)} (${this.last.telChunks} drivers)` : "";
    this.log(`[live] lap ${lap}: normalize avg ${avg.toFixed(0)} ms / max ${max.toFixed(0)} ms${bytes}, ${this.clients()} client(s), ${session.store.records} records`);
  }
}
