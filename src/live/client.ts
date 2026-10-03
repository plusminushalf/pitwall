// Browser side of the live relay's WebSocket (server/live.ts; protocol in ./protocol.ts), and where live data comes
// from: the relay, or else the credential vault (./vault.ts).

import { getVault } from "../vault/client";
import type { LiveMessage } from "./protocol";

/**
 * Whether this build has a live relay behind it: the dev server (proxying /relay to `bun run live`), or a
 * build made with VITE_LIVE_RELAY=1 for a host that serves the relay at /relay. VITE_LIVE_RELAY=0 turns it off
 * in dev too, so live goes through the vault as on the hosted site.
 */
export const LIVE_RELAY = import.meta.env.VITE_LIVE_RELAY === "1" || (import.meta.env.DEV && import.meta.env.VITE_LIVE_RELAY !== "0");

/** Where live data comes from. */
export type LiveVia = "relay" | "vault";

/**
 * The relay when this build has one; else the credential vault when it has one (VITE_VAULT_ORIGIN isn't `off`),
 * which streams OpenF1 with the user's own account; else nowhere (null).
 */
export const liveVia = (): LiveVia | null => (LIVE_RELAY ? "relay" : getVault().origin ? "vault" : null);

const RETRY_MIN_MS = 1_000;
const RETRY_MAX_MS = 10_000;

export interface LiveHandlers {
  onOpen: () => void;
  onMessage: (msg: LiveMessage) => void;
  /** The socket failed to connect or dropped (relay not running, network...). It retries by itself. */
  onDown: () => void;
}

export interface LiveConnection {
  close: () => void;
}

/** `/relay` on the page's own origin (the Vite dev server proxies it to the relay). */
export function liveUrl(): string {
  return `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/relay`;
}

/** Connects to the relay and stays connected (reconnecting with backoff) until `close()`. */
export function connectLive(handlers: LiveHandlers, url = liveUrl()): LiveConnection {
  let ws: WebSocket | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let failures = 0;
  let closed = false;

  const open = () => {
    retry = null;
    if (closed) return;
    const socket = new WebSocket(url);
    ws = socket;
    socket.onopen = () => {
      if (ws !== socket) return;
      failures = 0;
      handlers.onOpen();
    };
    socket.onmessage = (e) => {
      if (ws !== socket || typeof e.data !== "string") return;
      let msg: LiveMessage;
      try {
        msg = JSON.parse(e.data) as LiveMessage;
      } catch {
        return; // not ours
      }
      if (msg && typeof msg === "object" && "type" in msg) handlers.onMessage(msg);
    };
    // A failed connection fires `error` then `close`: handle it once, on close.
    socket.onclose = () => {
      if (ws !== socket) return;
      ws = null;
      if (closed) return;
      handlers.onDown();
      const delay = Math.min(RETRY_MIN_MS * 2 ** failures, RETRY_MAX_MS);
      failures++;
      retry = setTimeout(open, delay);
    };
  };

  open();
  return {
    close: () => {
      closed = true;
      if (retry) clearTimeout(retry);
      const socket = ws;
      ws = null;
      if (socket) {
        socket.onopen = socket.onmessage = socket.onclose = null;
        socket.close();
      }
    },
  };
}
