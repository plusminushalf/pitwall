// Silent token refresh. Pure: the clock, the timers, the randomness and the /token call are injected, so
// bun tests drive it with a fake clock. No DOM (frame.ts calls wake() on visibilitychange / online).
//
// OpenF1 facts it is built on (docs/hypotheses.md, facts, verified 2026-09-30): a token lasts
// `expires_in` (3600 s); there is no refresh token, so a refresh is the password grant again; a new token
// doesn't invalidate older ones; REST answers 401 from the first second after `exp`, no grace; /token
// answers an nginx 429 to bursts (about 8 requests in 1.6 s).
//
// The schedule:
// - refresh at 5/6 of the token's lifetime, counted from the local time the request was sent (Token.issuedAt);
// - on failure retry with exponential backoff and jitter (5 s, 10 s, 20 s … capped at 2 min; a 429 starts at
//   30 s) while the current token is still good; once it has expired the phase is "expired" and retries run at
//   the cap;
// - a 401 from /token means the password was changed or revoked: stop, keep the current token until its
//   own expiry, and raise `needsReauth` (the app shows "Reconnect your OpenF1 account");
// - every refresh is coalesced into one in-flight /token call;
// - a REST 401 refreshes at once, unless the token it used is brand new: then the token is
//   marked `rejected` (callers go unauthenticated) and the next try waits for the backoff cap. No storms;
// - timers are armed against absolute times and never sleep longer than MAX_SLEEP_MS, and wake() re-checks
//   the wall clock, because background tabs throttle timers and a laptop lid stops them altogether.

import type { LoginErrorCode, RefreshPhase, RefreshStatus } from "./protocol";
import type { Token, TokenResult } from "./openf1";

export type Timers = {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
};

export type SchedulerDeps = Timers & {
  /** One POST /token with the stored login. Never rejects (requestToken's contract). */
  fetchToken(): Promise<TokenResult>;
  /** [0, 1), for jitter. */
  random(): number;
  /** Called after every change to status() (and when a new token is in place). */
  onChange(): void;
};

/** Refresh when this fraction of the lifetime has passed. */
export const REFRESH_AT = 5 / 6;
export const BACKOFF_BASE_MS = 5_000;
/** A 429 from /token starts its backoff here instead. */
export const BACKOFF_429_MS = 30_000;
export const BACKOFF_CAP_MS = 120_000;
/** Each delay is scaled by a factor in [1 - JITTER, 1 + JITTER). */
export const JITTER = 0.2;
/** A REST 401 on a token younger than this doesn't refresh again: the fresh token itself is refused. */
export const FRESH_MS = 10_000;
/** No single timer longer than this: a throttled or suspended timer is re-checked against the clock. */
export const MAX_SLEEP_MS = 60_000;
/** A /token call that hasn't answered by now counts as a network failure (else one hung call blocks all). */
export const TOKEN_TIMEOUT_MS = 30_000;

export type UnauthorizedResult = "retry" | "give_up";

export class TokenScheduler {
  private token: Token | null = null;
  private phase: RefreshPhase = "off";
  private nextAt: number | null = null;
  private failures = 0;
  private lastError: LoginErrorCode | undefined;
  private last: RefreshStatus["lastRefresh"];
  private count = 0;
  private reauth = false;
  private rejected = false;
  private inFlight: Promise<boolean> | null = null;
  private timer: unknown = null;
  /** Bumped by start() / stop(): a /token answer for an older generation is dropped. */
  private gen = 0;

  constructor(private deps: SchedulerDeps) {}

  /**
   * A login is in memory: its first token (from the login / restore / unlock), or null with the reason that
   * first /token call failed (then retry with backoff). Resets everything.
   */
  start(token: Token | null, error: LoginErrorCode = "network") {
    this.gen++;
    this.inFlight = null;
    this.failures = 0;
    this.lastError = undefined;
    this.last = undefined;
    this.count = 0;
    this.reauth = false;
    this.rejected = false;
    this.token = token;
    if (token) return this.schedule(this.refreshTime(token), "scheduled");
    this.last = { at: this.deps.now(), ok: false, error };
    this.fail(error);
  }

