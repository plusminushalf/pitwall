// Every tab of the app embeds its own vault frame. They share one storage partition (the vault's origin under
// the app's site), so one BroadcastChannel and one set of Web Locks, and nothing else can join either: this is
// one trust boundary. Among them, one leader (docs/modular-hypotheses.md, H2.10):
//
// - Election: navigator.locks.request(LEADER_LOCK) held for the frame's lifetime. The first frame gets it;
//   the others queue for it, so when the leader's tab closes the next frame in line takes over at once.
// - The leader alone refreshes the token (/token), runs the MQTT stream (for the union of every frame's
//   subscriptions) and spends the REST budget. Followers forward `get` and the dev knobs to it, send it their
//   subscriptions, and get the data and the status over the channel.
// - A login, unlock or disconnect in any frame reaches all of them. The leader shares the login in memory
//   (the decrypted secret and the current token: `Shared`) with the followers over the channel, never to the
//   app and never to storage, so a follower that takes over continues without a passkey tap or an immediate
//   /token. It also continues the stream: new session, REST gap-fill from the lastSeen it tracked from the
//   data it was forwarded, deduped against what was already delivered.
// - Each frame also holds its own lock (FRAME_LOCK + id): the leader lists them to forget the subscriptions
//   of frames that have gone.
//
// Pure apart from what's injected (channel, locks, timers), so bun tests run several frames against fakes.

import type { Shared, VaultCore } from "./core";
import type { Batch, LiveManager, LiveSnapshot } from "./live";
import type { DebugMethod, GetResult, LiveTopic, Params, Request, RestEndpoint, StreamPhase, VaultStatus } from "./protocol";
import { RestError } from "./rest";
import type { Timers } from "./scheduler";

export const CHANNEL = "f1-vault";
export const LEADER_LOCK = "f1-vault-leader";
export const FRAME_LOCK = "f1-vault-frame:";
/** How often the leader lists the frame locks to drop the subscriptions of closed tabs. */
export const PRUNE_MS = 5_000;
export const FORWARD_TIMEOUT_MS = 35_000;
/** After a takeover, the old leader's topics are kept this long, until every follower has re-sent its own. */
export const PROVISIONAL_MS = 3_000;

export type ChannelLike = { postMessage(m: unknown): void; onmessage: ((e: { data: unknown }) => void) | null };
export type LocksLike = {
  request(name: string, options: { ifAvailable?: boolean }, cb: (lock: unknown) => unknown): Promise<unknown>;
  query(): Promise<{ held?: { name?: string }[] }>;
};

type Forward = { type: "get"; endpoint: RestEndpoint; params: Params } | { type: "debug"; req: Request<DebugMethod> };

/** Messages between vault frames. `from` is the sender's id; `to` addresses one frame. */
export type TabMsg =
  | { k: "hello"; from: string }
  | { k: "sync"; from: string; to: string; status: VaultStatus; shared: Shared | null; live: LiveSnapshot }
  | { k: "leader"; from: string }
  | { k: "status"; from: string; status: VaultStatus }
  | { k: "shared"; from: string; shared: Shared }
  | { k: "login"; from: string; shared: Shared }
  | { k: "wiped"; from: string }
  | { k: "subs"; from: string; topics: LiveTopic[] }
  | { k: "data"; from: string; batches: Batch[] }
  | { k: "req"; from: string; id: number; req: Forward }
  | { k: "res"; from: string; to: string; id: number; ok: true; result: unknown }
  | { k: "res"; from: string; to: string; id: number; ok: false; code: "network" | "internal" }
  | { k: "bye"; from: string };

export type NodeDeps = {
  core: VaultCore;
  live: LiveManager;
  rest: { get(endpoint: RestEndpoint, params: Params): Promise<GetResult> };
  channel: ChannelLike;
  /** null: no Web Locks (then every frame leads on its own). */
  locks: LocksLike | null;
  timers: Timers;
  version: string;
  /** This frame's status changed: push it to its app (rpc.broadcast). */
  onStatus(s: VaultStatus): void;
  /** Live data for this frame's app (rpc.deliver: each port gets its topics). */
  deliver(batches: Batch[]): void;
  /** The dev knobs (leader's; dev vault only). */
  debug?: (req: Request<DebugMethod>) => Promise<unknown>;
  id?: string;
};

