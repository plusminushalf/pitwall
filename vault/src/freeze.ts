// Dev vault only (debug:freeze; frame.ts uses it behind __VAULT_DEV__, so a build drops it): freeze ONE vault
// frame the way Chrome freezes a background tab. Every way work enters the frame goes through the gate:
// timers, WebSocket (or simulated socket) events, BroadcastChannel and port messages, Web Locks callbacks and
// rejections, fetch answers. While frozen they queue; on thaw they run in the order they arrived. The wall
// clock keeps going, as it does for a frozen tab.
//
// Why not CDP: the vault frames of every tab are same-site, so Chrome runs them in ONE renderer process, and
// Debugger.pause (or a busy loop) stops all of them, leader and followers alike; Page.setWebLifecycleState
// had no effect under Playwright (measured 2026-09-30). A real tab freeze is per page, which this reproduces.

import type { SocketLike } from "./mqtt";
import type { Timers } from "./scheduler";
import type { ChannelLike, LocksLike } from "./tabs";

export class FreezeGate {
  private until = 0;
  private queue: (() => void)[] = [];
  /** Frozen spans so far (for the debug panel and e2e). */
  freezes = 0;

  constructor(private base: Timers) {}

  get frozen() {
    return this.base.now() < this.until;
  }

  /** Freeze for `ms` from now (a new call extends or shortens it). */
  freeze(ms: number) {
    this.until = this.base.now() + ms;
    this.freezes++;
    this.base.setTimeout(() => this.thaw(), ms);
  }

  private thaw() {
    if (this.frozen) return; // extended meanwhile
    this.until = 0;
    while (this.queue.length) {
      const q = this.queue;
      this.queue = [];
      for (const f of q) {
        try {
          f();
        } catch {}
      }
    }
  }

  /** `fn`, deferred to the thaw while frozen. */
  wrap<A extends unknown[]>(fn: (...a: A) => unknown): (...a: A) => void {
    return (...a: A) => {
      if (this.frozen) this.queue.push(() => fn(...a));
      else fn(...a);
    };
  }

  /** A promise that settles like `p`, but not while frozen. */
  hold<T>(p: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      p.then(this.wrap(resolve as (v: T) => void), this.wrap(reject));
    });
  }

  timers(): Timers {
    return { now: this.base.now, setTimeout: (fn, ms) => this.base.setTimeout(this.wrap(fn), ms), clearTimeout: this.base.clearTimeout };
  }

  channel(inner: ChannelLike): ChannelLike {
    const out: ChannelLike = { postMessage: (m) => inner.postMessage(m), onmessage: null };
    inner.onmessage = this.wrap((e: { data: unknown }) => out.onmessage?.(e));
    return out;
  }

  locks(inner: LocksLike): LocksLike {
    return {
      request: (name, options, cb) =>
        this.hold(
          inner.request(name, options, (lock) => {
            if (!this.frozen) return cb(lock);
            // Granted while frozen: hold it (as cb would) and run cb on thaw.
            this.queue.push(() => void cb(lock));
            return lock ? new Promise(() => {}) : undefined;
          }),
        ),
      query: () => this.hold(inner.query()),
    };
  }

  /** A socket whose events wait while frozen. */
  socket(inner: SocketLike): SocketLike {
    const out: SocketLike = {
      get binaryType() {
        return inner.binaryType;
      },
      set binaryType(v: string) {
        inner.binaryType = v;
      },
      send: (d) => inner.send(d),
      close: (code, reason) => inner.close(code, reason),
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
    };
    inner.onopen = this.wrap((e: unknown) => out.onopen?.(e));
    inner.onmessage = this.wrap((e: { data: unknown }) => out.onmessage?.(e));
    inner.onclose = this.wrap((e: { code: number; reason: string }) => out.onclose?.(e));
    inner.onerror = this.wrap((e: unknown) => out.onerror?.(e));
    return out;
  }
}
