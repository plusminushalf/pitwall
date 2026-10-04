// Live mode without a relay: the relay's own processing (./openf1.ts, ./hub.ts, ./store.ts) run in the browser, fed
// by the credential vault (vault/: OpenF1's live stream and REST with the user's own account). It runs in a worker
// (./worker.ts), so normalizing a whole race whenever timing changes never stalls the page; the page relays between it and the
// vault (./vault.ts), so this side never talks to the vault itself. Out come the relay's LiveMessages.
//
// The vault already reconnects, gap-fills and dedupes its stream. What's added here is what the relay adds on top of
// its MQTT connection: finding the session, the REST backfill when it starts, and turning records into the replay
// format. Pure apart from the injected post() and timers: tested in vaultEngine.test.ts.

import { AuthError, fetchCircuit } from "../../scripts/lib/openf1Http";
import type { RawCircuit } from "../../scripts/lib/openf1Types";
import { LiveHub } from "./hub";
import { OpenF1Live, type Endpoint, type FeedHooks, type LiveFeed, type Params } from "./openf1";
import type { LiveMessage } from "./protocol";
import type { LiveStore, Rec } from "./store";
import { TOPICS, type Topic } from "./topics";

/** The page -> the engine. */
export type ToEngine =
  /** Start following. `sim`: the vault's simulate mode (dev): its session clock. */
  | { type: "start"; sim: { anchorWall: number; speed: number } | null }
  /** A batch of the vault's live data (vault `data` event). */
  | { type: "data"; topic: string; messages: Rec[] }
  /** The answer to a `get`. */
  | { type: "got"; id: number; status: number; auth: boolean; body: ArrayBuffer }
  | { type: "failed"; id: number; code: string; message: string }
  /** Whether the vault is streaming this tab's topics now. */
  | { type: "stream"; streaming: boolean }
  /** The vault's frame was replaced: this tab may have missed some of the stream. */
  | { type: "refill" };

/** The engine -> the page. */
export type FromEngine =
  /** For the app, as the relay would send it. */
  | { type: "live"; msg: LiveMessage }
  /** An OpenF1 REST read through the vault (its `get`). */
  | { type: "get"; id: number; endpoint: Endpoint; params: Params }
  /** Subscribe this tab to TOPICS in the vault (a session is on), or not any more. */
  | { type: "subscribe" }
  | { type: "unsubscribe" };

/** Requests in flight through the page at once (the rest wait here, not in the vault's queue). */
export const MAX_IN_FLIGHT = 4;
/** Tries per REST read when the vault or OpenF1 fails in a way worth retrying. */
export const REST_TRIES = 4;
/** How long the start of a session waits for the vault's stream before backfilling anyway (then it refills). */
export const STREAM_WAIT_MS = 20_000;
/** Vault errors worth a retry (the rest are bugs: bad_request, internal). */
const RETRY_CODES = new Set(["timeout", "unavailable", "network", "rate_limited"]);

export class VaultGetError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface EngineDeps {
  post(m: FromEngine, transfer?: Transferable[]): void;
  circuit?: (url: string) => Promise<RawCircuit>;
  log?: (line: string) => void;
  warn?: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
}

type Got = { status: number; auth: boolean; body: ArrayBuffer };