export const newId = () => [...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, "0")).join("");

const livePhase = (p: StreamPhase): VaultStatus["live"] => (p === "connected" || p === "handover" || p === "gap-filling" ? "on" : p === "off" || p === "waiting" ? "off" : "connecting");

export class VaultNode {
  readonly id: string;
  role: "leader" | "follower" = "follower";
  leaderId: string | null = null;
  /** Follower: the leader's last status. */
  private mirror: VaultStatus | null = null;
  /** Follower: the login the leader shares (for a takeover). */
  private shared: Shared | null = null;
  private localTopics: LiveTopic[] = [];
  /** Leader: each follower's subscriptions. */
  private followerSubs = new Map<string, LiveTopic[]>();
  private provisional: LiveTopic[] = [];
  private frames = 1;
  private pending = new Map<number, { req: Forward; resolve: (r: unknown) => void; reject: (e: Error) => void; timer: unknown }>();
  private nextReq = 1;
  private initDone!: Promise<void>;
  private initResolve!: () => void;
  private pruneTimer: unknown = null;

  constructor(private deps: NodeDeps) {
    this.id = deps.id ?? newId();
    this.initDone = new Promise((r) => (this.initResolve = r));
  }

  /** Join: take the lead if nobody has it, else follow (and queue to take over). */
  async start(): Promise<void> {
    this.deps.channel.onmessage = (e) => this.onMessage(e.data);
    const locks = this.deps.locks;
    if (!locks) return this.lead(false);
    void this.hold(FRAME_LOCK + this.id, {});
    if (await this.hold(LEADER_LOCK, { ifAvailable: true })) return this.lead(false);
    this.send({ k: "hello", from: this.id });
    void this.hold(LEADER_LOCK, {}).then(() => this.lead(true));
  }

  /** The tab is going away: the leader forgets this frame's subscriptions now rather than at the next prune. */
  bye() {
    this.send({ k: "bye", from: this.id });
  }

  // ---------------------------------------------------------------- what the app's requests call

  status(): VaultStatus {
    if (this.role === "leader") {
      const stream = this.deps.live.status();
      return { ...this.deps.core.status(), live: livePhase(stream.phase), stream, tab: { role: "leader", id: this.id, leader: this.id, frames: this.frames } };
    }
    const tab = { role: "follower" as const, id: this.id, leader: this.leaderId };
    return this.mirror ? { ...this.mirror, tab } : { state: "connecting", live: "off", version: this.deps.version, tab };
  }

  /** This frame's app subscriptions (the union of its ports). */
  setTopics(topics: LiveTopic[]) {
    this.localTopics = topics;
    if (this.role === "leader") this.updateTopics();
    else this.send({ k: "subs", from: this.id, topics });
  }

  get(endpoint: RestEndpoint, params: Params): Promise<GetResult> {
    if (this.role === "leader") return this.deps.rest.get(endpoint, params);
    return this.forward({ type: "get", endpoint, params }) as Promise<GetResult>;
  }

  async debug(req: Request<DebugMethod>): Promise<unknown> {
    if (this.role === "leader") return this.deps.debug?.(req);
    await this.forward({ type: "debug", req });
    return this.status();
  }

  /** Wipe storage and memory here; core announces it (announceWipe) and every other frame follows. */
  async disconnect(): Promise<VaultStatus> {
    await this.deps.core.disconnect();
    this.wiped();
    return this.status();
  }

  // ---------------------------------------------------------------- core and live call these

  /** Core's status changed. A follower's own core state is not what its app sees (the leader's is). */
  onCoreStatus() {
    if (this.role === "leader") this.pushStatus();
  }

  /** Core has a login with a new token (a login or unlock here, a refresh on the leader). */
  onShared(s: Shared) {
    if (this.role === "leader") return this.send({ k: "shared", from: this.id, shared: s });
    // A popup login or unlock in this (follower) tab: the leader takes it from here.
    this.shared = s;
    this.send({ k: "login", from: this.id, shared: s });
  }

