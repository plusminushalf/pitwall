// Live mode through the credential vault (vault/, another site), where there's no relay (the hosted site): the vault
// streams OpenF1's live feed with the user's own OpenF1 account, and a worker (./worker.ts) turns it into the relay's
// LiveMessages with the relay's own code. This side starts the worker while there's a connected account and stops it
// when the account goes, and relays between the worker and the vault: subscriptions, data and REST. The worker
// subscribes only while a session is on; closing unsubscribes. The vault shares one stream among tabs.

import type { GetResult, LiveMessage as VaultMessage, LiveTopic, Params, RestEndpoint, StreamStatus } from "../../vault/src/protocol";
import { getVault, type VaultState } from "../vault/client";
import type { LiveConnection, LiveHandlers } from "./client";
import { TOPICS } from "./topics";
import type { FromEngine, ToEngine } from "./vaultEngine";

/** Why live can't run through the vault right now. */
export type LiveAccount =
  | "loading" // the vault is loading
  | "checking" // it's checking the stored login with OpenF1
  | "connect" // no OpenF1 account connected
  | "unlock" // a passkey-locked login, not unlocked yet
  | "reconnect" // the stored login stopped working
  | "blocked" // the browser blocks the vault's storage (third-party cookies)
  | "unavailable"; // the vault didn't load

/** The vault's stream isn't delivering: reconnecting, refused (the account's connection cap), or waiting for a token. */
export type LiveStall = "reconnecting" | "limit" | "waiting";

/** What live mode needs from the account before it can run, or null when it can. */
export function accountNeed(s: VaultState): LiveAccount | null {
  if (s.phase === "unavailable") return "unavailable";
  if (s.phase !== "ready" || !s.status) return "loading";
  switch (s.status.state) {
    case "connected":
      return null;
    case "connecting":
      return "checking";
    case "locked":
      return "unlock";
    case "error":
      return "reconnect";
    case "unavailable":
      return "blocked";
    default:
      return "connect";
  }
}

const STREAMING = new Set(["connected", "handover", "gap-filling"]);

/** Whether the vault streams all of TOPICS now. */
export function streamingAll(st: StreamStatus | undefined): boolean {
  return !!st && STREAMING.has(st.phase) && TOPICS.every((t) => st.topics.includes(t));
}

export function stallOf(st: StreamStatus | undefined): LiveStall | null {
  if (!st) return null;
  if (st.phase === "reconnecting") return "reconnecting";
  if (st.phase === "connection-limit" && st.sessions === 0) return "limit";
  if (st.phase === "waiting") return "waiting";
  return null;
}

export interface VaultLiveHandlers extends LiveHandlers {
  /** What the account needs before live can run (null: nothing, it runs). */
  onAccount: (account: LiveAccount | null) => void;
  /** The vault's stream stalled (null: it's fine), while this tab is subscribed. */
  onStall: (stall: LiveStall | null) => void;
}

/** The parts of the vault client this uses (src/vault/client.ts). */
export interface VaultLike {
  getState(): VaultState;
  onState(fn: (s: VaultState) => void): () => void;
  onData(fn: (topic: LiveTopic, messages: VaultMessage[]) => void): () => void;
  start(): Promise<void>;
  subscribe(topics: LiveTopic[]): Promise<unknown>;
  unsubscribe(topics: LiveTopic[]): Promise<unknown>;
  get(endpoint: RestEndpoint, params: Params, timeoutMs?: number): Promise<GetResult>;
}

export interface WorkerLike {
  postMessage(m: ToEngine, transfer?: Transferable[]): void;
  onmessage: ((e: { data: FromEngine }) => void) | null;
  onerror: ((e: { message?: string; preventDefault?: () => void }) => void) | null;
  terminate(): void;
}

const spawnWorker = (): WorkerLike => new Worker(new URL("./worker.ts", import.meta.url), { type: "module", name: "live" }) as unknown as WorkerLike;

/**
 * How long a REST read may take, its turn in the vault's budget included: as long as the vault gives it (120 s). Two
 * tabs catching up at once share the account's 60 requests a minute; one that gave up early would be asked again
 * while the first is still queued.
 */
const GET_TIMEOUT_MS = 120_000;
/** A crashed worker is started again after this (doubling, up to RESTART_MAX_MS). */
const RESTART_MIN_MS = 2_000;
const RESTART_MAX_MS = 60_000;
/** After close, an unsubscribe that fails is tried this many times. */
const UNSUBSCRIBE_TRIES = 3;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** A vault connection whose screen can go away and come back (the app keeps it while live mode is left for a while). */
export interface VaultLiveConnection extends LiveConnection {
  /** Nothing goes to the app any more; the worker keeps following the session. */
  detach(): void;
  /** The app is back: it gets the account, the status and the session so far (a snapshot), then the stream. */
  attach(handlers: VaultLiveHandlers): void;
}

const IGNORE: VaultLiveHandlers = { onOpen() {}, onDown() {}, onMessage() {}, onAccount() {}, onStall() {} };

