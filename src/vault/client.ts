// The app's side of the credential vault (vault/, a separate site): a hidden iframe and a MessagePort.
// The app never sees an OpenF1 password or token, only data. If the vault can't load, the client says
// "unavailable" and the app carries on without a login.
//
// Something else on the page can remove the iframe (seen: a browser extension, some time after the
// handshake). The client notices, fails what was pending on the dead port, and mounts a new frame with a
// fresh handshake; a few times a minute at most, then it says "unavailable" instead of looping.
//
// VITE_VAULT_ORIGIN: where the vault is served (default the local vault dev server; "off" disables it).

import type { BudgetStatus, Hello, LiveMessage, Method, Methods, Params, Ready, Request, Response, RestEndpoint, LiveTopic, SimAction, SimStatus, StreamStatus, VaultError, VaultEvent, VaultStatus } from "../../vault/src/protocol";

export type { BudgetStatus, LiveMessage, LiveTopic, RestEndpoint, SimStatus, StreamStatus, VaultEvent, VaultStatus };
export type { VaultState as VaultAccountState, StorageMode } from "../../vault/src/protocol";

export type VaultPhase = "idle" | "loading" | "ready" | "unavailable";

export type VaultState = {
  phase: VaultPhase;
  origin: string | null;
  /** Why it's unavailable. */
  reason?: string;
  /** ms from mounting the iframe to the port being up. */
  handshakeMs?: number;
  /** The vault's last reported status (after the handshake). */
  status?: VaultStatus;
  /** The setup / unlock popup is open (this tab opened it). */
  popup?: "connect" | "unlock";
  /** The last connect / unlock / disconnect attempt that failed on this side (popup blocked, vault busy…). */
  actionError?: string;
  /** How many times the iframe went away and a new one was mounted (this page load). */
  remounts?: number;
};

/** A request the vault refused: `code` is the protocol's error code (or "unavailable" / "timeout" here). */
export class VaultRequestError extends Error {
  constructor(
    readonly code: VaultError["code"] | "unavailable" | "timeout",
    message: string,
  ) {
    super(message);
  }
}

const DEFAULT_ORIGIN = "http://localhost:5174";
const HANDSHAKE_MS = 10_000;
/** After the iframe's load event, "ready" should follow at once; its absence means an error page. */
const AFTER_LOAD_MS = 1_500;
const REQUEST_MS = 30_000;
/** A frame that goes away is mounted again, at most this many times in REMOUNTS_WINDOW_MS. */
const REMOUNTS_MAX = 3;
const REMOUNTS_WINDOW_MS = 60_000;
const KEPT_REMOVED = "something on this page keeps removing the vault (a browser extension?)";
/** Requests pending on a frame that went away. */
const FRAME_GONE = "the vault was removed from the page; try again";
/** The popup's window name: a second Connect click reuses (navigates) the open popup instead of stacking another. */
const POPUP_NAME = "f1-vault";
const POPUP_W = 440;
const POPUP_H = 640;

/** 128 random bits, base64url: pairs the popup with this tab's vault frame (protocol.ts, Ticket). */
function newTicket(): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...b)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

type Args<M extends Method> = Methods[M]["args"];
type Result<M extends Method> = Methods[M]["result"];

function vaultOrigin(configured: string | undefined): string | null {
  const raw = configured?.trim() || DEFAULT_ORIGIN;
  if (raw === "off") return null;
  try {
    return new URL(raw).origin;
  } catch {
    return null;
  }
}

