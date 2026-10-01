// The vault client (client.ts) on a fake page: the iframe, its parent with a MutationObserver, and a vault
// frame behind a real MessageChannel. What happens when something else on the page removes the iframe.

import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import type { VaultStatus } from "../../vault/src/protocol";
import { VaultClient, VaultRequestError, type VaultPhase } from "./client";

const ORIGIN = "https://vault.test";
const STATUS: VaultStatus = { state: "disconnected", live: "off", version: "t" };

type Req = { v: 1; id: number; type: string; ticket?: string; topics?: string[] };
type Mutation = { addedNodes: unknown[]; removedNodes: unknown[] };

/** One load of frame.html: takes the hello's port, answers the protocol, until its iframe is removed. */
class FakeFrame {
  readonly requests: Req[] = [];
  private port: MessagePort | null = null;
  constructor(private hang: (type: string) => boolean) {}
  /** The iframe's contentWindow: the app's hello arrives here. */
  postMessage(msg: { type?: string }, origin: string, transfer: MessagePort[] = []) {
    if (msg.type !== "hello" || origin !== ORIGIN || transfer.length !== 1) return;
    this.port = transfer[0]!;
    this.port.onmessage = (e) => this.answer(e.data as Req);
  }
  private answer(req: Req) {
    this.requests.push(req);
    if (this.hang(req.type)) return;
    const result = req.type === "subscribe" || req.type === "unsubscribe" ? { topics: req.topics } : STATUS;
    this.port?.postMessage({ v: 1, id: req.id, ok: true, result });
  }
  unload() {
    this.port?.close();
    this.port = null;
  }
  types = () => this.requests.map((r) => r.type);
}

class FakeObserver {
  private target: FakeBody | null = null;
  private records: Mutation[] = [];
  constructor(private cb: (records: Mutation[]) => void) {}
  observe(target: FakeBody) {
    this.target = target;
    target.observers.add(this);
  }
  disconnect() {
    this.target?.observers.delete(this);
    this.records = [];
  }
  /** Delivered in a microtask, batched, like the real one. */
  queue(r: Mutation) {
    if (!this.records.length)
      queueMicrotask(() => {
        const rs = this.records;
        this.records = [];
        if (rs.length) this.cb(rs);
      });
    this.records.push(r);
  }
}

class FakeIframe {
  src = "";
  hidden = false;
  tabIndex = 0;
  title = "";
  referrerPolicy = "";
  parent: FakeBody | null = null;
  contentWindow: FakeFrame | null = null;
  setAttribute() {}
  addEventListener() {}
  get isConnected() {
    return this.parent !== null;
  }
  remove() {
    this.parent?.removeChild(this);
  }
}

class FakeBody {
  observers = new Set<FakeObserver>();
  children: FakeIframe[] = [];
  constructor(private onMount: (f: FakeIframe) => void) {}
  append(f: FakeIframe) {
    f.parent = this;
    this.children.push(f);
    for (const o of this.observers) o.queue({ addedNodes: [f], removedNodes: [] });
    this.onMount(f);
  }
  /** `notify: false`: gone without a mutation on this parent (say the parent itself was replaced). */
  removeChild(f: FakeIframe, notify = true) {
    this.children = this.children.filter((c) => c !== f);
    f.parent = null;
    f.contentWindow?.unload();
    if (notify) for (const o of this.observers) o.queue({ addedNodes: [], removedNodes: [f] });
  }
}

