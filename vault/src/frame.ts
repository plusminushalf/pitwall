// The hidden vault iframe (frame.html). It is the only code that will ever hold the OpenF1 login.
//
// Handshake: check the embedding page is an allowlisted app origin, post "ready" to it (that exact
// targetOrigin), take the MessagePort from its "hello", then speak only over that port.

import { fromParent, parentOrigin } from "./origins";
import { isHello, type Ready, type VaultStatus } from "./protocol";
import { Rpc } from "./rpc";

const status = (): VaultStatus => ({ account: "none", storage: null, live: "off", version: __VAULT_VERSION__ });

const parent = window.parent !== window ? parentOrigin(location.ancestorOrigins, __VAULT_APP_ORIGINS__) : null;

if (parent) {
  const rpc = new Rpc({ status });
  let attached = false;
  const onHello = (e: MessageEvent) => {
    if (attached || !fromParent(e, window.parent, parent, __VAULT_APP_ORIGINS__) || !isHello(e.data, e.ports.length)) return;
    attached = rpc.attach(e.ports[0]!);
    // One hello per frame: after it, window messages are never looked at again.
    window.removeEventListener("message", onHello);
  };
  window.addEventListener("message", onHello);
  window.parent.postMessage({ v: 1, type: "ready" } satisfies Ready, parent);
}
// Otherwise (a top-level visit, or an embedder not on the list): do nothing at all. CSP frame-ancestors
// already stops other sites embedding this page; this check is the second lock.