export class VaultClient {
  private state: VaultState;
  private listeners = new Set<(s: VaultState) => void>();
  private eventListeners = new Set<(e: VaultEvent) => void>();
  private port: MessagePort | null = null;
  private pending = new Map<number, { resolve: (r: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private nextId = 1;
  /** The handshake: the first one, or the re-mount's after the frame went away. */
  private started: Promise<void> | null = null;
  private iframe: HTMLIFrameElement | null = null;
  private observer: MutationObserver | null = null;
  /** Ends a handshake whose frame went away before it answered (a re-mount takes over). */
  private abandon: (() => void) | null = null;
  /** When the frame went away, within the last REMOUNTS_WINDOW_MS. */
  private losses: number[] = [];
  /** This tab's live topics: a new frame is subscribed to them again. */
  private topics: LiveTopic[] = [];
  /** The open popup's ticket, and the port (frame) it was last given to: a new frame is given it again. */
  private ticket: { kind: "connect" | "unlock"; ticket: string; sentOn: MessagePort | null } | null = null;

  constructor(readonly origin: string | null = vaultOrigin(import.meta.env.VITE_VAULT_ORIGIN)) {
    this.state = { phase: "idle", origin };
  }

  getState = () => this.state;

  /** Called on every state change. Returns an unsubscribe. */
  onState(fn: (s: VaultState) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Unsolicited vault events (status changes, live data). Returns an unsubscribe. */
  onEvent(fn: (e: VaultEvent) => void): () => void {
    this.eventListeners.add(fn);
    return () => this.eventListeners.delete(fn);
  }

  /**
   * Live data for the topics this tab subscribed to: batches (every ~150 ms), each message once, in `date`
   * order within a batch, parsed JSON as OpenF1 sent it. Returns an unsubscribe.
   */
  onData(fn: (topic: LiveTopic, messages: LiveMessage[]) => void): () => void {
    return this.onEvent((e) => {
      if (e.event === "data") fn(e.topic, e.messages);
    });
  }

  /** Mount the iframe and do the handshake, once. Resolves either way; see the state's phase. */
  start(): Promise<void> {
    return (this.started ??= this.handshake());
  }

  status = () => this.call("status", {});
  /**
   * Open the vault's login popup. Call it straight from a click handler (synchronously, before any await):
   * browsers only allow popups there, and a cross-site iframe can't open one on its own. The login then
   * goes popup -> vault frame; this tab never sees it.
   */
  connect = () => this.openPopup("connect");
  /** Open the popup in unlock mode (passkey). From a click handler, like connect. */
  unlock = () => this.openPopup("unlock");
  disconnect = async () => {
    this.set({ actionError: undefined });
    const status = await this.call("disconnect", {});
    this.set({ status });
    return status;
  };
  /**
   * Live topics for this tab. The vault streams the union of every tab's (one connection per browser) and
   * delivers each tab its own. Resolves with this tab's topics after the change.
   */
  subscribe = (topics: LiveTopic[]) => this.setTopics("subscribe", topics);
  unsubscribe = (topics: LiveTopic[]) => this.setTopics("unsubscribe", topics);
  /**
   * An OpenF1 read through the vault: authenticated when it holds a valid token (`auth` in the result),
   * unauthenticated otherwise. A 401 there refreshes the token and retries once, inside the vault. `timeoutMs`: how
   * long to wait for the answer, its turn in the vault's REST budget included (default 30 s).
   */
  get = (endpoint: RestEndpoint, params: Params, timeoutMs?: number) => this.call("get", { endpoint, params }, [], timeoutMs);
  /**
   * Hand `port` to the vault: it speaks this same protocol on it (the download worker's, transferred on to the
   * worker: its gets go straight to the vault). Send `close` on it when done (ports have no close event).
   * If the frame is removed, the port goes quiet (it isn't moved to the new frame): the worker's ping notices
   * and the download goes direct (src/ingest/vaultPort.ts).
   */
  openPort = (port: MessagePort) => this.call("openPort", {}, [port]);

  /**
   * Dev-vault testing knobs (the debug panel). A production vault doesn't have them: these reject with
   * bad_request "unknown type".
   */
  readonly debug = {
    /** Corrupt the vault's in-memory token: the next authenticated get gets a real 401. */
    spoilToken: () => this.withStatus(this.call("debug:spoilToken", {})),
    /** Treat new tokens as lasting `seconds` (0: real lifetime). */
    fakeExpiry: (seconds: number) => this.withStatus(this.call("debug:fakeExpiry", { seconds })),
    /** Refresh the token now. */
    refreshNow: () => this.withStatus(this.call("debug:refreshNow", {})),
    /** The next `times` /token calls answer `status` without reaching OpenF1 (0: clear). */
    failToken: (status: 401 | 429 | 503, times: number) => this.withStatus(this.call("debug:failToken", { status, times })),
    /** Freeze this tab's vault frame for `ms` (like Chrome freezing a background tab): another tab should take over. */
    freeze: (ms: number) => this.withStatus(this.call("debug:freeze", { ms })),
    /** Simulate mode: drop every broker session now, or refuse the next CONNECT (CONNACK 5). */
    sim: (action: SimAction) => this.withStatus(this.call("debug:sim", { action })),
  };

  private async withStatus(p: Promise<VaultStatus>) {
    const status = await p;
    this.set({ status });
    return status;
  }

  private async setTopics(type: "subscribe" | "unsubscribe", topics: LiveTopic[]) {
    const r = await this.call(type, { topics });
    this.topics = r.topics;
    return r;
  }

  async call<M extends Method>(type: M, args: Args<M>, transfer: Transferable[] = [], timeoutMs = REQUEST_MS): Promise<Result<M>> {
    const port = await this.attached();
    if (!port) throw new VaultRequestError("unavailable", this.state.reason ?? "vault unavailable");
    return this.request(port, type, args, transfer, timeoutMs);
  }

  /** The port once the handshake is done, waiting out a re-mount; null when the vault is unavailable. */
  private async attached(): Promise<MessagePort | null> {
    this.checkFrame();
    for (;;) {
      const p = this.start();
      await p;
      if (this.port || p === this.started) return this.port;
    }
  }

  private request<M extends Method>(port: MessagePort, type: M, args: Args<M>, transfer: Transferable[] = [], timeoutMs = REQUEST_MS): Promise<Result<M>> {
    const id = this.nextId++;
    return new Promise<Result<M>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new VaultRequestError("timeout", `${type} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (r: unknown) => void, reject, timer });
      port.postMessage({ v: 1, id, type, ...args } as Request, transfer);
    });
  }

  private popupWindow: Window | null = null;
  private popupTimer: ReturnType<typeof setInterval> | undefined;

  private openPopup(kind: "connect" | "unlock"): Promise<VaultStatus | null> {
    const origin = this.origin;
    // A frame that went away unnoticed: its re-mount starts now, while the popup loads.
    this.checkFrame();
    if (!origin || this.state.phase !== "ready") return Promise.resolve(null);
    const ticket = newTicket();
    const left = Math.max(0, Math.round(window.screenX + (window.outerWidth - POPUP_W) / 2));
    const top = Math.max(0, Math.round(window.screenY + (window.outerHeight - POPUP_H) / 3));
    // Synchronously, in the click: no await before this line. No "noopener": the popup needs window.opener
    // to find the vault frame.
    const w = window.open(`${origin}/popup.html#mode=${kind}&ticket=${ticket}`, POPUP_NAME, `popup,width=${POPUP_W},height=${POPUP_H},left=${left},top=${top}`);
    if (!w) {
      this.set({ actionError: "The browser blocked the vault's window. Allow popups for this site and try again." });
      return Promise.resolve(null);
    }
    w.focus();
    this.popupWindow = w;
    this.ticket = { kind, ticket, sentOn: null };
    this.set({ popup: kind, actionError: undefined });
    clearInterval(this.popupTimer);
    // The popup is cross-origin: `closed` is all we can see of it. When it closes, tell the frame.
    this.popupTimer = setInterval(() => {
      if (!w.closed && this.popupWindow === w) return;
      clearInterval(this.popupTimer);
      if (this.popupWindow === w) {
        this.popupWindow = null;
        this.set({ popup: undefined });
      }
      if (this.ticket?.ticket === ticket) this.ticket = null;
      void this.call("cancel", { ticket }).then(
        (status) => this.set({ status }),
        () => {},
      );
    }, 500);
    return this.armPopup();
  }

  /**
   * Tell the frame to expect the open popup's ticket: after the click, and again after a re-mount (a new
   * frame, and the popup may still be looking for one). Once per frame; the latest click's ticket.
   */
  private async armPopup(): Promise<VaultStatus | null> {
    const port = await this.attached();
    const t = this.ticket;
    if (!port || !t || t.sentOn === port) return null;
    t.sentOn = port;
    try {
      const status = await this.request(port, t.kind, { ticket: t.ticket });
      this.set({ status });
      return status;
    } catch (e) {
      // The frame went away meanwhile: the re-mount gives the new one the ticket.
      if (port !== this.port) return null;
      this.set({ actionError: (e as Error).message });
      return null;
    }
  }

  private set(patch: Partial<VaultState>) {
    this.state = { ...this.state, ...patch };
    for (const fn of this.listeners) fn(this.state);
  }

  private handshake(): Promise<void> {
    const origin = this.origin;
    if (!origin) {
      this.set({ phase: "unavailable", reason: "no vault configured" });
      return Promise.resolve();
    }
    // A re-mount keeps the phase "ready" and the last status while the new frame loads (as long as the first
    // load took): the account lives in the vault's storage and comes back the same, so Settings keeps its
    // Connect button, and calls made meanwhile (a click's connect included) wait for the new port.
    if (this.state.phase !== "ready") this.set({ phase: "loading" });
    const t0 = performance.now();
    const iframe = document.createElement("iframe");
    iframe.src = `${origin}/frame.html`;
    iframe.hidden = true;
    iframe.tabIndex = -1;
    iframe.title = "OpenF1 account vault";
    iframe.setAttribute("aria-hidden", "true");
    iframe.referrerPolicy = "no-referrer";

    return new Promise<void>((done) => {
      let settled = false;
      const finish = (patch: Partial<VaultState> | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(afterLoad);
        window.removeEventListener("message", onReady);
        this.abandon = null;
        if (patch) this.set(patch);
        done();
      };
      const fail = (reason: string) => {
        if (settled) return;
        this.unmount();
        finish({ phase: "unavailable", reason, status: undefined });
      };
      // The frame went away before it answered: lost() mounts another, with its own handshake.
      this.abandon = () => finish(null);
      const timer = setTimeout(() => fail("the vault didn't answer"), HANDSHAKE_MS);
      let afterLoad: ReturnType<typeof setTimeout> | undefined;
      iframe.addEventListener("load", () => {
        afterLoad = setTimeout(() => fail("the vault didn't load"), AFTER_LOAD_MS);
      });

      const onReady = (e: MessageEvent) => {
        if (e.source !== iframe.contentWindow || e.origin !== origin || !isReady(e.data)) return;
        const channel = new MessageChannel();
        this.port = channel.port1;
        channel.port1.onmessage = (m) => this.onPortMessage(m.data);
        iframe.contentWindow!.postMessage({ v: 1, type: "hello" } satisfies Hello, origin, [channel.port2]);
        finish({ phase: "ready", handshakeMs: Math.round(performance.now() - t0) });
        void this.status().then(
          (status) => this.set({ status }),
          () => {},
        );
        // After a re-mount (a new frame knows nothing of this tab): its live topics, and the open popup's ticket.
        if (this.topics.length) void this.subscribe(this.topics).catch(() => {});
        if (this.ticket) void this.armPopup();
      };
      window.addEventListener("message", onReady);
      this.mount(iframe);
    });
  }

  /** Mount the frame and watch its parent: something may remove it later (seen: a browser extension). */
  private mount(iframe: HTMLIFrameElement) {
    this.iframe = iframe;
    document.body.append(iframe);
    this.observer = new MutationObserver((records) => {
      // Removed, or moved (a moved iframe loads again: a new page that never got our port).
      if (this.iframe === iframe && (!iframe.isConnected || records.some((r) => Array.from(r.removedNodes).includes(iframe)))) this.lost();
    });
    this.observer.observe(document.body, { childList: true });
  }

  /** The frame can also go without its parent changing (the parent itself replaced): look before using it. */
  private checkFrame() {
    if (this.iframe && !this.iframe.isConnected) this.lost();
  }

  private unmount() {
    this.observer?.disconnect();
    this.observer = null;
    this.iframe?.remove();
    this.iframe = null;
  }

  /**
   * The frame went away, and its port with it. Fail what was pending there at once (not after REQUEST_MS),
   * and mount a new frame: a new page load, so the same handshake again. Unless it keeps happening.
   */
  private lost() {
    this.unmount();
    this.abandon?.();
    this.port?.close();
    this.port = null;
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const p of pending) {
      clearTimeout(p.timer);
      p.reject(new VaultRequestError("unavailable", FRAME_GONE));
    }
    const now = Date.now();
    this.losses = [...this.losses.filter((t) => now - t < REMOUNTS_WINDOW_MS), now];
    if (this.losses.length > REMOUNTS_MAX) return this.set({ phase: "unavailable", reason: KEPT_REMOVED, status: undefined });
    this.set({ remounts: (this.state.remounts ?? 0) + 1 });
    this.started = this.handshake();
  }

  private onPortMessage(data: unknown) {
    if (typeof data !== "object" || data === null) return;
    const msg = data as Response | VaultEvent;
    if ("type" in msg && msg.type === "event") {
      if (msg.event === "status") this.set({ status: msg.status });
      for (const fn of this.eventListeners) fn(msg);
      return;
    }
    const res = msg as Response;
    const p = this.pending.get(res.id);
    if (!p) return;
    this.pending.delete(res.id);
    clearTimeout(p.timer);
    if (res.ok) p.resolve(res.result);
    else p.reject(new VaultRequestError(res.error.code, res.error.message));
  }
}

const isReady = (x: unknown): x is Ready => typeof x === "object" && x !== null && (x as Ready).v === 1 && (x as Ready).type === "ready";

let client: VaultClient | null = null;
/** The app's one vault client (one iframe per tab). */
export const getVault = () => (client ??= new VaultClient());