const saved = new Map(["window", "document", "MutationObserver"].map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
afterEach(() => {
  for (const [k, d] of saved) {
    if (d) Object.defineProperty(globalThis, k, d);
    else delete (globalThis as { [k: string]: unknown })[k];
  }
  setSystemTime();
});

/** The page: every mounted iframe gets a new FakeFrame, which says "ready" a moment later. */
function fakePage(opts: { hang?: (type: string) => boolean; onMount?: (f: FakeIframe) => void } = {}) {
  const frames: FakeFrame[] = [];
  const opened: string[] = [];
  const listeners = new Set<(e: unknown) => void>();
  const body = new FakeBody((iframe) => {
    const frame = new FakeFrame(opts.hang ?? (() => false));
    frames.push(frame);
    iframe.contentWindow = frame;
    opts.onMount?.(iframe);
    setTimeout(() => {
      if (iframe.isConnected) for (const fn of [...listeners]) fn({ source: frame, origin: ORIGIN, data: { v: 1, type: "ready" } });
    }, 1);
  });
  const popup = { closed: false, focus() {} };
  const g = globalThis as { [k: string]: unknown };
  g.window = {
    addEventListener: (type: string, fn: (e: unknown) => void) => type === "message" && listeners.add(fn),
    removeEventListener: (_: string, fn: (e: unknown) => void) => listeners.delete(fn),
    open: (url: string) => (opened.push(url), popup),
    screenX: 0,
    screenY: 0,
    outerWidth: 1280,
    outerHeight: 800,
  };
  g.document = { createElement: () => new FakeIframe(), body };
  g.MutationObserver = FakeObserver;
  const vault = new VaultClient(ORIGIN);
  const phases: VaultPhase[] = [];
  vault.onState((s) => phases.push(s.phase));
  return { vault, body, frames, opened, popup, phases, iframe: () => body.children[0]! };
}

async function until(cond: () => boolean, ms = 1000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 1));
  }
}
const ticketOf = (url: string) => new URLSearchParams(url.split("#")[1]).get("ticket") ?? undefined;
/** The promise's outcome, or "pending" if it hasn't settled within `ms`. */
const within = <T,>(p: Promise<T>, ms: number) => Promise.race([p.then((v) => ({ v }), (e: unknown) => ({ e })), new Promise<"pending">((r) => setTimeout(() => r("pending"), ms))]);