  /** Disconnect: forget the token, cancel everything. Silent. */
  stop() {
    this.gen++;
    this.inFlight = null;
    this.token = null;
    this.phase = "off";
    this.nextAt = null;
    this.reauth = false;
    this.rejected = false;
    this.clearTimer();
    // No onChange: the caller (disconnect) reports its own new state.
  }

  /** A login is in memory (even one that needs re-entering). */
  get running() {
    return this.phase !== "off";
  }

  /** The token to send, or null if there is none still valid (or OpenF1 just refused it). */
  current(): string | null {
    const t = this.token;
    return t && !this.rejected && this.deps.now() < t.expiresAt ? t.accessToken : null;
  }

  /** Whether a token is in hand (valid or not). */
  hasToken() {
    return this.token !== null;
  }

  /** The token in hand, valid or not: the live stream tells an expired token from the connection cap by its expiry. */
  held(): Token | null {
    return this.token;
  }

  status(): RefreshStatus {
    return {
      ...(this.token && { tokenExpiresAt: this.token.expiresAt }),
      ...(this.nextAt !== null && { nextRefreshAt: this.nextAt }),
      ...(this.last && { lastRefresh: this.last }),
      refreshCount: this.count,
      needsReauth: this.reauth,
      refresh: this.phase,
    };
  }

  /** Refresh now (coalesced with one already running). Resolves true if a new token is in place. */
  refresh(): Promise<boolean> {
    if (this.phase === "off" || this.phase === "stopped") return Promise.resolve(false);
    if (this.inFlight) return this.inFlight;
    const gen = this.gen;
    this.clearTimer();
    this.phase = "refreshing";
    this.deps.onChange();
    let timeout: unknown;
    const timedOut = new Promise<TokenResult>((resolve) => {
      timeout = this.deps.setTimeout(() => resolve({ ok: false, error: { code: "network", message: "timed out" } }), TOKEN_TIMEOUT_MS);
    });
    const p = Promise.race([this.deps.fetchToken(), timedOut]).then((r) => {
      this.deps.clearTimeout(timeout);
      if (gen !== this.gen) return false;
      this.inFlight = null;
      const at = this.deps.now();
      if (r.ok) {
        this.token = r.token;
        this.failures = 0;
        this.lastError = undefined;
        this.rejected = false;
        this.reauth = false;
        this.count++;
        this.last = { at, ok: true };
        this.schedule(this.refreshTime(r.token), "scheduled");
        return true;
      }
      this.last = { at, ok: false, error: r.error.code };
      if (r.error.code === "wrong_credentials") {
        // Password changed or revoked: asking again won't help. The current token works until its exp.
        this.reauth = true;
        this.phase = "stopped";
        this.nextAt = null;
        this.armExpiry();
        this.deps.onChange();
        return false;
      }
      this.fail(r.error.code);
      return false;
    });
    this.inFlight = p;
    return p;
  }

  /**
   * OpenF1 answered 401 to a request made with `used`. "retry": a different, valid token is now in place.
   * "give_up": don't retry (no login, the refresh failed, or the token was brand new and still refused).
   */
  async onUnauthorized(used: string): Promise<UnauthorizedResult> {
    if (this.phase === "off" || this.phase === "stopped" || !this.token) return "give_up";
    if (this.token.accessToken !== used) return this.current() ? "retry" : "give_up";
    if (this.inFlight) return (await this.inFlight) && this.current() ? "retry" : "give_up";
    // Already backing off (e.g. /token is rate limiting us): a 401 is no reason to skip the backoff.
    if (this.phase === "retrying" || this.phase === "expired") return "give_up";
    if (this.deps.now() - this.token.issuedAt < FRESH_MS) {
      // A token OpenF1 just gave us, refused anyway: another one won't be different. Stop using it and try
      // again at the cap, not on every 401.
      this.rejected = true;
      this.last = { at: this.deps.now(), ok: false, error: "rejected" };
      this.schedule(this.deps.now() + this.jitter(BACKOFF_CAP_MS), "retrying");
      return "give_up";
    }
    return (await this.refresh()) && this.current() ? "retry" : "give_up";
  }

