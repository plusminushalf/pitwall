// The download worker's line to the credential vault (vault/, another site): a MessagePort the page got from
// the vault (`openPort`) and transferred to the worker, so requests go worker <-> vault with no main-thread
// relay. The vault holds the login and the token and answers with data only: the protocol has no message that
// carries a token, so none can reach this worker.
//
// Which way a download goes (choosePath): through the vault when it reports an authenticated account (signed in,
// with a token that hasn't run out): OpenF1's sponsor limits, spent in parallel within the vault's one budget
// per browser. Otherwise (no login, the vault unavailable or locked) straight to OpenF1 with the free tier's
// pacing (scripts/lib/openf1Http.ts), as before. If the vault stops answering mid-download (its frame crashed
// or went away) or loses its token, the rest of the download goes direct, requests in flight included: no
// user-visible failure. Pure apart from the port and the timers, tested in vaultPort.test.ts.

import type { GetResult, Method, Methods, Params, RestEndpoint, VaultStatus } from "../../vault/src/protocol";

export type Path = "vault" | "direct";

/** Through the vault only with an authenticated account; `reason` says why not. */
export function choosePath(status: VaultStatus | null, now = Date.now()): { path: Path; reason: string } {
  if (!status) return { path: "direct", reason: "no vault" };
  if (status.state !== "connected") return { path: "direct", reason: `vault ${status.state}` };
  if (status.refresh === "expired" || (status.tokenExpiresAt !== undefined && status.tokenExpiresAt <= now)) return { path: "direct", reason: "token expired" };
  return { path: "vault", reason: "signed in" };
}

/** The vault stopped answering, or can't serve this (then the request goes direct). */
export class VaultUnavailable extends Error {
  override name = "VaultUnavailable";
}

/** The vault answered with an error code (protocol ErrorCode). */
export class VaultCallError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export type PortTimers = {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(h: unknown): void;
};

/** While requests are pending, the vault is pinged (`status`) this often; unanswered for PING_TIMEOUT_MS, it's down. */
export const PING_MS = 2_000;
export const PING_TIMEOUT_MS = 5_000;
/** The first `status` (which way to go) may take this long: the vault frame may still be loading. */
export const FIRST_STATUS_MS = 8_000;

export type PortLike = {
  postMessage(m: unknown): void;
  onmessage: ((e: { data: unknown }) => void) | null;
  close?(): void;
};

type Pending = { resolve: (r: unknown) => void; reject: (e: Error) => void; timer: unknown; ping: boolean };

/** The vault protocol over one port (requests, responses by id; events ignored), with a liveness check. */
export class VaultPort {
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private down: Error | null = null;
  private pinger: unknown = null;
  private pinging = false;

  constructor(
    private port: PortLike,
    private timers: PortTimers = { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) },
  ) {
    port.onmessage = (e) => this.onMessage(e.data);
  }

  /** Whether the vault has stopped answering (then every call rejects with VaultUnavailable). */
  get isDown() {
    return this.down !== null;
  }

  /** The page couldn't get a port from the vault after all: everything goes direct. */
  markDown(why: string) {
    this.fail(new VaultUnavailable(why));
  }

  call<M extends Method>(type: M, args: Methods[M]["args"], opts: { timeoutMs?: number; ping?: boolean } = {}): Promise<Methods[M]["result"]> {
    if (this.down) return Promise.reject(this.down);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = opts.timeoutMs ? this.timers.setTimeout(() => this.fail(new VaultUnavailable(`the vault didn't answer ${type}`)), opts.timeoutMs) : null;
      this.pending.set(id, { resolve: resolve as (r: unknown) => void, reject, timer, ping: opts.ping === true });
      try {
        this.port.postMessage({ v: 1, id, type, ...args });
      } catch {
        this.fail(new VaultUnavailable("the vault's port is closed"));
      }
      this.watch();
    });
  }

  /** The vault's status (which way to go), or null if it doesn't answer in time. */
  status(timeoutMs = FIRST_STATUS_MS): Promise<VaultStatus | null> {
    return this.call("status", {}, { timeoutMs }).catch(() => null);
  }

  get(endpoint: RestEndpoint, params: Params): Promise<GetResult> {
    return this.call("get", { endpoint, params });
  }

  /** Done: tell the vault (its queued gets for this port are dropped), stop pinging. Best effort. */
  close() {
    if (!this.down) {
      try {
        this.port.postMessage({ v: 1, id: this.nextId++, type: "close" });
      } catch {}
    }
    this.fail(new VaultUnavailable("closed"));
    try {
      this.port.close?.();
    } catch {}
  }

  private onMessage(data: unknown) {
    const res = data as { v?: number; id?: number; ok?: boolean; result?: unknown; error?: { code: string; message: string }; type?: string };
    if (!res || typeof res !== "object" || res.type === "event" || typeof res.id !== "number") return;
    const p = this.pending.get(res.id);
    if (!p) return;
    this.pending.delete(res.id);
    if (p.timer !== null) this.timers.clearTimeout(p.timer);
    if (res.ok) p.resolve(res.result);
    else p.reject(new VaultCallError(res.error?.code ?? "internal", res.error?.message ?? "vault error"));
  }

  /** Ping while something is pending: a vault that stops answering fails everything (-> direct). */
  private watch() {
    if (this.pinger !== null || this.down) return;
    this.pinger = this.timers.setTimeout(() => {
      this.pinger = null;
      if (this.down || ![...this.pending.values()].some((p) => !p.ping)) return;
      if (!this.pinging) {
        this.pinging = true;
        void this.call("status", {}, { timeoutMs: PING_TIMEOUT_MS, ping: true })
          .catch(() => {})
          .finally(() => (this.pinging = false));
      }
      this.watch();
    }, PING_MS);
  }

  private fail(e: Error) {
    if (this.down) return;
    this.down = e;
    if (this.pinger !== null) this.timers.clearTimeout(this.pinger);
    this.pinger = null;
    const all = [...this.pending.values()];
    this.pending.clear();
    for (const p of all) {
      if (p.timer !== null) this.timers.clearTimeout(p.timer);
      p.reject(e);
    }
  }
}