  /** Core wiped storage: tell everyone. */
  announceWipe() {
    this.send({ k: "wiped", from: this.id });
  }

  /** Leader: deduped, ordered live data from the stream. */
  onLiveData(batches: Batch[]) {
    this.deps.deliver(batches);
    this.send({ k: "data", from: this.id, batches });
  }

  /** Leader: push this frame's status to its app and to the followers. */
  pushStatus() {
    if (this.role !== "leader") return;
    const s = this.status();
    this.deps.onStatus(s);
    this.send({ k: "status", from: this.id, status: s });
  }

  // ---------------------------------------------------------------- internals

  private send(m: TabMsg) {
    try {
      this.deps.channel.postMessage(m);
    } catch {
      // (a closed channel: the frame is going away)
    }
  }

  /** Request a lock and keep it for the frame's lifetime. Resolves true once held, false if not available. */
  private hold(name: string, opts: { ifAvailable?: boolean }): Promise<boolean> {
    return new Promise((resolve) => {
      void this.deps.locks!.request(name, opts, (lock) => {
        if (!lock) return resolve(false);
        resolve(true);
        return new Promise(() => {});
      });
    });
  }

  private async lead(takeover: boolean) {
    if (this.role === "leader") return;
    this.role = "leader";
    this.leaderId = this.id;
    this.send({ k: "leader", from: this.id });
    if (takeover) {
      // Keep streaming what the old leader streamed until the followers have re-announced their topics.
      this.provisional = this.mirror?.stream?.topics ?? [];
      this.deps.timers.setTimeout(() => {
        this.provisional = [];
        this.updateTopics();
      }, PROVISIONAL_MS);
      if (this.mirror?.stream) this.deps.live.state.merge({ lastSeen: {}, since: this.mirror.stream.since, sessionKey: null, seen: {} });
    }
    const shared = this.shared;
    this.shared = null;
    if (takeover && shared) this.deps.core.adoptShared(shared);
    else await this.deps.core.init();
    this.initResolve();
    this.updateTopics();
    this.deps.live.start({ gap: takeover });
    // Requests that were waiting for the old leader: ours now.
    for (const [id, p] of this.pending) {
      this.deps.timers.clearTimeout(p.timer);
      this.pending.delete(id);
      this.runLocal(p.req).then(p.resolve, p.reject);
    }
    this.prune();
    this.pushStatus();
  }

  private union(): LiveTopic[] {
    const all = new Set<LiveTopic>([...this.localTopics, ...this.provisional]);
    for (const t of this.followerSubs.values()) for (const x of t) all.add(x);
    return [...all].sort();
  }

  private updateTopics() {
    if (this.role !== "leader") return;
    this.deps.live.setTopics(this.union());
  }

  /** Drop the subscriptions of frames whose lock is gone (their tab closed); count the live ones. */
  private prune() {
    if (this.pruneTimer !== null) this.deps.timers.clearTimeout(this.pruneTimer);
    this.pruneTimer = this.deps.timers.setTimeout(() => this.prune(), PRUNE_MS);
    const locks = this.deps.locks;
    if (!locks) return;
    void locks.query().then(
      (q) => {
        const alive = new Set((q.held ?? []).map((l) => l.name ?? "").filter((n) => n.startsWith(FRAME_LOCK)).map((n) => n.slice(FRAME_LOCK.length)));
        let changed = false;
        for (const id of this.followerSubs.keys()) if (!alive.has(id)) changed = this.followerSubs.delete(id) || changed;
        const frames = Math.max(1, alive.size);
        if (frames !== this.frames || changed) {
          this.frames = frames;
          if (changed) this.updateTopics();
          this.pushStatus();
        }
      },
      () => {},
    );
  }