  /**
   * The tab became visible again, or the network came back: re-check the wall clock (a timer may have
   * been throttled or suspended for far longer than it asked for). `online` also retries a network failure
   * at once: the backoff was for a network that wasn't there.
   */
  wake(reason: "visible" | "online") {
    if (this.phase === "off" || this.phase === "refreshing") return;
    if (this.phase === "stopped") return void (this.token && this.deps.now() >= this.token.expiresAt ? this.deps.onChange() : this.armExpiry());
    if (reason === "online" && this.lastError === "network") return void this.refresh();
    this.tick();
  }

  // ---------------------------------------------------------------- internals

  private refreshTime(t: Token) {
    return t.issuedAt + (t.expiresAt - t.issuedAt) * REFRESH_AT;
  }

  private jitter(ms: number) {
    return Math.round(ms * (1 - JITTER + 2 * JITTER * this.deps.random()));
  }

  /** The delay before retry number `failures` (1-based). */
  private backoff(code: LoginErrorCode) {
    if (this.expiredNow()) return this.jitter(BACKOFF_CAP_MS);
    const base = code === "rate_limited" ? BACKOFF_429_MS : BACKOFF_BASE_MS;
    return this.jitter(Math.min(BACKOFF_CAP_MS, base * 2 ** (this.failures - 1)));
  }

  private fail(code: LoginErrorCode) {
    this.failures++;
    this.lastError = code;
    this.schedule(this.deps.now() + this.backoff(code), "retrying");
  }

  private expiredNow() {
    return !!this.token && this.deps.now() >= this.token.expiresAt;
  }

  private schedule(at: number, phase: "scheduled" | "retrying") {
    this.nextAt = at;
    this.phase = phase === "retrying" && this.expiredNow() ? "expired" : phase;
    this.arm();
    this.deps.onChange();
  }

  private clearTimer() {
    if (this.timer !== null) this.deps.clearTimeout(this.timer);
    this.timer = null;
  }

  /** One timer for the next thing that matters: the refresh, or the token expiring (a status change). */
  private arm() {
    this.clearTimer();
    if (this.nextAt === null) return;
    const now = this.deps.now();
    let wakeAt = this.nextAt;
    if (this.token && this.phase === "retrying" && this.token.expiresAt > now) wakeAt = Math.min(wakeAt, this.token.expiresAt);
    this.timer = this.deps.setTimeout(() => this.tick(), Math.max(0, Math.min(wakeAt - now, MAX_SLEEP_MS)));
  }

  /** After a 401 from /token: nothing scheduled, but say "expired" when the token runs out. */
  private armExpiry() {
    this.clearTimer();
    const t = this.token;
    if (!t) return;
    const left = t.expiresAt - this.deps.now();
    if (left <= 0) return;
    this.timer = this.deps.setTimeout(() => {
      this.timer = null;
      if (this.deps.now() >= t.expiresAt) this.deps.onChange();
      else this.armExpiry();
    }, Math.min(left, MAX_SLEEP_MS));
  }

  private tick() {
    // (Also called from wake(): drop the pending timer, arm() sets the next one.)
    this.clearTimer();
    if (this.phase === "off" || this.phase === "stopped" || this.phase === "refreshing" || this.nextAt === null) return;
    const now = this.deps.now();
    if (now >= this.nextAt) return void this.refresh();
    if (this.phase === "retrying" && this.expiredNow()) {
      this.phase = "expired";
      this.deps.onChange();
    }
    this.arm();
  }
}
