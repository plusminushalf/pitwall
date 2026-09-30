// Request dispatch over a MessagePort. Pure apart from the port: no DOM, testable under bun.

import { DEBUG_METHODS, parseRequest, type DebugMethod, type GetResult, type LiveMessage, type LiveTopic, type Params, type Request, type Response, type RestEndpoint, type Ticket, type VaultEvent, type VaultStatus } from "./protocol";
import { BudgetError } from "./budget";
import { RestError } from "./rest";

/** The part of MessagePort the vault uses (so tests can fake one). */
export type PortLike = {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(type: "message", listener: (e: { data: unknown; ports: readonly PortLike[] }) => void): void;
  start(): void;
};

/** What the RPC layer needs from the vault (VaultCore in core.ts). */
export type Vault = {
  status(): VaultStatus;
  expect(kind: "connect" | "unlock", ticket: Ticket): { ok: true; status: VaultStatus } | { ok: false; code: "unavailable" | "busy" | "not_connected"; message: string };
  cancel(ticket: Ticket): VaultStatus;
  disconnect(): Promise<VaultStatus>;
  /** `caller`: the port it came on (the budget's fairness unit; unique within this frame). */
  get(endpoint: RestEndpoint, params: Params, caller: string): Promise<GetResult>;
  /** A port closed (or was dropped): its queued gets are dropped. */
  dropCaller(caller: string): void;
  /** The union of this frame's ports' subscriptions changed (the leader streams the union across tabs). */
  setTopics(topics: LiveTopic[]): void;
};

/** Dev vault only: the handler for DEBUG_METHODS (debug.ts). Without one, they're unknown types. */
export type DebugHandler = (req: Request<DebugMethod>) => Promise<unknown>;

/** At most this many ports (the hello's plus openPort's). */
export const MAX_PORTS = 8;

/** A port: its caller id (for the REST budget), requests not yet answered, when it was last used. */
type PortInfo = { caller: string; pending: number; lastUsed: number; main: boolean; closing?: boolean };

export class Rpc {
  private ports = new Map<PortLike, PortInfo>();
  /** Each port's live topics. Data goes only to the ports that asked for it. */
  private subs = new Map<PortLike, Set<LiveTopic>>();
  private nextPort = 0;
  private clock = 0;

  constructor(
    private vault: Vault,
    private debug?: DebugHandler,
  ) {}

  /**
   * Serve the protocol on a port. At MAX_PORTS, an openPort port (never the hello's) with nothing pending is
   * dropped for it, the one idle longest (MessagePorts have no close event: a download worker that was
   * terminated leaves its port behind); with none to drop, false (and the port is not used).
   */
  attach(port: PortLike, opts: { main?: boolean } = {}): boolean {
    if (this.ports.size >= MAX_PORTS) {
      const idle = [...this.ports].filter(([, i]) => !i.main && i.pending === 0).sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
      if (!idle) return false;
      this.detach(idle[0]);
    }
    const info: PortInfo = { caller: `p${this.nextPort++}`, pending: 0, lastUsed: ++this.clock, main: opts.main === true };
    this.ports.set(port, info);
    port.addEventListener("message", (e) => {
      if (this.ports.get(port) !== info) return; // closed or dropped
      info.pending++;
      info.lastUsed = ++this.clock;
      void this.handle(e.data, e.ports, port).then((res) => {
        info.pending--;
        if (!res || this.ports.get(port) !== info) return; // closed meanwhile: nothing more on it
        // A get's body is transferred, not copied.
        const body = res.ok && (res.result as Partial<GetResult> | null)?.body;
        port.postMessage(res, body instanceof ArrayBuffer ? [body] : []);
        if (info.closing) this.detach(port);
      });
    });
    // (A message that can't be deserialized fires "messageerror" instead: it has no id to answer, so it's dropped.)
    port.start();
    return true;
  }

  /** Stop serving a port: forget its subscriptions and drop its queued gets. */
  private detach(port: PortLike) {
    const info = this.ports.get(port);
    if (!info) return;
    this.ports.delete(port);
    this.vault.dropCaller(info.caller);
    if (this.subs.delete(port)) this.vault.setTopics(this.topics());
  }

  /** Ports open now (tests, the debug panel). */
  get portCount() {
    return this.ports.size;
  }

