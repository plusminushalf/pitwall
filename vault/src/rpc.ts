// Request dispatch over a MessagePort. Pure apart from the port: no DOM, testable under bun.

import { parseRequest, type Response, type Ticket, type VaultEvent, type VaultStatus } from "./protocol";

/** The part of MessagePort the vault uses (so tests can fake one). */
export type PortLike = {
  postMessage(message: unknown): void;
  addEventListener(type: "message", listener: (e: { data: unknown; ports: readonly PortLike[] }) => void): void;
  start(): void;
};

/** What the RPC layer needs from the vault (VaultCore in core.ts). */
export type Vault = {
  status(): VaultStatus;
  expect(kind: "connect" | "unlock", ticket: Ticket): { ok: true; status: VaultStatus } | { ok: false; code: "unavailable" | "busy" | "not_connected"; message: string };
  cancel(ticket: Ticket): VaultStatus;
  disconnect(): Promise<VaultStatus>;
};

/** At most this many ports (the hello's plus openPort's). */
export const MAX_PORTS = 8;

export class Rpc {
  private ports = new Set<PortLike>();

  constructor(private vault: Vault) {}

  /** Serve the protocol on a port. False (and the port is not used) once MAX_PORTS are open. */
  attach(port: PortLike): boolean {
    if (this.ports.size >= MAX_PORTS) return false;
    this.ports.add(port);
    port.addEventListener("message", (e) => {
      void this.handle(e.data, e.ports).then((res) => {
        if (res) port.postMessage(res);
      });
    });
    // (A message that can't be deserialized fires "messageerror" instead: it has no id to answer, so it's dropped.)
    port.start();
    return true;
  }

  /** Push an unsolicited event (a status change) to every open port. */
  broadcast(event: VaultEvent) {
    for (const port of this.ports) port.postMessage(event);
  }

  /** One inbound message to its response, or null to drop it. Never rejects. */
  async handle(data: unknown, ports: readonly PortLike[]): Promise<Response | null> {
    const parsed = parseRequest(data, ports.length);
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
        case "openPort":
          return this.attach(ports[0]!)
            ? { v: 1, id: req.id, ok: true, result: {} }
            : { v: 1, id: req.id, ok: false, error: { code: "rate_limited", message: `at most ${MAX_PORTS} ports` } };
        default:
          return { v: 1, id: req.id, ok: false, error: { code: "not_implemented", message: `${req.type} is not implemented yet` } };
      }
    } catch {
      // Never echo internals: an error message could carry something it shouldn't.
      return { v: 1, id: req.id, ok: false, error: { code: "internal", message: "internal error" } };
    }
  }
}
