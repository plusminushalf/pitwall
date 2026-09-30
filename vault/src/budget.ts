// The REST budget: every OpenF1 read the vault makes, from every tab, goes through one of these, owned by the
// leader frame (tabs.ts; followers forward their gets), so it is one budget per browser, per account.
// Pure (injected clock and timers), tested in budget.test.ts.
//
// - OpenF1's limits (docs/modular-hypotheses.md, facts): 6 requests/s and 60/min with a token (sponsor
//   tier), 3/s and 30/min without. Starts are spaced SPACING / perSecond apart (no bursts; the 15% margin
//   is for network jitter, measured against the simulation's limiter) and at most perMinute start in any
//   60 s. Requests run in parallel within that: up to MAX_IN_FLIGHT at once.
// - Priorities: live gap-fills first. While the stream runs (setReserve), downloads and other callers
//   leave LIVE_RESERVE of each minute's requests unused, so a gap-fill after a drop never waits for a
//   download's minute to roll over.
// - Fairness: callers (a port of an app tab, the download worker's port, the live stream) take turns, one
//   start each (round robin), and none holds more than PER_CALLER_IN_FLIGHT at once or queues more than
//   PER_CALLER_QUEUE: one busy or misbehaving caller can't starve the others, and whatever it asks, the
//   account never goes over OpenF1's limits.
// - A 429 (we went over anyway: another client of the same account, or OpenF1 counting differently):
//   everything pauses for Retry-After when the response has one (browsers usually can't read it cross-
//   origin), else a backoff (2 s doubling to 60 s, jittered), and the limits are halved for a minute.

import type { BudgetStatus } from "./protocol";
import { ANON_LIMIT, AUTH_LIMIT, SPACING, type RateLimit } from "./rest";

export type Priority = "live" | "normal";

/** At most this many requests in flight at once, over every caller (live gap-fills may add to it). */
export const MAX_IN_FLIGHT = 8;
/** At most this many in flight for one caller (so another caller always has room). */
export const PER_CALLER_IN_FLIGHT = 6;
/** Beyond this many queued requests a caller's next one is refused (rate_limited). */
export const PER_CALLER_QUEUE = 128;
/** Of each minute's requests, this many are kept for live gap-fills while the stream runs (14 topics: one each). */
export const LIVE_RESERVE = 14;
/** After a 429: pause everything (doubling per 429 in a row, jittered) and halve the limits for SHRINK_MS. */
export const PAUSE_429_BASE_MS = 2_000;
export const PAUSE_429_CAP_MS = 60_000;
export const SHRINK_MS = 60_000;
export const SHRINK_FACTOR = 0.5;
export const JITTER = 0.2;

export type BudgetDeps = {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  random(): number;
  /** Whether requests go out with a token now (the account's limits) or without (the anonymous ones). */
  authenticated(): boolean;
  /** Something in status() changed. */
  onChange?(): void;
};

export class BudgetError extends Error {
  constructor(readonly code: "rate_limited" | "cancelled") {
    super(code === "rate_limited" ? "too many requests queued" : "cancelled");
  }
}

/** A granted start: release it when the response (body included) is in, or the request failed. */
export type Slot = { release(outcome: { status: number | null; retryAfterMs?: number }): void };

type Waiter = { priority: Priority; resolve(s: Slot): void; reject(e: Error): void };
type Caller = { id: string; queue: Waiter[]; inFlight: number };

export class Budget {
  private starts: number[] = [];
  private callers = new Map<string, Caller>();
  /** Round-robin position among callers (the id that started last). */
  private last: string | null = null;
  private inFlight = 0;
  private reserve = 0;
  private pausedUntil = 0;
  private shrunkUntil = 0;
  /** 429s in a row (the pause doubles with each). */
  private strikes = 0;
  private started = 0;
  private rateLimited = 0;
  private timer: unknown = null;
  private timerAt = 0;

  constructor(private deps: BudgetDeps) {}

  /**
   * Wait for a start for `caller`. `front`: ahead of the caller's other queued requests (a retry). Rejects
   * with BudgetError: rate_limited (the caller already has PER_CALLER_QUEUE queued), cancelled (cancel()).
   */
  acquire(caller: string, priority: Priority = "normal", opts: { front?: boolean } = {}): Promise<Slot> {
    let c = this.callers.get(caller);
    if (!c) this.callers.set(caller, (c = { id: caller, queue: [], inFlight: 0 }));
    if (c.queue.length >= PER_CALLER_QUEUE) return Promise.reject(new BudgetError("rate_limited"));
    const cc = c;
    const p = new Promise<Slot>((resolve, reject) => {
      const w: Waiter = { priority, resolve, reject };
      if (opts.front) cc.queue.unshift(w);
      else cc.queue.push(w);
    });
    this.pump();
    return p;
  }

  /** Drop a caller's queued requests (its port closed). In-flight ones finish. Returns how many were dropped. */
  cancel(caller: string): number {
    const c = this.callers.get(caller);
    if (!c) return 0;
    const dropped = c.queue.splice(0);
    for (const w of dropped) w.reject(new BudgetError("cancelled"));
    this.forget(c);
    if (dropped.length) this.changed();
    return dropped.length;
  }

  /** Callers whose id starts with `prefix` (every port of a frame that went away): cancel them all. */
  cancelPrefix(prefix: string): number {
    let n = 0;
    for (const id of [...this.callers.keys()]) if (id.startsWith(prefix)) n += this.cancel(id);
    return n;
  }

  /** The live stream is running (keep LIVE_RESERVE of each minute for its gap-fills) or not. */
  setReserve(on: boolean) {
    const r = on ? LIVE_RESERVE : 0;
    if (r === this.reserve) return;
    this.reserve = r;
    this.pump();
    this.changed();
  }

