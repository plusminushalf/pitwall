// Live relay: streams a race, sprint, qualifying or free practice in progress to the app in the replay format (src/live/protocol.ts).
//
//   bun run live                              OpenF1 live timing (needs OPENF1_USERNAME/PASSWORD in .env)
//   LIVE_SIMULATE=11377 bun server/live.ts    replay a cached session as if it were live
//
// WebSocket at /relay (proxied by Vite in dev), health at GET /relay/health. Env: LIVE_PORT (8787),
// LIVE_SIMULATE, LIVE_SIMULATE_SPEED (1), LIVE_SIMULATE_START (-60 s from lights out, or practice's green light).
// Credentials and tokens stay here: the browser only ever sees processed data.

import { Hub } from "./hub";
import { OpenF1Source } from "./openf1Source";
import { simulate } from "./simulate";

const port = Number(process.env.LIVE_PORT || 8787);
// Loopback only by default: the relay streams your own sponsor-account feed, so keep it on this machine.
const hostname = process.env.LIVE_HOST || "127.0.0.1";
const simulateKey = process.env.LIVE_SIMULATE ? Number(process.env.LIVE_SIMULATE) : null;
if (simulateKey != null && !Number.isInteger(simulateKey)) {
  console.error(`LIVE_SIMULATE must be a session key, got "${process.env.LIVE_SIMULATE}"`);
  process.exit(1);
}
const speed = Number(process.env.LIVE_SIMULATE_SPEED || 1);
const start = Number(process.env.LIVE_SIMULATE_START || -60);

const hub = new Hub(simulateKey != null ? "simulate" : "openf1");

const server = Bun.serve({
  hostname,
  port,
  fetch(req, server) {
    const { pathname } = new URL(req.url);
    if (pathname === "/relay/health") return Response.json(hub.health());
    if (pathname === "/relay" || pathname === "/relay/") {
      if (server.upgrade(req)) return undefined;
      return new Response("WebSocket upgrade expected", { status: 426 });
    }
    return new Response("Not found", { status: 404 });
  },
  websocket: {
    perMessageDeflate: true,
    open: (ws) => hub.open(ws),
    close: (ws) => hub.close(ws),
    message: () => {}, // server -> client only
  },
});
hub.attach(server);
console.log(`[live] relay on ws://${hostname}:${server.port}/relay (health: http://${hostname}:${server.port}/relay/health)`);

let openf1: OpenF1Source | null = null;
if (simulateKey != null) {
  if (!(speed > 0) || !Number.isFinite(start)) {
    console.error("LIVE_SIMULATE_SPEED must be > 0 and LIVE_SIMULATE_START a number of seconds");
    process.exit(1);
  }
  simulate(hub, { sessionKey: simulateKey, speed, start }).catch((e) => {
    console.error(`[live] simulation failed: ${e instanceof Error ? e.stack : e}`);
    hub.setStatus({ state: "error", detail: `simulation failed: ${e instanceof Error ? e.message : e}` });
  });
} else {
  openf1 = new OpenF1Source(hub);
  openf1.start();
}

let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    if (stopping) process.exit(1);
    stopping = true;
    await openf1?.shutdown().catch((e) => console.error(`[live] shutdown: ${e}`));
    server.stop(true);
    process.exit(0);
  });
}
