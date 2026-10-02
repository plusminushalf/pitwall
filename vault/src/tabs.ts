// Every tab of the app embeds its own vault frame. They share one storage partition (the vault's origin under
// the app's site), so one BroadcastChannel and one set of Web Locks, and nothing else can join either: this is
// one trust boundary. Among them, one leader (docs/hypotheses.md, H2.10):
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
// - A frozen or throttled leader tab must not stall the others. The leader sends a heartbeat every
//   HEARTBEAT_MS (and its data and status count too); a *visible* follower that hears nothing from it for
//   TAKEOVER_MS takes the lock with `steal: true` and leads (a new session, gap-fill from its lastSeen). The old
//   leader, when it wakes, must not emit anything from its stale session: it holds a lease that only its own
//   heartbeat timer renews, and only while that timer runs on time. A skipped beat (frozen, or throttled for
//   longer than STALL_MS) voids the lease; until it re-checks the lock (navigator.locks.query(): is the leader
//   lock held by this frame's clientId?) live.ts buffers the raw MQTT messages instead of delivering them. Lost
//   (or the stolen lock's request rejects, or another frame announces itself): it demotes to a follower,
//   closes its sessions, drops the buffer and queues for the lock again. Followers take data and status only
//   from the leader they know (the last "leader" / "sync"), so a stale leader's burst reaches nobody.
//
// Pure apart from what's injected (channel, locks, timers), so bun tests run several frames against fakes.

import { BudgetError, type Budget } from "./budget";
import type { Shared, VaultCore } from "./core";
import type { Batch, LiveManager, LiveSnapshot } from "./live";
import type { DebugMethod, GetResult, LiveTopic, Params, Request, RestEndpoint, StreamPhase, VaultStatus } from "./protocol";
import { KEEPALIVE_S } from "./mqtt";
import { RestError, type RestOpts } from "./rest";
import type { Timers } from "./scheduler";

export const CHANNEL = "f1-vault";
export const LEADER_LOCK = "f1-vault-leader";
export const FRAME_LOCK = "f1-vault-frame:";
/** How often the leader lists the frame locks to drop the subscriptions of closed tabs. */
export const PRUNE_MS = 5_000;
/**
 * A forwarded request fails once the leader has been silent this long (its heartbeat stopped: a hidden
 * follower never steals the lead), or after FORWARD_MAX_MS in all: a get can wait its turn in the leader's
 * budget for minutes (a download's worth of requests queued ahead of it) while the leader is fine.
 */
export const FORWARD_TIMEOUT_MS = 35_000;
export const FORWARD_MAX_MS = 10 * 60_000;
/** Status pushes caused by the REST budget (every request start and end) at most this often. */
export const BUDGET_STATUS_MS = 500;
/** A get from an app port (a download's telemetry can be 5 MB) may take this long; live gap-fills get less (frame.ts). */
export const GET_TIMEOUT_MS = 120_000;
/** After a takeover, the old leader's topics are kept this long, until every follower has re-sent its own. */
export const PROVISIONAL_MS = 3_000;
/** The leader's heartbeat. */
export const HEARTBEAT_MS = 2_000;
/** A visible follower that hears nothing from the leader this long steals the lock. */
export const TAKEOVER_MS = 10_000;
/** How often a follower checks. */
export const WATCH_MS = 1_000;
/** A heartbeat (or watch) timer that fired this late means the frame was frozen or heavily throttled. */
export const STALL_MS = 3_500;
/** The leader's lease: valid this long after an on-time heartbeat (or a lock check). */
export const LEASE_MS = 4_000;
/**
 * After a steal, the old (frozen) leader's sessions may stay open at the broker until 1.5 x keepalive of
 * silence. The stealer's first session reuses the old active one's clientId (the broker kicks it), and it hands
 * over to a new token only once the old leader has been heard from (it demoted and closed its sessions) or
 * this long has passed: never three sessions.
 */