describe("the vault iframe removed from the page", () => {
  test("is noticed and mounted again with a fresh handshake; calls go to the new frame", async () => {
    const x = fakePage();
    await x.vault.start();
    await until(() => x.vault.getState().status !== undefined);
    const first = x.iframe();
    const before = x.phases.length;
    first.remove();
    await until(() => x.frames.length === 2 && x.vault.getState().handshakeMs !== undefined && x.frames[1]!.types().includes("status"));
    expect(x.body.children).toHaveLength(1);
    expect(x.iframe()).not.toBe(first);
    expect(x.vault.getState().remounts).toBe(1);
    expect((await x.vault.status()).state).toBe("disconnected");
    expect(x.frames[1]!.types()).toEqual(["status", "status"]);
    // No flicker: still "ready", with the last status, while the new frame loaded.
    expect(x.phases.slice(before).every((p) => p === "ready")).toBe(true);
    expect(x.vault.getState().status).toEqual(STATUS);
  });

  test("requests pending on the removed frame are rejected at once, not after the 30 s timeout", async () => {
    const x = fakePage({ hang: (type) => type === "get" });
    await x.vault.start();
    const got = x.vault.get("laps", { session_key: 1 });
    await until(() => x.frames[0]!.types().includes("get"));
    x.iframe().remove();
    const r = await within(got, 100);
    expect(r).not.toBe("pending");
    const e = (r as { e: unknown }).e;
    expect(e).toBeInstanceOf(VaultRequestError);
    expect((e as VaultRequestError).code).toBe("unavailable");
    expect((e as Error).message).toBe("the vault was removed from the page; try again");
    // A call made meanwhile waits for the new frame.
    expect((await x.vault.status()).state).toBe("disconnected");
    expect(x.frames).toHaveLength(2);
  });

  test("removed unnoticed, then Connect: the popup opens in the click, and connect goes to the new frame", async () => {
    const x = fakePage();
    await x.vault.start();
    x.body.removeChild(x.iframe(), false);
    const done = x.vault.connect();
    // Synchronously, in the click: the popup is open and the new frame mounted before any await.
    expect(x.opened).toHaveLength(1);
    expect(x.frames).toHaveLength(2);
    expect(x.vault.getState().popup).toBe("connect");
    expect(await done).toEqual(STATUS);
    const connects = x.frames[1]!.requests.filter((r) => r.type === "connect");
    expect(connects.map((r) => r.ticket)).toEqual([ticketOf(x.opened[0]!)]);
    expect(x.frames[0]!.types()).not.toContain("connect");
    expect(x.vault.getState().actionError).toBeUndefined();
  });

  test("a new frame gets the open popup's ticket and this tab's live topics again, once", async () => {
    const x = fakePage();
    await x.vault.start();
    await x.vault.subscribe(["laps", "position"]);
    await x.vault.connect();
    x.iframe().remove();
    await until(() => x.frames.length === 2 && x.frames[1]!.types().filter((t) => t !== "status").length >= 2);
    await new Promise((r) => setTimeout(r, 20));
    const next = x.frames[1]!.requests.filter((r) => r.type !== "status");
    expect(next.map((r) => [r.type, r.ticket ?? r.topics])).toEqual([
      ["subscribe", ["laps", "position"]],
      ["connect", ticketOf(x.opened[0]!)],
    ]);
    // Once the popup is closed, a later frame isn't given its ticket.
    x.popup.closed = true;
    await until(() => x.frames[1]!.types().includes("cancel"), 2000);
    x.iframe().remove();
    await until(() => x.frames.length === 3 && x.frames[2]!.types().includes("subscribe"));
    await new Promise((r) => setTimeout(r, 20));
    expect(x.frames[2]!.types()).not.toContain("connect");
  });

  test("two Connect clicks while the frame is gone: the new frame expects the second ticket only", async () => {
    const x = fakePage();
    await x.vault.start();
    x.body.removeChild(x.iframe(), false);
    const a = x.vault.connect();
    const b = x.vault.connect();
    await Promise.all([a, b]);
    expect(x.opened).toHaveLength(2);
    expect(x.frames).toHaveLength(2);
    expect(x.frames[1]!.requests.filter((r) => r.type === "connect").map((r) => r.ticket)).toEqual([ticketOf(x.opened[1]!)]);
  });

  test("removed before it answered (first handshake): another frame is mounted, and calls wait for it", async () => {
    let n = 0;
    const x = fakePage({ onMount: (f) => void (n++ === 0 && queueMicrotask(() => f.remove())) });
    const status = x.vault.status();
    expect((await status).state).toBe("disconnected");
    expect(x.frames).toHaveLength(2);
    expect(x.vault.getState()).toMatchObject({ phase: "ready", remounts: 1 });
  });

  test("something that removes every frame: a few re-mounts, then unavailable, no loop", async () => {
    const x = fakePage({ onMount: (f) => queueMicrotask(() => f.remove()) });
    await x.vault.start();
    await new Promise((r) => setTimeout(r, 50));
    // The first frame and three re-mounts.
    expect(x.frames).toHaveLength(4);
    expect(x.body.children).toHaveLength(0);
    expect(x.vault.getState()).toMatchObject({ phase: "unavailable", reason: "something on this page keeps removing the vault (a browser extension?)", remounts: 3 });
    const e = await x.vault.status().catch((e: unknown) => e);
    expect(e).toBeInstanceOf(VaultRequestError);
    expect((e as Error).message).toBe("something on this page keeps removing the vault (a browser extension?)");
    // Connect doesn't open a popup that couldn't reach anything.
    expect(await x.vault.connect()).toBeNull();
    expect(x.opened).toHaveLength(0);
    expect(x.frames).toHaveLength(4);
  });

  test("the cap is per minute: removals spread out keep being re-mounted", async () => {
    const t0 = Date.now();
    setSystemTime(t0);
    const x = fakePage();
    await x.vault.start();
    const removeAndWait = async () => {
      const n = x.frames.length;
      x.iframe().remove();
      await until(() => x.frames.length === n + 1 && x.vault.getState().phase === "ready" && x.frames[n]!.types().includes("status"));
    };
    for (let i = 0; i < 3; i++) await removeAndWait();
    setSystemTime(t0 + 61_000);
    for (let i = 0; i < 3; i++) await removeAndWait();
    expect(x.vault.getState()).toMatchObject({ phase: "ready", remounts: 6 });
    // A fourth within that minute is one too many.
    x.iframe().remove();
    await until(() => x.vault.getState().phase === "unavailable");
    expect(x.frames).toHaveLength(7);
  });
});
