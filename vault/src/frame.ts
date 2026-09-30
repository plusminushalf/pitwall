// The hidden vault iframe (frame.html). It is the only code that ever holds the OpenF1 login.
//
// Handshake: check the embedding page is an allowlisted app origin, post "ready" to it (that exact
// targetOrigin), take the MessagePort from its "hello", then speak the protocol only over that port.
//
// The setup popup (popup.html, top level on the vault's own origin) can't share this frame's storage:
// Chrome partitions it by the app's site. So the popup posts the login here (`opener.frames[i]`), and this
// frame checks it with OpenF1 and stores it in its own partition. Window messages from the vault's own
// origin are popup messages; core.ts answers only the one it is waiting for (its pending ticket).
//
// Every tab has one of these frames; tabs.ts elects a leader among them (Web Locks) that alone refreshes the
// token, runs the live stream and spends the REST budget, and fans data out over a BroadcastChannel.

import { VaultCore } from "./core";
import { DevKnobs } from "./debug";
import { LiveManager, MQTT_URL } from "./live";
import type { SocketLike } from "./mqtt";
import { fromParent, parentOrigin } from "./origins";
import { isHello, parsePopupMessage, type Ready, type VaultEvent } from "./protocol";
import { REST_BASE, Rest, type RestFetch } from "./rest";
import { Rpc, type Vault } from "./rpc";
import type { Timers } from "./scheduler";
import { IdbStore } from "./storage";
import { CHANNEL, VaultNode, type ChannelLike, type LocksLike } from "./tabs";

const parent = window.parent !== window ? parentOrigin(location.ancestorOrigins, __VAULT_APP_ORIGINS__) : null;

if (parent) {
  // Frames in other tabs of the same app share this partition (IndexedDB, BroadcastChannel, Web Locks).
  const bc = new BroadcastChannel(CHANNEL);
  const channel: ChannelLike = { postMessage: (m) => bc.postMessage(m), onmessage: null };
  bc.onmessage = (e) => channel.onmessage?.(e);
  // Dev vault only: the local fake broker (VAULT_FAKE_BROKER). A build has "" here, so the real OpenF1 URLs.
  const fake = __VAULT_DEV__ ? __VAULT_FAKE_BROKER__ : "";
  const timers: Timers = { now: Date.now, setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) };
  let rpc: Rpc | null = null;
  let knobs: DevKnobs | null = null;
  let node: VaultNode | null = null;
  let live: LiveManager | null = null;
  const core = new VaultCore({
    store: new IdbStore(),
    // Dev vault only: /token through the failure injection (debug:failToken).
    fetch: __VAULT_DEV__ ? (url, init) => knobs!.tokenFetch((u, i) => fetch(u, i))(url, init) : (url, init) => fetch(url, init),
    now: Date.now,
    version: __VAULT_VERSION__,
    onStatus: () => node?.onCoreStatus(),
    announceWipe: () => node?.announceWipe(),
    // Dev vault only (vault:build replaces __VAULT_DEV__ with false and drops this).
    ...(__VAULT_DEV__ && { tokenFilter: (t) => knobs!.filter(t) }),
    leading: () => node?.role === "leader",
    onShared: (s) => node?.onShared(s),
    onToken: () => live?.onToken(),
  });
  if (__VAULT_DEV__) knobs = new DevKnobs(core.scheduler, __VAULT_FAKE_EXPIRES_IN__, () => node!.status());
  // One request at a time (rest.ts): a hung one mustn't block the queue forever.
  const restFetch: RestFetch = (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
  const rest = new Rest(restFetch, __VAULT_DEV__ ? knobs!.tokens() : core.scheduler, fake ? `${fake}/v1/` : REST_BASE);
  live = new LiveManager({
    ...timers,
    random: Math.random,
    url: fake ? `${fake.replace(/^http/, "ws")}/mqtt` : MQTT_URL,
    socket: (url, protocols) => new WebSocket(url, protocols) as unknown as SocketLike,
    token: () => core.liveToken(),
    refresh: () => core.scheduler.refresh(),
    rest: (endpoint, params) => rest.get(endpoint, params),
    emit: (batches) => node?.onLiveData(batches),
    onStatus: () => node?.pushStatus(),
  });
  node = new VaultNode({
    core,
    live,
    rest,
    channel,
    locks: (navigator.locks as unknown as LocksLike | undefined) ?? null,
    timers,
    version: __VAULT_VERSION__,
    onStatus: (status) => rpc?.broadcast({ v: 1, type: "event", event: "status", status } satisfies VaultEvent),
    deliver: (batches) => rpc?.deliver(batches),
    ...(__VAULT_DEV__ && { debug: (req) => knobs!.handle(req) }),
  });
  const n = node;

  // Background tabs throttle timers and a sleeping laptop stops them: re-check the clock on the way back.
  // (A follower's scheduler is off: wake() is a no-op there.)
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") core.scheduler.wake("visible");
  });
  window.addEventListener("online", () => core.scheduler.wake("online"));
  window.addEventListener("pagehide", () => n.bye());
  const vault: Vault = {
    status: () => n.status(),
    expect: (kind, ticket) => core.expect(kind, ticket),
    cancel: (ticket) => core.cancel(ticket),
    disconnect: () => n.disconnect(),
    get: (endpoint, params) => n.get(endpoint, params),
    setTopics: (topics) => n.setTopics(topics),
  };
  rpc = new Rpc(vault, __VAULT_DEV__ ? (req) => n.debug(req) : undefined);
  const r = rpc;

  let attached = false;
  const onHello = (e: MessageEvent) => {
    if (attached || !fromParent(e, window.parent, parent, __VAULT_APP_ORIGINS__) || !isHello(e.data, e.ports.length)) return;
    attached = r.attach(e.ports[0]!);
    // One hello per frame: after it, the app's window messages are never looked at again.
    window.removeEventListener("message", onHello);
  };
  window.addEventListener("message", onHello);

  // The popup: only the vault's own origin, only validated shapes, answered only to the sender.
  window.addEventListener("message", (e: MessageEvent) => {
    if (e.origin !== location.origin || !e.source || e.source === window.parent || e.ports.length) return;
    const msg = parsePopupMessage(e.data);
    if (!msg) return;
    const source = e.source;
    void core.popup(msg, source).then(
      (reply) => {
        if (reply) source.postMessage(reply, { targetOrigin: location.origin });
      },
      () => {},
    );
  });

  window.parent.postMessage({ v: 1, type: "ready" } satisfies Ready, parent);
  void n.start();
}
// Otherwise (a top-level visit, or an embedder not on the list): do nothing at all. CSP frame-ancestors
// already stops other sites embedding this page; this check is the second lock.
