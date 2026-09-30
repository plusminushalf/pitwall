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

import { Budget } from "./budget";
import { VaultCore } from "./core";
import { DevKnobs } from "./debug";
import { FreezeGate } from "./freeze";
import { LiveManager, MQTT_URL } from "./live";
import type { SocketLike } from "./mqtt";
import { TOKEN_URL } from "./openf1";
import { fromParent, parentOrigin } from "./origins";
import { isHello, parsePopupMessage, type Ready, type VaultEvent, type VaultStatus } from "./protocol";
import { REST_BASE, Rest, type RestFetch, type TokenSource } from "./rest";
import { Rpc, type PortLike, type Vault } from "./rpc";
import type { Timers } from "./scheduler";
import { SimBroker, loadSimConfig } from "./sim";
import { IdbStore } from "./storage";
import { CHANNEL, VaultNode, type ChannelLike, type LocksLike } from "./tabs";

const parent = window.parent !== window ? parentOrigin(location.ancestorOrigins, __VAULT_APP_ORIGINS__) : null;

if (parent) void boot(parent);
// Otherwise (a top-level visit, or an embedder not on the list): do nothing at all. CSP frame-ancestors
// already stops other sites embedding this page; this check is the second lock.

async function boot(parent: string) {
  // Dev vault only: simulate mode (VAULT_SIMULATE). Its config (the shared sim clock) comes from the dev
  // server first; if that fails the frame stays silent, like a vault that didn't load.
  const simBase = __VAULT_DEV__ && __VAULT_SIMULATE__ ? `${location.origin}/__sim` : "";
  const simConfig = __VAULT_DEV__ && __VAULT_SIMULATE__ ? await loadSimConfig(simBase).catch(() => null) : null;
  if (__VAULT_DEV__ && __VAULT_SIMULATE__ && !simConfig) return;
  const realTimers: Timers = { now: Date.now, setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) };
  // Dev vault only: debug:freeze (freeze.ts). Everything that enters the frame goes through the gate.
  const gate = __VAULT_DEV__ ? new FreezeGate(realTimers) : null;
  const timers: Timers = gate ? gate.timers() : realTimers;
  const gated = <A extends unknown[]>(fn: (...a: A) => unknown): ((...a: A) => void) => (gate ? gate.wrap(fn) : (...a: A) => void fn(...a));
  const gFetch: typeof fetch = gate ? (input, init) => gate.hold(fetch(input, init)) : (input, init) => fetch(input, init);
  // Frames in other tabs of the same app share this partition (IndexedDB, BroadcastChannel, Web Locks).
  const bc = new BroadcastChannel(CHANNEL);
  const raw: ChannelLike = { postMessage: (m) => bc.postMessage(m), onmessage: null };
  bc.onmessage = (e) => raw.onmessage?.(e);
  const channel = gate ? gate.channel(raw) : raw;
  // Dev vault only: the local fake broker (VAULT_FAKE_BROKER). A build has "" here, so the real OpenF1 URLs.
  const fake = __VAULT_DEV__ ? __VAULT_FAKE_BROKER__ : "";
  const sim = __VAULT_DEV__ && simConfig ? new SimBroker({ base: simBase, config: simConfig, timers, fetch: gFetch }) : null;
  let rpc: Rpc | null = null;
  let knobs: DevKnobs | null = null;
  let node: VaultNode | null = null;
  let live: LiveManager | null = null;
  const tokenFetch = (url: string, init: RequestInit) => gFetch(sim && url === TOKEN_URL ? `${simBase}/token` : url, init);
  const core = new VaultCore({
    // Simulate mode keeps its (fake) login apart from the real one.
    store: new IdbStore(sim ? "f1-vault-sim" : undefined),
    // Dev vault only: /token through the failure injection (debug:failToken), and to the simulation's /token.
    fetch: __VAULT_DEV__ ? (url, init) => knobs!.tokenFetch((u, i) => tokenFetch(u, i))(url, init) : (url, init) => fetch(url, init),
    now: Date.now,
    ...(gate && { setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout }),
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
  // Requests in parallel within one budget (budget.ts: OpenF1's rate limits, priorities, fairness), each with a
  // timeout so a hung one frees its slot.
  const restFetch: RestFetch = (url, { timeoutMs, ...init }) => gFetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  const tokens: TokenSource = __VAULT_DEV__ ? knobs!.tokens() : core.scheduler;
  const budget = new Budget({ ...timers, random: Math.random, authenticated: () => tokens.current() !== null, onChange: () => node?.budgetChanged() });
  const rest = new Rest(restFetch, tokens, sim ? `${simBase}/v1/` : fake ? `${fake}/v1/` : REST_BASE, budget);
  const socket = (url: string, protocols: string[]): SocketLike => {
    const s = sim ? sim.socket(url, protocols) : (new WebSocket(url, protocols) as unknown as SocketLike);
    return gate ? gate.socket(s) : s;
  };
  const locks = (navigator.locks as unknown as LocksLike | undefined) ?? null;
  live = new LiveManager({
    ...timers,
    random: Math.random,
    url: fake ? `${fake.replace(/^http/, "ws")}/mqtt` : MQTT_URL,
    socket,
    token: () => core.liveToken(),
    refresh: () => core.scheduler.refresh(),
    // Gap-fills: first in the budget, and a shorter timeout (the stream waits for them).
    rest: (endpoint, params) => rest.get(endpoint, params, { caller: "live", priority: "live", timeoutMs: 30_000 }),
    emit: (batches) => node?.onLiveData(batches),
    onStatus: () => node?.pushStatus(),
    lease: { ok: () => node!.leaseOk(), verify: () => node!.verify() },
  });
  // Dev vault only: this frame's own status additions (simulate mode, freezes).
  const withDev = (s: VaultStatus): VaultStatus => (sim ? { ...s, sim: sim.status() } : s);
  node = new VaultNode({
    core,
    live,
    rest,
    budget,
    channel,
    locks: gate && locks ? gate.locks(locks) : locks,
    timers,
    version: __VAULT_VERSION__,
    onStatus: (status) => rpc?.broadcast({ v: 1, type: "event", event: "status", status: withDev(status) } satisfies VaultEvent),
    deliver: (batches) => rpc?.deliver(batches),
    visible: () => document.visibilityState === "visible",
    ...(__VAULT_DEV__ && { debug: (req) => knobs!.handle(req) }),
  });
  const n = node;

  // Background tabs throttle timers and a sleeping laptop stops them: re-check the clock on the way back.
  // (A follower's scheduler is off: wake() is a no-op there.)
  document.addEventListener(
    "visibilitychange",
    gated(() => {
      if (document.visibilityState === "visible") core.scheduler.wake("visible");
    }),
  );
  window.addEventListener(
    "online",
    gated(() => core.scheduler.wake("online")),
  );
  window.addEventListener("pagehide", () => {
    n.bye();
    sim?.bye();
  });
  const vault: Vault = {
    status: () => withDev(n.status()),
    // (The frame's whole status, not core's: the app keeps the last status it was given, and core's has no tab or stream.)
    expect: (kind, ticket) => {
      const r = core.expect(kind, ticket);
      return r.ok ? { ok: true, status: withDev(n.status()) } : r;
    },
    cancel: (ticket) => (core.cancel(ticket), withDev(n.status())),
    disconnect: () => n.disconnect(),
    get: (endpoint, params, caller) => n.get(endpoint, params, caller),
    dropCaller: (caller) => n.dropCaller(caller),
    setTopics: (topics) => n.setTopics(topics),
  };
  rpc = new Rpc(
    vault,
    __VAULT_DEV__
      ? async (req) => {
          // These two act on this frame (not the leader): freeze it, or a fault at the simulated broker.
          if (req.type === "debug:freeze") {
            realTimers.setTimeout(() => gate!.freeze(req.ms), 0); // after this answer has gone
            return vault.status();
          }
          if (req.type === "debug:sim") {
            if (sim) await sim.control(req.action);
            return vault.status();
          }
          return n.debug(req);
        }
      : undefined,
  );
  const r = rpc;
  // Dev vault only: the app's port goes through the freeze gate too.
  const gatedPort = (p: MessagePort): PortLike =>
    gate
      ? {
          postMessage: (m, t) => p.postMessage(m, t ?? []),
          addEventListener: (type, l) => p.addEventListener(type, gated(l as (e: MessageEvent) => void)),
          start: () => p.start(),
        }
      : p;

  let attached = false;
  const onHello = (e: MessageEvent) => {
    if (attached || !fromParent(e, window.parent, parent, __VAULT_APP_ORIGINS__) || !isHello(e.data, e.ports.length)) return;
    attached = r.attach(gatedPort(e.ports[0]!), { main: true });
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
