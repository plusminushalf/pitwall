// The hidden vault iframe (frame.html). It is the only code that ever holds the OpenF1 login.
//
// Handshake: check the embedding page is an allowlisted app origin, post "ready" to it (that exact
// targetOrigin), take the MessagePort from its "hello", then speak the protocol only over that port.
//
// The setup popup (popup.html, top level on the vault's own origin) can't share this frame's storage:
// Chrome partitions it by the app's site. So the popup posts the login here (`opener.frames[i]`), and this
// frame checks it with OpenF1 and stores it in its own partition. Window messages from the vault's own
// origin are popup messages; core.ts answers only the one it is waiting for (its pending ticket).

import { VaultCore } from "./core";
import { DevKnobs } from "./debug";
import { fromParent, parentOrigin } from "./origins";
import { isHello, parsePopupMessage, type Ready, type VaultEvent } from "./protocol";
import { Rest, type RestFetch } from "./rest";
import { Rpc, type Vault } from "./rpc";
import { IdbStore } from "./storage";

const parent = window.parent !== window ? parentOrigin(location.ancestorOrigins, __VAULT_APP_ORIGINS__) : null;

if (parent) {
  // Frames in other tabs of the same app share this partition (IndexedDB, BroadcastChannel).
  const tabs = new BroadcastChannel("f1-vault");
  let rpc: Rpc | null = null;
  let knobs: DevKnobs | null = null;
  const core = new VaultCore({
    store: new IdbStore(),
    // Dev vault only: /token through the failure injection (debug:failToken).
    fetch: __VAULT_DEV__ ? (url, init) => knobs!.tokenFetch((u, i) => fetch(u, i))(url, init) : (url, init) => fetch(url, init),
    now: Date.now,
    version: __VAULT_VERSION__,
    onStatus: (status) => rpc?.broadcast({ v: 1, type: "event", event: "status", status } satisfies VaultEvent),
    announceWipe: () => tabs.postMessage("wiped"),
    // Dev vault only (vault:build replaces __VAULT_DEV__ with false and drops this).
    ...(__VAULT_DEV__ && { tokenFilter: (t) => knobs!.filter(t) }),
  });
  if (__VAULT_DEV__) knobs = new DevKnobs(core.scheduler, __VAULT_FAKE_EXPIRES_IN__, () => core.status());
  // One request at a time (rest.ts): a hung one mustn't block the queue forever.
  const restFetch: RestFetch = (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
  const rest = new Rest(restFetch, __VAULT_DEV__ ? knobs!.tokens() : core.scheduler);

  // Background tabs throttle timers and a sleeping laptop stops them: re-check the clock on the way back.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") core.scheduler.wake("visible");
  });
  window.addEventListener("online", () => core.scheduler.wake("online"));
  tabs.onmessage = (e) => {
    if (e.data === "wiped") core.wipedElsewhere();
  };
  const vault: Vault = {
    status: () => core.status(),
    expect: (kind, ticket) => core.expect(kind, ticket),
    cancel: (ticket) => core.cancel(ticket),
    disconnect: () => core.disconnect(),
    get: (endpoint, params) => rest.get(endpoint, params),
  };
  rpc = new Rpc(vault, __VAULT_DEV__ ? (req) => knobs!.handle(req) : undefined);

  let attached = false;
  const onHello = (e: MessageEvent) => {
    if (attached || !fromParent(e, window.parent, parent, __VAULT_APP_ORIGINS__) || !isHello(e.data, e.ports.length)) return;
    attached = rpc.attach(e.ports[0]!);
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
  void core.init();
}
// Otherwise (a top-level visit, or an embedder not on the list): do nothing at all. CSP frame-ancestors
// already stops other sites embedding this page; this check is the second lock.
