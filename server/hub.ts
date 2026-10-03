// The relay's fan-out to browser clients over WebSocket. What is sent and when is src/live/hub.ts, shared with
// the browser's live worker; this adds the sockets.

import type { Server, ServerWebSocket } from "bun";
import { LiveHub, type Source } from "../src/live/hub";
import type { LiveMessage } from "../src/live/protocol";

const TOPIC = "live";

export type { Source };

export class Hub extends LiveHub {
  private server: Server<unknown> | null = null;
  private sockets = new Set<ServerWebSocket<unknown>>();

  constructor(source: Source) {
    super(source);
  }

  attach(server: Server<unknown>): void {
    this.server = server;
  }

  open(ws: ServerWebSocket<unknown>): void {
    this.sockets.add(ws);
    ws.subscribe(TOPIC);
    for (const msg of this.welcome()) {
      const bytes = this.sendTo(ws, msg);
      if (msg.type === "snapshot") this.last.snapshotBytes = bytes;
    }
  }

  close(ws: ServerWebSocket<unknown>): void {
    this.sockets.delete(ws);
  }

  get clientCount(): number {
    return this.sockets.size;
  }

  protected override clients(): number {
    return this.sockets.size;
  }

  protected override broadcast(msg: LiveMessage): number {
    if (!this.server || !this.sockets.size) return 0;
    const json = JSON.stringify(msg);
    this.server.publish(TOPIC, json, true);
    return json.length;
  }

  private sendTo(ws: ServerWebSocket<unknown>, msg: LiveMessage): number {
    const json = JSON.stringify(msg);
    ws.send(json, true);
    return json.length;
  }
}
