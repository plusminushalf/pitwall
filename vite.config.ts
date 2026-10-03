import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// A static site: `vite build` gives a dist/ for any static host that serves index.html for every path the app has
// (/session/11377, /live: src/url.ts), at the root of its domain (absolute base).
// Race data is never part of it: each browser downloads its own from OpenF1 (src/ingest/).
//
// Two pages: the app (index.html) and Called It (predictions/index.html, src/predictions/), which the Worker serves
// for /predictions and every call's link (worker/index.ts).
//
// Dev only: the live relay (server/live.ts, `bun run live`) serves the /relay WebSocket and /relay/health.
// LIVE_PORT may come from the shell or .env, like the relay's own.
const livePort = process.env.LIVE_PORT || loadEnv("", process.cwd(), "").LIVE_PORT || "8787";

/**
 * Dev only: Called It's page for its call links, and its API from worker/api.ts with calls kept in memory (the
 * deployed Worker keeps them in a Durable Object). `wrangler dev` after a build runs the real thing.
 */
function predictionsDev(): Plugin {
  return {
    name: "predictions-dev",
    async configureServer(server) {
      const { handleApi, memoryStore } = await server.ssrLoadModule("/worker/api.ts");
      const store = memoryStore();
      server.middlewares.use(async (req, res, next) => {
        const url = req.url ?? "/";
        if (/^\/predictions(\/[^/.]*)?\/?(\?|#|$)/.test(url)) req.url = "/predictions/";
        if (!url.startsWith("/api/predictions")) return next();
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const body = req.method === "GET" || req.method === "HEAD" ? undefined : Buffer.concat(chunks);
        // x-dev-now (ms) moves the server's clock, to try a reveal before the race.
        const now = () => Number(req.headers["x-dev-now"]) || Date.now();
        const out: Response | null = await handleApi(new Request(`http://${req.headers.host}${url}`, { method: req.method, body }), store, now);
        if (!out) return next();
        res.statusCode = out.status;
        out.headers.forEach((v, k) => res.setHeader(k, v));
        res.end(Buffer.from(await out.arrayBuffer()));
      });
    },
  };
}

export default defineConfig({
  base: "/",
  plugins: [react(), tailwindcss(), predictionsDev()],
  build: {
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL("./index.html", import.meta.url)),
        predictions: fileURLToPath(new URL("./predictions/index.html", import.meta.url)),
      },
    },
  },
  // Widgets import the widget kit like a package (also in tsconfig.json's paths).
  resolve: { alias: [{ find: /^widget-kit$/, replacement: fileURLToPath(new URL("./src/widgetkit/index.ts", import.meta.url)) }] },
  worker: { format: "es" },
  server: {
    host: true,
    proxy: { "^/relay(/|\\?|$)": { target: `http://127.0.0.1:${livePort}`, ws: true } },
  },
});