// ---------------------------------------------------------------- the ingest fetcher

export type FetchEndpoint = <T>(endpoint: string, params: Record<string, string | number>) => Promise<T[]>;

export type VaultFetchDeps = {
  vault: VaultPort;
  /** The direct path (scripts/lib/openf1Http.ts fetchEndpoint): the fallback. */
  direct: FetchEndpoint;
  /** The path changed (vault -> direct), and why. */
  onPath(path: Path, reason: string): void;
  /** Every vault request's status (the job's request / 429 counters). */
  onRequest?(status: number): void;
  /** A request will be retried after `waitMs` (a 429 the vault gave back, a 5xx). */
  onRetry?(e: { endpoint: string; status: number; waitMs: number }): void;
  sleep?(ms: number): Promise<void>;
};

const MAX_RETRIES = 5;
/** The endpoints the vault's `get` allows (the protocol's REST_ENDPOINTS: what ingest uses). */
const VAULT_ENDPOINTS: ReadonlySet<string> = new Set(["car_data", "drivers", "intervals", "laps", "location", "meetings", "overtakes", "pit", "position", "race_control", "session_result", "sessions", "stints", "team_radio", "weather"]);

/** Not something the vault can do for us (lost its token, not an endpoint it serves): go direct. */
class GoDirect extends Error {}

/**
 * fetchEndpoint through the vault while it's there and signed in, else (from the first failure on, for good)
 * the direct one. OpenF1's answers are handled like the direct client handles them: 404 is "no rows", 429 and
 * 5xx are retried with backoff (the vault has already retried its own 429s after pausing its budget).
 */
export function vaultFetchEndpoint(deps: VaultFetchDeps): FetchEndpoint {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const dec = new TextDecoder();
  let direct: string | null = deps.vault.isDown ? "vault unavailable" : null;
  const goDirect = (reason: string) => {
    if (direct !== null) return;
    direct = reason;
    deps.onPath("direct", reason);
  };

  async function viaVault<T>(endpoint: string, params: Record<string, string | number>): Promise<T[]> {
    for (let attempt = 0; ; attempt++) {
      let res: GetResult;
      try {
        res = await deps.vault.get(endpoint as RestEndpoint, params);
      } catch (e) {
        if (e instanceof VaultCallError && e.code === "network") throw new TypeError(`couldn't reach OpenF1 (${endpoint})`);
        if (e instanceof VaultCallError && e.code === "rate_limited" && attempt < MAX_RETRIES) {
          await sleep(1_000 * 2 ** attempt);
          continue;
        }
        throw new GoDirect(e instanceof VaultUnavailable ? e.message : `the vault said ${e instanceof VaultCallError ? e.code : "no"}`);
      }
      deps.onRequest?.(res.status);
      // Signed out, locked or the token ran out meanwhile: the free tier is the direct path's job.
      if (!res.auth) throw new GoDirect("the vault has no token now");
      if (res.status === 200) return JSON.parse(dec.decode(res.body)) as T[];
      // OpenF1 answers 404 {"detail":"No results found."} for empty queries.
      if (res.status === 404) return [];
      // An authenticated 401/403 that the vault's refresh-and-retry didn't fix: the login is no good now.
      if (res.status === 401 || res.status === 403) throw new GoDirect(`OpenF1 ${res.status} with the token`);
      const retryable = res.status === 429 || res.status >= 500;
      const text = dec.decode(res.body).slice(0, 300);
      if (!retryable || attempt >= MAX_RETRIES) throw new Error(`OpenF1 ${res.status} for ${endpoint}: ${text}`);
      const waitMs = 5_000 * 2 ** attempt;
      deps.onRetry?.({ endpoint, status: res.status, waitMs });
      await sleep(waitMs);
    }
  }

  return async <T,>(endpoint: string, params: Record<string, string | number>): Promise<T[]> => {
    // (Every endpoint ingest reads is one the vault serves; anything else just goes direct.)
    if (direct === null && VAULT_ENDPOINTS.has(endpoint)) {
      try {
        return await viaVault<T>(endpoint, params);
      } catch (e) {
        if (!(e instanceof GoDirect)) throw e;
        goDirect(e.message);
      }
    }
    return deps.direct<T>(endpoint, params);
  };
}