export const ZOMBIE_MS = KEEPALIVE_S * 1500;
/** At most this many of another leader's messages are kept while checking the lock (a long freeze's backlog). */
export const LIMBO_MAX = 10_000;
/** Data messages kept before the first sync (a few batches). */
export const EARLY_MAX = 1_000;

export type ChannelLike = { postMessage(m: unknown): void; onmessage: ((e: { data: unknown }) => void) | null };
export type LocksLike = {
  request(name: string, options: { ifAvailable?: boolean; steal?: boolean; signal?: AbortSignal }, cb: (lock: unknown) => unknown): Promise<unknown>;
  query(): Promise<{ held?: { name?: string; clientId?: string }[] }>;
};

type Forward = { type: "get"; endpoint: RestEndpoint; params: Params; caller: string } | { type: "debug"; req: Request<DebugMethod> };
type ForwardError = "network" | "internal" | "rate_limited" | "cancelled";

/** Messages between vault frames. `from` is the sender's id; `to` addresses one frame. */
export type TabMsg =
  | { k: "hello"; from: string }
  | { k: "sync"; from: string; to: string; status: VaultStatus; shared: Shared | null; live: LiveSnapshot }
  | { k: "leader"; from: string }
  | { k: "hb"; from: string; clientId?: string; starts?: number[] }
  | { k: "status"; from: string; status: VaultStatus }
  | { k: "shared"; from: string; shared: Shared }
  | { k: "login"; from: string; shared: Shared }
  | { k: "wiped"; from: string }
  | { k: "subs"; from: string; topics: LiveTopic[] }
  | { k: "data"; from: string; batches: Batch[] }
  | { k: "req"; from: string; id: number; req: Forward }
  | { k: "drop"; from: string; caller: string }
  | { k: "res"; from: string; to: string; id: number; ok: true; result: unknown }
  | { k: "res"; from: string; to: string; id: number; ok: false; code: ForwardError }
  | { k: "bye"; from: string };

