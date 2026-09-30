// The app's side of the credential vault (vault/, a separate site): a hidden iframe and a MessagePort.
// The app never sees an OpenF1 password or token, only data. If the vault can't load, the client says
// "unavailable" and the app carries on without a login.
//
// VITE_VAULT_ORIGIN: where the vault is served (default the local vault dev server; "off" disables it).

import type { Hello, Method, Methods, Params, Ready, Request, Response, RestEndpoint, LiveTopic, VaultError, VaultEvent, VaultStatus } from "../../vault/src/protocol";

export type { LiveTopic, RestEndpoint, VaultEvent, VaultStatus };
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
  private started: Promise<void> | null = null;

  constructor(readonly origin: string | null = vaultOrigin(import.meta.env.VITE_VAULT_ORIGIN)) {
    this.state = { phase: "idle", origin };
  }

  getState = () => this.state;

  /** Called on every state change. Returns an unsubscribe. */
  onState(fn: (s: VaultState) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Unsolicited vault events (status changes, live messages). Returns an unsubscribe. */
  onEvent(fn: (e: VaultEvent) => void): () => void {
    this.eventListeners.add(fn);
    return () => this.eventListeners.delete(fn);
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
  subscribe = (topics: LiveTopic[]) => this.call("subscribe", { topics });
  unsubscribe = (topics: LiveTopic[]) => this.call("unsubscribe", { topics });
  get = (endpoint: RestEndpoint, params: Params) => this.call("get", { endpoint, params });
  /** Hand `port` to the vault: it speaks this same protocol on it (e.g. from the download worker). */
  openPort = (port: MessagePort) => this.call("openPort", {}, [port]);

  async call<M extends Method>(type: M, args: Args<M>, transfer: Transferable[] = []): Promise<Result<M>> {
    await this.start();
    const port = this.port;
    if (!port) throw new VaultRequestError("unavailable", this.state.reason ?? "vault unavailable");
    const id = this.nextId++;
    return new Promise<Result<M>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new VaultRequestError("timeout", `${type} timed out`));
      }, REQUEST_MS);
      this.pending.set(id, { resolve: resolve as (r: unknown) => void, reject, timer });
      port.postMessage({ v: 1, id, type, ...args } as Request, transfer);
    });
  }

  private popupWindow: Window | null = null;
  private popupTimer: ReturnType<typeof setInterval> | undefined;

  private openPopup(kind: "connect" | "unlock"): Promise<VaultStatus | null> {
    const origin = this.origin;
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
      void this.call("cancel", { ticket }).then(
        (status) => this.set({ status }),
        () => {},
      );
    }, 500);
    return this.call(kind, { ticket }).then(
      (status) => {
        this.set({ status });
        return status;
      },
      (e: Error) => {
        this.set({ actionError: e.message });
        return null;
      },
    );
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
    this.set({ phase: "loading" });
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
      const finish = (patch: Partial<VaultState>) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(afterLoad);
        window.removeEventListener("message", onReady);
        this.set(patch);
        done();
      };
      const fail = (reason: string) => {
        iframe.remove();
        finish({ phase: "unavailable", reason });
      };
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
      };
      window.addEventListener("message", onReady);
      document.body.append(iframe);
    });
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
