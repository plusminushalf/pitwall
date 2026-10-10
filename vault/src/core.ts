// The vault's state: the stored login, the in-memory secret and token, and the popup it's waiting for.
// No DOM: frame.ts wires it to IndexedDB, fetch, window messages and the port. Tested under bun.
//
// Only this module (and the TokenScheduler it owns) ever holds the decrypted password or the token, and only
// in memory. `status()` exposes the state, the storage mode, the masked account and the refresh status
// (expiry, next refresh, last result): never the token or password.
//
// Across tabs (tabs.ts): only the leader frame runs the scheduler. A login that completes in any frame is
// handed to the others as a `Shared` (memory only, vault frames only, never the app), so a follower that
// becomes leader carries on without a passkey tap or an immediate /token.

import { loginError, requestToken, type Fetch, type Token, type TokenResult } from "./openf1";
import { maskEmail, type FrameToPopup, type LoginError, type PopupMessage, type PopupResult, type StorageMode, type Ticket, type VaultState, type VaultStatus } from "./protocol";
import { TokenScheduler } from "./scheduler";
import { openLogin, randomBytes, sealDevice, sealPasskey, type LoginStore, type Secret, type StoredLogin } from "./storage";

/** How long the frame waits for the popup after `connect` / `unlock`. A popup older than this is stale. */
export const PENDING_MS = 10 * 60_000;

/** What the vault frames of one browser share among themselves (BroadcastChannel; memory only; never the app). */
export type Shared = { secret: Secret; token: Token; mode: StorageMode; account: string };

export type CoreDeps = {
  store: LoginStore;
  fetch: Fetch;
  now: () => number;
  version: string;
  /** Called on every status change (pushed to the app as an event). */
  onStatus: (s: VaultStatus) => void;
  /** Tell the vault frames in other tabs (same partition) that the login was wiped. */
  announceWipe?: () => void;
  /** Timers and jitter for the refresh schedule (default: the globals). */
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
  random?: () => number;
  /** Dev vault only (debug.ts): rewrite every new token, e.g. to fake a short lifetime. */
  tokenFilter?: (t: Token) => Token;
  /** Whether this frame leads (tabs.ts). Only the leader refreshes; a follower just holds the token. Default: yes. */
  leading?: () => boolean;
  /** A login is in memory with a new token (login, unlock, restore, refresh, adoptShared): for the other frames. */
  onShared?: (s: Shared) => void;
  /** Leader: the token changed (the live stream hands over to a session using it). */
  onToken?: (t: Token) => void;
};

type Pending = {
  kind: "connect" | "unlock";
  ticket: Ticket;
  expiresAt: number;
  /** PRF input for a new passkey (connect); for unlock the stored one is used. */
  prfSalt: ArrayBuffer;
  /** The popup window that said hello first: only it may continue. */
  source: unknown;
  busy: boolean;
  /** Connect in passkey mode: the login OpenF1 accepted, waiting for the passkey's PRF output. */
  verified?: { secret: Secret; token: Token };
};

export type ExpectResult = { ok: true; status: VaultStatus } | { ok: false; code: "unavailable" | "busy" | "not_connected"; message: string };

const wipe = (buf: ArrayBuffer) => new Uint8Array(buf).fill(0);

export class VaultCore {
  private state: VaultState = "connecting";
  private mode: StorageMode | undefined;
  private account: string | undefined;
  private error: LoginError | undefined;
  private secret: Secret | null = null;
  private pending: Pending | null = null;
  /** Holds the token and refreshes it. Running whenever a login is in memory. */
  readonly scheduler: TokenScheduler;
  /** Set while core itself starts the scheduler: core reports its own state change right after. */
  private quiet = false;
  /** A follower's token (it doesn't run the scheduler). */
  private heldToken: Token | null = null;
  /** The token last handed to onShared. */
  private lastShared: Token | null = null;