  /** Push an unsolicited event (a status change) to every open port. */
  broadcast(event: VaultEvent) {
    for (const port of this.ports.keys()) port.postMessage(event);
  }

  /** Live data: one event per topic, to the ports subscribed to it. */
  deliver(batches: readonly { topic: LiveTopic; messages: LiveMessage[] }[]) {
    for (const [port, topics] of this.subs)
      for (const b of batches) if (topics.has(b.topic) && b.messages.length) port.postMessage({ v: 1, type: "event", event: "data", topic: b.topic, messages: b.messages } satisfies VaultEvent);
  }

  /** Every topic some port of this frame is subscribed to. */
  topics(): LiveTopic[] {
    const all = new Set<LiveTopic>();
    for (const s of this.subs.values()) for (const t of s) all.add(t);
    return [...all].sort();
  }

  private subscribe(port: PortLike, topics: LiveTopic[], on: boolean): { topics: LiveTopic[] } {
    let s = this.subs.get(port);
    if (!s) this.subs.set(port, (s = new Set()));
    for (const t of topics) on ? s.add(t) : s.delete(t);
    this.vault.setTopics(this.topics());
    return { topics: [...s].sort() };
  }

  /** One inbound message to its response, or null to drop it. Never rejects. `from`: the port it came on. */
  async handle(data: unknown, ports: readonly PortLike[], from: PortLike | null = null): Promise<Response | null> {
    const parsed = parseRequest(data, ports.length, { debug: this.debug !== undefined });
    if (!parsed.ok) return parsed.id === null ? null : { v: 1, id: parsed.id, ok: false, error: parsed.error };
    const req = parsed.request;
    try {
      switch (req.type) {
        case "status":
          return { v: 1, id: req.id, ok: true, result: this.vault.status() };
        case "connect":
        case "unlock": {
          const r = this.vault.expect(req.type, req.ticket);
          return r.ok ? { v: 1, id: req.id, ok: true, result: r.status } : { v: 1, id: req.id, ok: false, error: { code: r.code, message: r.message } };
        }
        case "cancel":
          return { v: 1, id: req.id, ok: true, result: this.vault.cancel(req.ticket) };
        case "disconnect":
          return { v: 1, id: req.id, ok: true, result: await this.vault.disconnect() };
        case "get":
          try {
            const caller = (from && this.ports.get(from)?.caller) ?? "p?";
            return { v: 1, id: req.id, ok: true, result: await this.vault.get(req.endpoint, req.params, caller) };
          } catch (e) {
            if (e instanceof RestError) return { v: 1, id: req.id, ok: false, error: { code: "network", message: "couldn't reach OpenF1" } };
            if (e instanceof BudgetError)
              return { v: 1, id: req.id, ok: false, error: e.code === "rate_limited" ? { code: "rate_limited", message: "too many requests queued on this port" } : { code: "unavailable", message: "cancelled" } };
            throw e;
          }
        case "close": {
          // Answered on the port it closes, then nothing more (attach's listener detaches it).
          const info = from ? this.ports.get(from) : undefined;
          if (info) {
            info.closing = true;
            this.vault.dropCaller(info.caller);
          }
          return { v: 1, id: req.id, ok: true, result: {} };
        }
        case "subscribe":
        case "unsubscribe":
          if (!from) return { v: 1, id: req.id, ok: false, error: { code: "bad_request", message: "no port" } };
          return { v: 1, id: req.id, ok: true, result: this.subscribe(from, req.topics, req.type === "subscribe") };
        case "openPort":
          return this.attach(ports[0]!)
            ? { v: 1, id: req.id, ok: true, result: {} }
            : { v: 1, id: req.id, ok: false, error: { code: "rate_limited", message: `at most ${MAX_PORTS} ports` } };
        default:
          if (this.debug && (DEBUG_METHODS as readonly string[]).includes(req.type)) return { v: 1, id: req.id, ok: true, result: (await this.debug(req as Request<DebugMethod>)) as VaultStatus };
          return { v: 1, id: req.id, ok: false, error: { code: "not_implemented", message: `${req.type} is not implemented yet` } };
      }
    } catch {
      // Never echo internals: an error message could carry something it shouldn't.
      return { v: 1, id: req.id, ok: false, error: { code: "internal", message: "internal error" } };
    }
  }
}