/** Follow live through the vault until `close()`; the app gets the relay's messages. */
export function connectVaultLive(handlers: VaultLiveHandlers, deps: { vault?: VaultLike; spawn?: () => WorkerLike } = {}): VaultLiveConnection {
  const vault = deps.vault ?? getVault();
  let h = handlers;
  const spawn = deps.spawn ?? spawnWorker;
  let worker: WorkerLike | null = null;
  let closed = false;
  let opened = false;
  let account: LiveAccount | null | undefined;
  let stall: LiveStall | null = null;
  let streaming = false;
  let remounts = vault.getState().remounts ?? 0;
  let crashes = 0;
  let restart: ReturnType<typeof setTimeout> | null = null;
  // Subscriptions: what the worker wants, what the vault has; one change at a time.
  let want = false;
  let have = false;
  let syncing = false;

  const send = (m: ToEngine, transfer?: Transferable[]) => worker?.postMessage(m, transfer);

  /** Streaming and stall as of the vault's state now (they depend on our subscription too). */
  const streamChanged = (s: VaultState) => {
    const st = s.status?.stream;
    const on = !!worker && want && have && streamingAll(st);
    if (on !== streaming) {
      streaming = on;
      send({ type: "stream", streaming: on });
    }
    const next = worker && want && have ? stallOf(st) : null;
    if (next !== stall) h.onStall((stall = next));
  };

  const sync = async () => {
    if (syncing) return;
    syncing = true;
    let failures = 0;
    try {
      while (want !== have) {
        const target = want;
        try {
          await (target ? vault.subscribe([...TOPICS]) : vault.unsubscribe([...TOPICS]));
          have = target;
          failures = 0;
          streamChanged(vault.getState());
        } catch (e) {
          failures++;
          console.warn(`[live] vault ${target ? "subscribe" : "unsubscribe"} failed: ${errorText(e)}`);
          if (closed && failures >= UNSUBSCRIBE_TRIES) break;
          await sleep(Math.min(10_000, 1_000 * 2 ** failures));
        }
      }
    } finally {
      syncing = false;
    }
  };

  const onWorker = (m: FromEngine) => {
    switch (m.type) {
      case "live":
        if (!opened) {
          opened = true;
          crashes = 0;
          h.onOpen();
        }
        h.onMessage(m.msg);
        return;
      case "get":
        vault.get(m.endpoint as RestEndpoint, m.params, GET_TIMEOUT_MS).then(
          (r) => send({ type: "got", id: m.id, status: r.status, auth: r.auth, body: r.body }, [r.body]),
          (e: Error & { code?: string }) => send({ type: "failed", id: m.id, code: e.code ?? "error", message: errorText(e) }),
        );
        return;
      case "subscribe":
      case "unsubscribe":
        want = m.type === "subscribe";
        streamChanged(vault.getState());
        void sync();
        return;
    }
  };

  const startWorker = (s: VaultState) => {
    const w = spawn();
    worker = w;
    opened = false;
    streaming = false;
    w.onmessage = (e) => {
      if (worker === w) onWorker(e.data);
    };
    w.onerror = (e) => {
      e.preventDefault?.();
      if (worker !== w) return;
      console.warn(`[live] the live worker stopped: ${e.message ?? "unknown error"}`);
      stopWorker();
      h.onDown();
      const delay = Math.min(RESTART_MAX_MS, RESTART_MIN_MS * 2 ** crashes++);
      restart = setTimeout(() => {
        restart = null;
        if (!closed && !worker && accountNeed(vault.getState()) === null) startWorker(vault.getState());
      }, delay);
    };
    const sim = s.status?.sim;
    send({ type: "start", sim: sim ? { anchorWall: sim.anchorWall, speed: sim.speed } : null });
  };

  const stopWorker = () => {
    worker?.terminate();
    worker = null;
    opened = false;
    streaming = false;
    want = false;
    if (stall) h.onStall((stall = null));
    void sync();
  };

  const onState = (s: VaultState) => {
    if (closed) return;
    const need = accountNeed(s);
    // A login being checked again (a reconnect in the popup) doesn't stop what runs.
    const now = worker && need === "checking" ? null : need;
    if (now !== account) h.onAccount((account = now));
    if (now === null && !worker && !restart) startWorker(s);
    else if (now !== null && worker) stopWorker();
    // A new vault frame (the old one was removed from the page): it may have missed some of the stream.
    const n = s.remounts ?? 0;
    if (n !== remounts && worker) send({ type: "refill" });
    remounts = n;
    streamChanged(s);
  };

  const offState = vault.onState(onState);
  const offData = vault.onData((topic, messages) => {
    if (want) send({ type: "data", topic, messages });
  });
  void vault.start();
  onState(vault.getState());

  return {
    detach: () => {
      h = IGNORE;
    },
    attach: (next) => {
      if (closed) return;
      h = next;
      if (account !== undefined) h.onAccount(account);
      if (stall) h.onStall(stall);
      if (opened) h.onOpen();
      // (Before the worker's first message this is its first: the status, while it's still backfilling.)
      send({ type: "welcome" });
    },
    close: () => {
      if (closed) return;
      closed = true;
      offState();
      offData();
      if (restart) clearTimeout(restart);
      stopWorker();
    },
  };
}