  constructor(private deps: CoreDeps) {
    this.scheduler = new TokenScheduler({
      now: deps.now,
      setTimeout: deps.setTimeout ?? ((fn, ms) => setTimeout(fn, ms)),
      clearTimeout: deps.clearTimeout ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>)),
      random: deps.random ?? Math.random,
      fetchToken: () => {
        const s = this.secret;
        return s ? this.requestToken(s.username, s.password) : Promise.resolve({ ok: false, error: loginError("storage") });
      },
      onChange: () => this.onRefresh(),
    });
  }

  private async requestToken(username: string, password: string): Promise<TokenResult> {
    const t = await requestToken(this.deps.fetch, username, password, this.deps.now);
    return t.ok && this.deps.tokenFilter ? { ok: true, token: this.deps.tokenFilter(t.token) } : t;
  }

  /** The scheduler changed something: push the status, and move the state if the token situation changed. */
  private onRefresh() {
    if (this.quiet) return;
    const sch = this.scheduler;
    // A restore that failed (offline at load) and then succeeded on a retry.
    if (this.state === "error" && this.error?.code !== "wrong_credentials" && sch.current()) return this.set("connected");
    // Password changed or revoked, and the last token has now run out: the stored login is no good.
    if (this.state === "connected" && sch.status().needsReauth && !sch.current()) return this.set("error", { error: loginError("wrong_credentials") });
    this.deps.onStatus(this.status());
    this.share();
  }

  private leads() {
    return this.deps.leading?.() ?? true;
  }

  /** The token in hand: the scheduler's (leader) or the one the leader shared (follower). */
  token(): Token | null {
    return this.leads() ? this.scheduler.held() : this.heldToken;
  }

  /** The token with the account's email (the MQTT username), or null. */
  liveToken(): { accessToken: string; expiresAt: number; username: string } | null {
    const t = this.token();
    return t && this.secret ? { accessToken: t.accessToken, expiresAt: t.expiresAt, username: this.secret.username } : null;
  }

  /** The login in memory, to hand to another vault frame (tabs.ts), or null. */
  sharedLogin(): Shared | null {
    const token = this.token();
    return this.secret && token && this.mode && this.account ? { secret: this.secret, token, mode: this.mode, account: this.account } : null;
  }

  /** Tell the other frames (and, on the leader, the live stream) about a new token. */
  private share() {
    const s = this.sharedLogin();
    if (!s || s.token === this.lastShared) return;
    this.lastShared = s.token;
    this.deps.onShared?.(s);
    if (this.leads()) this.deps.onToken?.(s.token);
  }

  /**
   * Another frame's login (a popup login or unlock in another tab, or the old leader's, on takeover):
   * use it as is, no /token. A leader starts refreshing it (at once if it's due).
   */
  adoptShared(s: Shared) {
    this.secret = s.secret;
    this.adopt(s.token);
    this.set("connected", { mode: s.mode, account: s.account });
    this.share();
  }

  /**
   * This frame stopped leading (another frame stole the lock): keep the token as a follower does, stop
   * refreshing. Silent. The login stays in memory for a later takeover.
   */
  demote() {
    this.heldToken = this.scheduler.held();
    this.scheduler.stop();
  }

  /** Follower: mirror the leader's account state (for expect()'s checks). Silent. */
  mirror(s: Pick<VaultStatus, "state" | "mode" | "account" | "error">) {
    this.state = s.state;
    this.mode = s.mode;
    this.account = s.account;
    this.error = s.error;
  }

  /** A login's first token (or the reason there's none yet): hand it to the scheduler (leader only). */
  private adopt(token: Token | null, error?: LoginError["code"]) {
    if (!this.leads()) {
      this.heldToken = token;
      return;
    }
    this.quiet = true;
    try {
      this.scheduler.start(token, error);
    } finally {
      this.quiet = false;
    }
  }

  status(): VaultStatus {
    return {
      state: this.state,
      ...(this.mode && { mode: this.mode }),
      ...(this.account && { account: this.account }),
      ...(this.scheduler.running && this.scheduler.status()),
      ...(this.state === "error" && this.error && { error: this.error }),
      live: "off",
      version: this.deps.version,
    };
  }

  private set(state: VaultState, patch: { mode?: StorageMode; account?: string; error?: LoginError } = {}) {
    this.state = state;
    if ("mode" in patch) this.mode = patch.mode;
    if ("account" in patch) this.account = patch.account;
    this.error = patch.error;
    this.deps.onStatus(this.status());
  }

  private forget() {
    this.secret = null;
    this.heldToken = null;
    this.lastShared = null;
    this.scheduler.stop();
  }

  /** On load: restore a stay-connected login silently, or report "locked" / "disconnected". */
  async init(): Promise<void> {
    let stored: StoredLogin | null;
    try {
      stored = await this.deps.store.load();
    } catch {
      return this.set("unavailable", { mode: undefined, account: undefined });
    }
    if (!stored) return this.set("disconnected", { mode: undefined, account: undefined });
    if (stored.mode === "passkey") return this.set("locked", { mode: "passkey", account: stored.account });
    this.set("connecting", { mode: "device", account: stored.account });
    let secret: Secret;
    try {
      secret = await openLogin(stored);
    } catch {
      return this.set("error", { error: loginError("storage") });
    }
    // The secret stays in memory even if this first token fails: the scheduler retries with it (except
    // after a 401: the password was changed, only the user can fix that).
    this.secret = secret;
    const t = await this.requestToken(secret.username, secret.password);
    if (!t.ok) {
      if (t.error.code !== "wrong_credentials") this.adopt(null, t.error.code);
      return this.set("error", { error: t.error });
    }
    this.adopt(t.token);
    this.set("connected");
    this.share();
  }

  /** `connect` / `unlock` from the app: it has just opened the popup with this ticket. */
  expect(kind: "connect" | "unlock", ticket: Ticket): ExpectResult {
    if (this.state === "unavailable") return { ok: false, code: "unavailable", message: "the vault can't store a login in this browser" };
    if (this.pending?.busy) return { ok: false, code: "busy", message: "a login is being checked" };
    if (kind === "unlock" && this.state !== "locked") return { ok: false, code: "not_connected", message: "nothing to unlock" };
    this.dropPending();
    this.pending = { kind, ticket, expiresAt: this.deps.now() + PENDING_MS, prfSalt: randomBytes(32), source: null, busy: false };
    return { ok: true, status: this.status() };
  }

  /** The app saw the popup close. A half-finished passkey setup is dropped. */
  cancel(ticket: Ticket): VaultStatus {
    if (this.pending?.ticket === ticket && !this.pending.busy) this.dropPending();
    return this.status();
  }

  private dropPending() {
    const p = this.pending;
    this.pending = null;
    // A passkey setup that never finished: the verified login was never stored. Back to where we were.
    if (p?.verified) this.restoreAfterAbandon();
  }

  /** After an abandoned passkey setup: re-read what's stored so the state matches it. */
  private restoreAfterAbandon() {
    if (this.token() && this.secret) this.set("connected");
    // A follower mirrors the leader's state; only a leader re-reads storage (and may call /token).
    else if (this.leads()) void this.init();
  }

  async disconnect(): Promise<VaultStatus> {
    this.pending = null;
    this.forget();
    try {
      await this.deps.store.clear();
    } catch {
      // Memory is wiped either way; a store that can't clear couldn't load either.
    }
    this.set("disconnected", { mode: undefined, account: undefined });
    this.deps.announceWipe?.();
    return this.status();
  }

  /** Another tab's frame disconnected (same storage partition): drop what's in memory too. */
  wipedElsewhere() {
    this.pending = null;
    this.forget();
    this.set("disconnected", { mode: undefined, account: undefined });
  }

  /**
   * One validated popup message (the frame has already checked event.origin). The answer goes back to
   * `source`; null means "not for this frame" (no pending ticket, another ticket, another popup window).
   */
  async popup(msg: PopupMessage, source: unknown): Promise<FrameToPopup | null> {
    const p = this.pending;
    if (!p || p.ticket !== msg.ticket) return null;
    const result = (r: { ok: true; next: "done" | "passkey" } | { ok: false; error: LoginError }): PopupResult => ({ v: 1, type: "popup:result", ticket: p.ticket, ...r });
    if (this.deps.now() > p.expiresAt) {
      if (!p.busy) this.dropPending();
      return result({ ok: false, error: loginError("expired") });
    }
    if (msg.type === "popup:hello") {
      if (p.source !== null && p.source !== source) return null;
      p.source = source;
      if (p.kind === "connect") return { v: 1, type: "popup:welcome", ticket: p.ticket, kind: "connect", prfSalt: p.prfSalt };
      const stored = await this.load();
      if (stored?.mode !== "passkey") return result({ ok: false, error: loginError("storage") });
      return { v: 1, type: "popup:welcome", ticket: p.ticket, kind: "unlock", prfSalt: stored.prfSalt, credentialId: stored.credentialId, account: stored.account };
    }
    if (p.source !== source || p.busy) return null;
    p.busy = true;
    try {
      switch (msg.type) {
        case "popup:login":
          if (p.kind !== "connect" || p.verified) return null;
          return result(await this.login(p, msg.username, msg.password, msg.mode));
        case "popup:passkey":
          if (!p.verified) return null;
          try {
            return result(await this.store(p, (s, a) => sealPasskey(s, a, msg.prf, msg.credentialId, p.prfSalt), "passkey"));
          } finally {
            wipe(msg.prf);
          }
        case "popup:device":
          if (!p.verified) return null;
          return result(await this.store(p, sealDevice, "device"));
        case "popup:unlock":
          if (p.kind !== "unlock") return null;
          try {
            return result(await this.unlock(msg.prf));
          } finally {
            wipe(msg.prf);
          }
      }
    } finally {
      p.busy = false;
    }
  }

  private async load(): Promise<StoredLogin | null> {
    try {
      return await this.deps.store.load();
    } catch {
      return null;
    }
  }

  /** Check the login with OpenF1. Device mode stores it at once; passkey mode waits for the PRF output. */
  private async login(p: Pending, username: string, password: string, mode: StorageMode) {
    const before = { state: this.state, error: this.error };
    this.set("connecting", { error: undefined });
    const t = await this.requestToken(username, password);
    if (!t.ok) {
      this.set(before.state, { error: before.error });
      return { ok: false as const, error: t.error };
    }
    p.verified = { secret: { kind: "password", username, password }, token: t.token };
    if (mode === "passkey") return { ok: true as const, next: "passkey" as const };
    return this.store(p, sealDevice, "device");
  }

  private async store(p: Pending, sealer: (s: Secret, account: string) => Promise<StoredLogin>, mode: StorageMode) {
    const v = p.verified!;
    const account = maskEmail(v.secret.username);
    try {
      await this.deps.store.save(await sealer(v.secret, account));
    } catch {
      return { ok: false as const, error: loginError("storage") };
    }
    this.pending = null;
    this.secret = v.secret;
    this.adopt(v.token);
    this.set("connected", { mode, account });
    this.share();
    return { ok: true as const, next: "done" as const };
  }

  private async unlock(prf: ArrayBuffer) {
    const stored = await this.load();
    if (stored?.mode !== "passkey") return { ok: false as const, error: loginError("storage") };
    let secret: Secret;
    try {
      secret = await openLogin(stored, prf);
    } catch {
      return { ok: false as const, error: loginError("passkey") };
    }
    this.set("connecting");
    const t = await this.requestToken(secret.username, secret.password);
    if (!t.ok) {
      // A wrong password means it was changed on OpenF1: say so. Anything else: still locked, try again.
      if (t.error.code === "wrong_credentials") this.set("error", { error: t.error });
      else this.set("locked");
      return { ok: false as const, error: t.error };
    }
    this.pending = null;
    this.secret = secret;
    this.adopt(t.token);
    this.set("connected", { mode: "passkey", account: stored.account });
    this.share();
    return { ok: true as const, next: "done" as const };
  }
}