export type NodeDeps = {
  core: VaultCore;
  live: LiveManager;
  rest: { get(endpoint: RestEndpoint, params: Params, opts: RestOpts): Promise<GetResult> };
  /** The REST budget (the leader spends it; status, takeover and dropped callers). Tests may leave it out. */
  budget?: Pick<Budget, "status" | "cancel" | "cancelPrefix" | "seed" | "recentStarts" | "setReserve">;
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
  /** Whether this frame's tab is visible (only a visible follower steals the lead). Default: yes. */
  visible?: () => boolean;
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
  private pending = new Map<number, { req: Forward; resolve: (r: unknown) => void; reject: (e: Error) => void; at: number }>();
  /** Follower: when the leader was last heard from (anything from it), for the forwarded requests' liveness. */
  private leaderHeardAt = 0;
  /** Follower: the leader's recent REST starts (its heartbeat), so the budget carries over a takeover. */
  private leaderStarts: number[] = [];
  private budgetTimer: unknown = null;
  private nextReq = 1;
  private initDone!: Promise<void>;
  private initResolve!: () => void;
  private pruneTimer: unknown = null;
  /** Follower: when the leader was last heard from; the watchdog's last run. */
  private lastHeard = 0;
  private lastWatch = 0;
  private watchTimer: unknown = null;
  /** Leader: the heartbeat's last run, and when the lease was last renewed. */
  private lastBeat = 0;
  private leaseAt = 0;
  private beatTimer: unknown = null;
  private verifying: Promise<boolean> | null = null;
  /** This frame's Web Locks clientId (to tell whether the leader lock is ours). */
  private clientId: string | null = null;
  /** The queued (non-steal) request for the leader lock. */
  private queued: AbortController | null = null;
  private counts = { changes: 0, steals: 0, lost: 0 };
  /** Follower: the leader's active session's clientId (from its heartbeat), for a steal. */
  private leaderClientId: string | null = null;
  /** Stealing: take over with the old leader's clientId. */
  private stealing: { from: string | null; clientId: string | null } | null = null;
  /** Leader after a steal: the frame we stole from (hearing from it releases handovers). */
  private zombie: string | null = null;
  /** Leader: messages from another frame acting as leader, while we check whether it's us who lost the lock. */
  private limbo: TabMsg[] = [];
  /** Follower: data that came before we knew the leader (the batch flushed right before our sync). */
  private early: TabMsg[] = [];

  constructor(private deps: NodeDeps) {
    this.id = deps.id ?? newId();
    this.initDone = new Promise((r) => (this.initResolve = r));
  }

  /** Join: take the lead if nobody has it, else follow (and queue to take over). */
  async start(): Promise<void> {
    this.deps.channel.onmessage = (e) => this.onMessage(e.data);
    const locks = this.deps.locks;
    // No Web Locks, or a browser that refuses them (third-party storage blocked, e.g. Helium's default: every
    // call is a SecurityError, which hold() can't tell from "another frame has it"): no election, lead alone.
    if (!locks || !(await this.locksWork(locks))) return this.lead(false);
    void this.hold(FRAME_LOCK + this.id, {}).then((ok) => void (ok && this.learnClientId()));
    if (await this.hold(LEADER_LOCK, { ifAvailable: true }, () => this.lostLock())) return this.lead(false);
    this.send({ k: "hello", from: this.id });
    this.queueForLead();
    this.lastHeard = this.lastWatch = this.leaderHeardAt = this.deps.timers.now();
    this.watch();
  }

  /**
   * Leader: may this frame act on what its sessions deliver right now? False once its heartbeat has
   * stalled (frozen, throttled): then verify() first. live.ts asks before delivering anything.
   */
  leaseOk(): boolean {
    if (this.role !== "leader") return false;
    return !this.deps.locks || this.deps.timers.now() - this.leaseAt <= LEASE_MS;
  }

  /** Leader: re-check that the leader lock is still this frame's. Renews the lease, or demotes. */
  verify(): Promise<boolean> {
    if (this.role !== "leader") return Promise.resolve(false);
    if (!this.deps.locks) return Promise.resolve(true);
    return (this.verifying ??= this.checkLock().then((mine) => {
      this.verifying = null;
      if (this.role !== "leader") return false;
      if (mine) {
        this.leaseAt = this.lastBeat = this.deps.timers.now();
        this.heartbeat();
        return true;
      }
      this.demote();
      return false;
    }));
  }

  /** Leader: the lease holds, or a lock check says the lead is still ours (false once demoted meanwhile). */
  private async stillLeading(): Promise<boolean> {
    if (this.role !== "leader") return false;
    return this.leaseOk() || this.verify();
  }

  /** The tab is going away: the leader forgets this frame's subscriptions now rather than at the next prune. */
  bye() {
    this.send({ k: "bye", from: this.id });
  }

  // ---------------------------------------------------------------- what the app's requests call

  status(): VaultStatus {
    if (this.role === "leader") {
      const stream = this.deps.live.status();
      const budget = this.deps.budget?.status();
      return { ...this.deps.core.status(), live: livePhase(stream.phase), stream, ...(budget && { budget }), tab: { role: "leader", id: this.id, leader: this.id, frames: this.frames, ...this.counts } };
    }
    const tab = { role: "follower" as const, id: this.id, leader: this.leaderId, ...this.counts };
    return this.mirror ? { ...this.mirror, tab } : { state: "connecting", live: "off", version: this.deps.version, tab };
  }

  /** This frame's app subscriptions (the union of its ports). */
  setTopics(topics: LiveTopic[]) {
    this.localTopics = topics;
    if (this.role === "leader") this.updateTopics();
    else this.send({ k: "subs", from: this.id, topics });
  }

  /** An app port's get. `caller`: the port (unique in this frame); the budget sees `<frame id>/<caller>`. */
  get(endpoint: RestEndpoint, params: Params, caller: string): Promise<GetResult> {
    if (this.role === "leader") return this.runLocal({ type: "get", endpoint, params, caller }, this.id) as Promise<GetResult>;
    return this.forward({ type: "get", endpoint, params, caller }) as Promise<GetResult>;
  }

  /** An app port closed: drop its queued gets (here if we lead, else at the leader, and our forwarded ones). */
  dropCaller(caller: string) {
    if (this.role === "leader") return void this.deps.budget?.cancel(`${this.id}/${caller}`);
    this.send({ k: "drop", from: this.id, caller });
    for (const [id, p] of this.pending)
      if (p.req.type === "get" && p.req.caller === caller) {
        this.pending.delete(id);
        p.reject(new BudgetError("cancelled"));
      }
  }

  /** The budget changed (a request started or ended): push the status, at most every BUDGET_STATUS_MS. */
  budgetChanged() {
    if (this.role !== "leader" || this.budgetTimer !== null) return;
    this.budgetTimer = this.deps.timers.setTimeout(() => {
      this.budgetTimer = null;
      this.pushStatus();
    }, BUDGET_STATUS_MS);
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

  /**
   * Request a lock and keep it for the frame's lifetime. Resolves true once held, false if not available (or
   * the queued request was aborted). `onLost`: the lock was taken from us after all (someone stole it).
   */
  private hold(name: string, opts: { ifAvailable?: boolean; steal?: boolean; signal?: AbortSignal }, onLost?: () => void): Promise<boolean> {
    return new Promise((resolve) => {
      let granted = false;
      this.deps.locks!.request(name, opts, (lock) => {
        if (!lock) return resolve(false);
        granted = true;
        resolve(true);
        return new Promise(() => {});
      }).catch(() => {
        if (!granted) resolve(false);
        else onLost?.();
      });
    });
  }

  /** Whether this frame may use Web Locks at all (a browser that refuses them refuses query() too). */
  private async locksWork(locks: LocksLike): Promise<boolean> {
    try {
      await locks.query();
      return true;
    } catch {
      return false;
    }
  }

  private async learnClientId() {
    try {
      const q = await this.deps.locks!.query();
      this.clientId = q.held?.find((l) => l.name === FRAME_LOCK + this.id)?.clientId ?? null;
    } catch {
      // (then the lock check trusts that the leader lock is ours)
    }
  }

  /** Whether the leader lock is held by this frame (its clientId; without clientIds, held by anyone). */
  private async checkLock(): Promise<boolean> {
    try {
      const q = await this.deps.locks!.query();
      const leader = q.held?.find((l) => l.name === LEADER_LOCK);
      if (!leader) return false;
      return !this.clientId || !leader.clientId || leader.clientId === this.clientId;
    } catch {
      return true; // can't tell: carry on
    }
  }

  /** Queue for the leader lock (the normal way to take over: the leader's tab closes). */
  private queueForLead() {
    this.queued?.abort();
    const ac = new AbortController();
    this.queued = ac;
    void this.hold(LEADER_LOCK, { signal: ac.signal }, () => this.lostLock()).then((ok) => {
      if (this.queued === ac) this.queued = null;
      if (ok) void this.lead(true);
    });
  }

  /** The leader went quiet (frozen, throttled): take the lock from it. */
  private steal() {
    this.queued?.abort();
    this.queued = null;
    this.counts.steals++;
    this.stealing = { from: this.leaderId, clientId: this.leaderClientId };
    void this.hold(LEADER_LOCK, { steal: true }, () => this.lostLock()).then((ok) => {
      if (ok) void this.lead(true);
      else this.queueForLead();
    });
  }

  /** Our leader lock was stolen (its request rejected). */
  private lostLock() {
    if (this.role === "leader") this.demote();
  }

  private watch() {
    if (this.watchTimer !== null) this.deps.timers.clearTimeout(this.watchTimer);
    this.watchTimer = this.deps.timers.setTimeout(() => this.onWatch(), WATCH_MS);
  }

  /** Follower: steal the lead from a leader that has gone quiet, if this tab is visible. */
  private onWatch() {
    this.watchTimer = null;
    if (this.role === "leader") return;
    const now = this.deps.timers.now();
    const stalled = now - this.lastWatch > STALL_MS;
    this.lastWatch = now;
    this.watch();
    this.expireForwards(now, stalled);
    // We were the frozen one: give the leader's queued messages a chance to arrive first.
    if (stalled) return void (this.lastHeard = now);
    if (now - this.lastHeard < TAKEOVER_MS || !(this.deps.visible?.() ?? true)) return;
    this.lastHeard = now; // one steal at a time
    this.steal();
  }

  /** Follower: forwarded requests fail once the leader has gone quiet (or they're very old). */
  private expireForwards(now: number, stalled: boolean) {
    // (We were the frozen one: the leader's answers may be queued behind the freeze. Not yet.)
    if (stalled) return void (this.leaderHeardAt = now);
    const quiet = now - this.leaderHeardAt > FORWARD_TIMEOUT_MS;
    for (const [id, p] of this.pending)
      if (quiet || now - p.at > FORWARD_MAX_MS) {
        this.pending.delete(id);
        p.reject(new Error("the leader frame didn't answer"));
      }
  }

  private beat() {
    if (this.beatTimer !== null) this.deps.timers.clearTimeout(this.beatTimer);
    this.beatTimer = this.deps.timers.setTimeout(() => this.onBeat(), HEARTBEAT_MS);
  }

  /** Leader: the heartbeat. On time, it renews the lease; late (we were frozen), the lock is checked first. */
  private onBeat() {
    this.beatTimer = null;
    if (this.role !== "leader") return;
    const now = this.deps.timers.now();
    const stalled = now - this.lastBeat > STALL_MS;
    this.lastBeat = now;
    this.beat();
    if (stalled) return void this.verify();
    this.leaseAt = now;
    this.heartbeat();
  }

  private heartbeat() {
    const clientId = this.deps.live.activeClientId();
    const starts = this.deps.budget?.recentStarts();
    this.send({ k: "hb", from: this.id, ...(clientId && { clientId }), ...(starts?.length && { starts }) });
  }

  /** Leader -> follower: another frame holds the lock now. Stop streaming (emitting nothing stale) and queue again. */
  private demote() {
    if (this.role !== "leader") return;
    this.role = "follower";
    this.counts.lost++;
    this.counts.changes++;
    this.leaderId = null;
    for (const t of [this.pruneTimer, this.beatTimer, this.budgetTimer]) if (t !== null) this.deps.timers.clearTimeout(t);
    this.pruneTimer = this.beatTimer = this.budgetTimer = null;
    this.leaderHeardAt = this.deps.timers.now();
    this.followerSubs.clear();
    this.provisional = [];
    const last = this.deps.core.status();
    this.shared = this.deps.core.sharedLogin();
    this.deps.live.stop();
    this.deps.core.demote();
    this.mirror = { ...last, live: "off" };
    this.lastHeard = this.lastWatch = this.deps.timers.now();
    this.watch();
    this.send({ k: "hello", from: this.id });
    this.send({ k: "subs", from: this.id, topics: this.localTopics });
    this.queueForLead();
    // What the new leader sent while we still thought we led (we were frozen): our app missed it.
    const limbo = this.limbo;
    this.limbo = [];
    for (const m of limbo) this.onMessage(m);
    this.deps.onStatus(this.status());
  }

  private async lead(takeover: boolean) {
    if (this.role === "leader") return;
    this.role = "leader";
    this.leaderId = this.id;
    if (takeover) this.counts.changes++;
    if (this.watchTimer !== null) this.deps.timers.clearTimeout(this.watchTimer);
    this.watchTimer = null;
    this.leaseAt = this.lastBeat = this.deps.timers.now();
    this.beat();
    this.send({ k: "leader", from: this.id });
    if (takeover) {
      // Keep streaming what the old leader streamed until the followers have re-announced their topics.
      this.provisional = this.mirror?.stream?.topics ?? [];
      this.deps.timers.setTimeout(() => {
        this.provisional = [];
        this.updateTopics();
      }, PROVISIONAL_MS);
      if (this.mirror?.stream) this.deps.live.state.merge({ lastSeen: {}, since: this.mirror.stream.since, sessionKey: null, seen: {} });
      // The old leader's requests of the last minute count against ours: one budget per browser.
      this.deps.budget?.seed(this.leaderStarts);
    }
    const shared = this.shared;
    this.shared = null;
    const stolen = this.stealing;
    this.stealing = null;
    this.zombie = stolen?.from ?? null;
    if (takeover && shared) this.deps.core.adoptShared(shared);
    else await this.deps.core.init();
    this.initResolve();
    this.updateTopics();
    this.deps.live.start({ gap: takeover, ...(stolen && { clientId: stolen.clientId ?? undefined, handoverAfter: this.deps.timers.now() + ZOMBIE_MS }) });
    // Requests that were waiting for the old leader: ours now.
    for (const [id, p] of this.pending) {
      this.pending.delete(id);
      this.runLocal(p.req, this.id).then(p.resolve, p.reject);
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
    const topics = this.union();
    this.deps.live.setTopics(topics);
    // While the stream runs, downloads leave part of each minute's budget for its gap-fills.
    this.deps.budget?.setReserve(topics.length > 0);
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
        // (A closed tab's queued gets: nobody will read their answers.)
        for (const id of this.gone(alive)) this.deps.budget?.cancelPrefix(`${id}/`);
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

  /** Frames that sent us requests and whose frame lock is gone (their tab closed). */
  private gone(alive: Set<string>): string[] {
    const out = [...this.callerFrames].filter((id) => id !== this.id && !alive.has(id));
    for (const id of out) this.callerFrames.delete(id);
    return out;
  }
  /** Leader: the frames that forwarded gets to us. */
  private callerFrames = new Set<string>();

  private forward(req: Forward): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = this.nextReq++;
      this.pending.set(id, { req, resolve, reject, at: this.deps.timers.now() });
      this.send({ k: "req", from: this.id, id, req });
    });
  }

  /** Run a request here (we lead). `from`: the frame whose port asked. */
  private runLocal(req: Forward, from: string): Promise<unknown> {
    if (req.type === "get") return this.deps.rest.get(req.endpoint, req.params, { caller: `${from}/${req.caller}`, timeoutMs: GET_TIMEOUT_MS });
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
    if (this.role === "leader") {
      // Another frame acting as the leader: one of us lost the lock (a steal). Check which. If it's us, what
      // it sent meanwhile is what our app missed: kept, and replayed once we follow.
      if (m.k === "leader" || m.k === "hb" || m.k === "status" || m.k === "data" || m.k === "sync" || m.k === "shared") {
        if (this.limbo.length < LIMBO_MAX) this.limbo.push(m);
        return void this.verify().then((mine) => {
          if (mine) this.limbo = [];
        });
      }
      return void this.onLeaderMessage(m);
    }
    if (m.from === this.leaderId || m.k === "leader" || (m.k === "sync" && m.to === this.id)) this.lastHeard = this.leaderHeardAt = this.deps.timers.now();
    this.onFollowerMessage(m);
  }

  private async onLeaderMessage(m: TabMsg) {
    if (this.zombie !== null && m.from === this.zombie) {
      // The leader we stole from is back, as a follower: it closed its sessions.
      this.zombie = null;
      this.deps.live.releaseHandovers();
    }
    switch (m.k) {
      case "hello":
        await this.initDone;
        // A leader waking from a freeze answers only once it knows it still leads: a stale sync would make the
        // new frame follow a leader that is about to demote (and a hidden frame never steals its way out).
        if (!(await this.stillLeading())) return;
        // Flush first: the snapshot's seen keys must not include messages still in our outbox, or the
        // follower (which dedupes against them) would drop that batch when it comes.
        this.deps.live.flushNow();
        return this.send({ k: "sync", from: this.id, to: m.from, status: this.status(), shared: this.deps.core.sharedLogin(), live: this.deps.live.state.snapshot() });
      case "subs":
        this.followerSubs.set(m.from, m.topics);
        this.updateTopics();
        return;
      case "bye":
        if (this.followerSubs.delete(m.from)) this.updateTopics();
        this.deps.budget?.cancelPrefix(`${m.from}/`);
        return;
      case "drop":
        this.deps.budget?.cancel(`${m.from}/${m.caller}`);
        return;
      case "login":
        await this.initDone;
        return this.deps.core.adoptShared(m.shared);
      case "wiped":
        this.deps.core.wipedElsewhere();
        return this.wiped();
      case "req": {
        await this.initDone;
        if (!(await this.stillLeading())) return; // (the real leader answers it)
        if (m.req.type === "get") this.callerFrames.add(m.from);
        const reply = (r: { ok: true; result: unknown } | { ok: false; code: ForwardError }) => this.send({ k: "res", from: this.id, to: m.from, id: m.id, ...r });
        return this.runLocal(m.req, m.from).then(
          (result) => reply({ ok: true, result }),
          (e) => reply({ ok: false, code: e instanceof RestError ? "network" : e instanceof BudgetError ? e.code : "internal" }),
        );
      }
    }
  }

  private onFollowerMessage(m: TabMsg) {
    switch (m.k) {
      case "leader":
        // A new leader (a takeover, or the first one after we joined): announce ourselves again.
        if (this.leaderId !== null && this.leaderId !== m.from) this.counts.changes++;
        this.leaderId = m.from;
        this.send({ k: "hello", from: this.id });
        this.send({ k: "subs", from: this.id, topics: this.localTopics });
        for (const [id, p] of this.pending) this.send({ k: "req", from: this.id, id, req: p.req });
        return;
      case "sync": {
        if (m.to !== this.id) return;
        if (this.leaderId !== m.from && this.leaderId !== null) this.counts.changes++;
        this.leaderId = m.from;
        this.shared = m.shared;
        // The batch the leader flushed just before this snapshot came first: take it before the seen keys.
        const early = this.early;
        this.early = [];
        for (const e of early) if (e.from === m.from) this.onFollowerMessage(e);
        this.deps.live.state.merge(m.live);
        this.setMirror(m.status);
        this.send({ k: "subs", from: this.id, topics: this.localTopics });
        return;
      }
      case "status":
        // Only from the leader we know: a stale (frozen, now woken) leader's status must not win.
        if (m.from !== this.leaderId) return;
        return this.setMirror(m.status);
      case "shared":
        if (m.from !== this.leaderId) return;
        this.shared = m.shared;
        return;
      case "hb":
        if (m.from === this.leaderId) {
          this.leaderClientId = m.clientId ?? null;
          this.leaderStarts = m.starts ?? [];
        }
        return;
      case "data": {
        // Not knowing the leader yet (just joined, just demoted): keep it until the sync says who leads.
        if (this.leaderId === null) return void (this.early.length < EARLY_MAX && this.early.push(m));
        // Likewise its data: a stale leader's burst would be duplicates at best.
        if (m.from !== this.leaderId) return;
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
        if (m.ok) p.resolve(m.result);
        else p.reject(m.code === "network" ? new RestError("network") : m.code === "rate_limited" || m.code === "cancelled" ? new BudgetError(m.code) : new Error("internal"));
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