  /** Start times in the last minute: the heartbeat carries them, so a leader that takes over knows them. */
  recentStarts(): number[] {
    this.prune(this.deps.now());
    return [...this.starts];
  }

  /** After a takeover: the previous leader's recent starts count against this minute too. */
  seed(starts: readonly number[]) {
    const now = this.deps.now();
    const all = [...this.starts, ...starts.filter((t) => Number.isFinite(t) && t > now - 60_000 && t <= now)].sort((a, b) => a - b);
    this.starts = all.filter((t, i) => i === 0 || t !== all[i - 1]);
    this.pump();
  }

  status(): BudgetStatus {
    const now = this.deps.now();
    this.prune(now);
    const lim = this.limit(now);
    let queued = 0;
    let callers = 0;
    for (const c of this.callers.values()) {
      queued += c.queue.length;
      if (c.queue.length || c.inFlight) callers++;
    }
    return {
      auth: this.deps.authenticated(),
      perSecond: lim.perSecond,
      perMinute: lim.perMinute,
      inFlight: this.inFlight,
      queued,
      usedThisMinute: this.starts.length,
      callers,
      reserve: this.reserve,
      started: this.started,
      rateLimited: this.rateLimited,
      ...(this.pausedUntil > now && { pausedUntil: this.pausedUntil }),
      ...(this.shrunkUntil > now && { shrunkUntil: this.shrunkUntil }),
    };
  }

  // ---------------------------------------------------------------- internals

  private changed() {
    this.deps.onChange?.();
  }

  private forget(c: Caller) {
    if (!c.queue.length && !c.inFlight) this.callers.delete(c.id);
  }

  private prune(now: number) {
    let i = 0;
    while (i < this.starts.length && this.starts[i]! <= now - 60_000) i++;
    if (i) this.starts.splice(0, i);
  }

  /** The limits in force: OpenF1's for the tier, halved while shrunk after a 429. */
  private limit(now: number): RateLimit {
    const base = this.deps.authenticated() ? AUTH_LIMIT : ANON_LIMIT;
    if (now >= this.shrunkUntil) return base;
    return { perSecond: Math.max(1, Math.floor(base.perSecond * SHRINK_FACTOR)), perMinute: Math.max(1, Math.floor(base.perMinute * SHRINK_FACTOR)) };
  }

  /** How long until a request of this priority may start (0: now). */
  private wait(priority: Priority, now: number): number {
    if (now < this.pausedUntil) return this.pausedUntil - now;
    const lim = this.limit(now);
    const last = this.starts.at(-1);
    const spacing = last === undefined ? 0 : last + SPACING / lim.perSecond - now;
    const cap = priority === "live" ? lim.perMinute : Math.max(1, lim.perMinute - this.reserve);
    const minute = this.starts.length >= cap ? this.starts[this.starts.length - cap]! + 60_000 - now : 0;
    return Math.max(spacing, minute, 0);
  }

  /** The next request to start: live first, then the callers in turn; none over its in-flight cap. */
  private pick(): { c: Caller; w: Waiter } | null {
    const ids = [...this.callers.keys()];
    if (!ids.length) return null;
    const from = this.last === null ? 0 : ids.indexOf(this.last) + 1;
    for (const priority of ["live", "normal"] as const) {
      for (let k = 0; k < ids.length; k++) {
        const c = this.callers.get(ids[(from + k) % ids.length]!)!;
        if (c.inFlight >= PER_CALLER_IN_FLIGHT) continue;
        const i = c.queue.findIndex((w) => w.priority === priority);
        if (i >= 0) return { c, w: c.queue[i]! };
      }
    }
    return null;
  }

  private pump() {
    for (;;) {
      const next = this.pick();
      // (Live gap-fills aren't held back by the downloads' in-flight requests, only by their own cap.)
      if (!next || (next.w.priority !== "live" && this.inFlight >= MAX_IN_FLIGHT)) break;
      const now = this.deps.now();
      this.prune(now);
      const wait = this.wait(next.w.priority, now);
      if (wait > 0) {
        this.arm(now + Math.ceil(wait));
        break;
      }
      const { c, w } = next;
      c.queue.splice(c.queue.indexOf(w), 1);
      c.inFlight++;
      this.inFlight++;
      this.started++;
      this.starts.push(now);
      this.last = c.id;
      w.resolve(this.slot(c));
    }
    this.changed();
  }

  private arm(at: number) {
    if (this.timer !== null) {
      if (this.timerAt <= at) return;
      this.deps.clearTimeout(this.timer);
    }
    this.timerAt = at;
    this.timer = this.deps.setTimeout(() => {
      this.timer = null;
      this.pump();
    }, Math.max(0, at - this.deps.now()));
  }

  private slot(c: Caller): Slot {
    let done = false;
    return {
      release: ({ status, retryAfterMs }) => {
        if (done) return;
        done = true;
        c.inFlight--;
        this.inFlight--;
        const now = this.deps.now();
        if (status === 429) {
          this.rateLimited++;
          this.strikes++;
          const backoff = Math.min(PAUSE_429_CAP_MS, PAUSE_429_BASE_MS * 2 ** (this.strikes - 1));
          const pause = retryAfterMs !== undefined && retryAfterMs > 0 ? Math.min(PAUSE_429_CAP_MS * 2, retryAfterMs) : Math.round(backoff * (1 - JITTER + 2 * JITTER * this.deps.random()));
          this.pausedUntil = Math.max(this.pausedUntil, now + pause);
          this.shrunkUntil = now + SHRINK_MS;
        } else if (status !== null && status < 500) this.strikes = 0;
        this.forget(c);
        this.pump();
      },
    };
  }
}