  private forward(req: Forward): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = this.nextReq++;
      const timer = this.deps.timers.setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("the leader frame didn't answer"));
      }, FORWARD_TIMEOUT_MS);
      this.pending.set(id, { req, resolve, reject, timer });
      this.send({ k: "req", from: this.id, id, req });
    });
  }

  private runLocal(req: Forward): Promise<unknown> {
    if (req.type === "get") return this.deps.rest.get(req.endpoint, req.params);
    return this.deps.debug ? this.deps.debug(req.req) : Promise.reject(new Error("no debug"));
  }

  /** Storage was wiped (here or elsewhere): drop the login, the stream and what was delivered. */
  private wiped() {
    this.shared = null;
    if (this.role === "leader") {
      this.deps.live.stop({ reset: true });
      this.pushStatus();
    } else {
      this.deps.live.state.reset();
      const { version } = this.deps;
      this.mirror = { state: "disconnected", live: "off", version, ...(this.mirror?.stream && { stream: { ...this.mirror.stream, phase: "off", sessions: 0 } }) };
      this.deps.onStatus(this.status());
    }
  }

  private onMessage(data: unknown) {
    if (!data || typeof data !== "object" || typeof (data as TabMsg).k !== "string" || typeof (data as TabMsg).from !== "string") return;
    const m = data as TabMsg;
    if (m.from === this.id) return;
    if (this.role === "leader") return void this.onLeaderMessage(m);
    this.onFollowerMessage(m);
  }

  private async onLeaderMessage(m: TabMsg) {
    switch (m.k) {
      case "hello":
        await this.initDone;
        return this.send({ k: "sync", from: this.id, to: m.from, status: this.status(), shared: this.deps.core.sharedLogin(), live: this.deps.live.state.snapshot() });
      case "subs":
        this.followerSubs.set(m.from, m.topics);
        this.updateTopics();
        return;
      case "bye":
        if (this.followerSubs.delete(m.from)) this.updateTopics();
        return;
      case "login":
        await this.initDone;
        return this.deps.core.adoptShared(m.shared);
      case "wiped":
        this.deps.core.wipedElsewhere();
        return this.wiped();
      case "req": {
        await this.initDone;
        const reply = (r: { ok: true; result: unknown } | { ok: false; code: "network" | "internal" }) => this.send({ k: "res", from: this.id, to: m.from, id: m.id, ...r });
        return this.runLocal(m.req).then(
          (result) => reply({ ok: true, result }),
          (e) => reply({ ok: false, code: e instanceof RestError ? "network" : "internal" }),
        );
      }
    }
  }

  private onFollowerMessage(m: TabMsg) {
    switch (m.k) {
      case "leader":
        // A new leader (a takeover, or the first one after we joined): announce ourselves again.
        this.leaderId = m.from;
        this.send({ k: "hello", from: this.id });
        this.send({ k: "subs", from: this.id, topics: this.localTopics });
        for (const [id, p] of this.pending) this.send({ k: "req", from: this.id, id, req: p.req });
        return;
      case "sync":
        if (m.to !== this.id) return;
        this.leaderId = m.from;
        this.shared = m.shared;
        this.deps.live.state.merge(m.live);
        this.setMirror(m.status);
        this.send({ k: "subs", from: this.id, topics: this.localTopics });
        return;
      case "status":
        this.leaderId = m.from;
        return this.setMirror(m.status);
      case "shared":
        this.shared = m.shared;
        return;
      case "data": {
        const mine: Batch[] = [];
        for (const b of m.batches) {
          const fresh = b.messages.filter((msg) => this.deps.live.state.accept(b.topic, msg));
          if (fresh.length) mine.push({ topic: b.topic, messages: fresh });
        }
        if (mine.length) this.deps.deliver(mine);
        return;
      }
      case "res": {
        if (m.to !== this.id) return;
        const p = this.pending.get(m.id);
        if (!p) return;
        this.pending.delete(m.id);
        this.deps.timers.clearTimeout(p.timer);
        if (m.ok) p.resolve(m.result);
        else p.reject(m.code === "network" ? new RestError("network") : new Error("internal"));
        return;
      }
      case "wiped":
        this.deps.core.wipedElsewhere();
        return this.wiped();
    }
  }

  private setMirror(s: VaultStatus) {
    const { tab, ...rest } = s;
    this.mirror = rest;
    this.deps.core.mirror(rest);
    if (rest.stream) this.deps.live.state.merge({ lastSeen: {}, since: rest.stream.since, sessionKey: null, seen: {} });
    this.deps.onStatus(this.status());
  }
}