const dec = new TextDecoder();
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export class VaultEngine {
  private hub: LiveHub | null = null;
  private live: OpenF1Live | null = null;
  private feed: VaultFeed | null = null;
  private streaming = false;
  private waiting = new Set<() => void>();
  private pending = new Map<number, { resolve: (g: Got) => void; reject: (e: Error) => void }>();
  private nextId = 1;
  private inFlight = 0;
  private queue: (() => void)[] = [];
  now: () => number = Date.now;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private deps: EngineDeps) {
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  handle(m: ToEngine): void {
    switch (m.type) {
      case "start":
        return this.start(m.sim);
      case "data":
        if ((TOPICS as readonly string[]).includes(m.topic)) this.feed?.deliver(m.topic as Topic, m.messages);
        return;
      case "got":
      case "failed": {
        const p = this.pending.get(m.id);
        if (!p) return;
        this.pending.delete(m.id);
        if (m.type === "got") p.resolve({ status: m.status, auth: m.auth, body: m.body });
        else p.reject(new VaultGetError(m.code, m.message));
        return;
      }
      case "stream":
        this.streaming = m.streaming;
        if (m.streaming) for (const wake of [...this.waiting]) wake();
        this.feed?.streamingChanged(m.streaming);
        return;
      case "refill": {
        const store = this.live?.store;
        if (store) void this.live!.refill(store.latestDataTime);
        return;
      }
    }
  }

  private start(sim: { anchorWall: number; speed: number } | null): void {
    if (this.hub) return;
    if (sim) this.now = () => sim.anchorWall + (Date.now() - sim.anchorWall) * sim.speed;
    const hub = new LiveHub(sim ? "simulate" : "openf1", { clients: () => 1, broadcast: (msg) => (this.deps.post({ type: "live", msg }), 0) }, this.deps.log);
    hub.status = { ...hub.status, state: "connecting", detail: "looking for a live session" };
    this.hub = hub;
    for (const msg of hub.welcome()) this.deps.post({ type: "live", msg });
    this.live = new OpenF1Live(hub, {
      rest: (endpoint, params) => this.rest(endpoint, params),
      circuit: this.deps.circuit ?? fetchCircuit,
      feed: (store, hooks) => (this.feed = new VaultFeed(this, store, hooks)),
      now: this.now,
      log: this.deps.log,
      warn: this.deps.warn,
    });
    this.live.start();
  }

  /** Stop polling and ticking (tests; the page just terminates the worker). */
  stop(): void {
    this.hub?.stop();
    void this.live?.shutdown();
  }

  post(m: FromEngine): void {
    this.deps.post(m);
  }

  /** Resolves true once the vault streams this tab's topics, false after `ms`. */
  untilStreaming(ms: number): Promise<boolean> {
    if (this.streaming) return Promise.resolve(true);
    return new Promise((resolve) => {
      const wake = () => {
        clearTimeout(timer);
        this.waiting.delete(wake);
        resolve(true);
      };
      const timer = setTimeout(() => {
        this.waiting.delete(wake);
        resolve(false);
      }, ms);
      this.waiting.add(wake);
    });
  }

  /** One OpenF1 read through the vault, as the relay's fetchEndpoint: rows, [] for none, AuthError for a refused login. */
  async rest<T>(endpoint: Endpoint, params: Params): Promise<T[]> {
    for (let attempt = 1; ; attempt++) {
      let r: Got;
      try {
        r = await this.get(endpoint, params);
      } catch (e) {
        if (!(e instanceof VaultGetError) || !RETRY_CODES.has(e.code) || attempt >= REST_TRIES) throw e;
        await this.sleep(1_000 * 2 ** attempt);
        continue;
      }
      if (r.status === 200) {
        const rows: unknown = JSON.parse(dec.decode(r.body));
        return Array.isArray(rows) ? (rows as T[]) : [];
      }
      if (r.status === 404) return []; // OpenF1: "No results found."
      if (r.status === 401 || r.status === 403) {
        throw new AuthError(r.auth ? `OpenF1 refused the account (HTTP ${r.status})` : "live timing needs a connected OpenF1 account");
      }
      if ((r.status === 429 || r.status >= 500) && attempt < REST_TRIES) {
        await this.sleep(1_000 * 2 ** attempt);
        continue;
      }
      throw new Error(`OpenF1 ${r.status} for ${endpoint}`);
    }
  }

  /** A `get` through the page, at most MAX_IN_FLIGHT at once. */
  private async get(endpoint: Endpoint, params: Params): Promise<Got> {
    if (this.inFlight >= MAX_IN_FLIGHT) await new Promise<void>((r) => this.queue.push(r));
    this.inFlight++;
    try {
      const id = this.nextId++;
      return await new Promise<Got>((resolve, reject) => {
        this.pending.set(id, { resolve, reject });
        this.deps.post({ type: "get", id, endpoint, params });
      });
    } finally {
      this.inFlight--;
      this.queue.shift()?.();
    }
  }
}

/**
 * A session's feed from the vault: subscribe (the page does), then wait for the vault's stream to be up before the
 * backfill starts, so nothing falls between the two. If it isn't up in STREAM_WAIT_MS the backfill goes ahead, and
 * once it is, what came in between is fetched again. (After that the vault fills its own gaps.)
 */
class VaultFeed implements LiveFeed {
  private late: number | null = null;
  private stopped = false;

  constructor(
    private engine: VaultEngine,
    private store: LiveStore,
    private hooks: FeedHooks,
  ) {}

  async start(): Promise<void> {
    const from = this.engine.now();
    this.engine.post({ type: "subscribe" });
    if (await this.engine.untilStreaming(STREAM_WAIT_MS)) return;
    this.late = from;
    throw new Error("OpenF1's live stream isn't up yet (through the vault)");
  }

  stop(): void {
    this.stopped = true;
    this.engine.post({ type: "unsubscribe" });
  }

  deliver(topic: Topic, messages: Rec[]): void {
    if (this.stopped) return;
    for (const m of messages) this.hooks.deliver(topic, m);
  }

  streamingChanged(on: boolean): void {
    if (!on || this.late == null || this.stopped) return;
    const since = this.late;
    this.late = null;
    void this.hooks.refill(since).catch((e) => console.warn(`[live] refill failed: ${errorText(e)}`));
  }
}
