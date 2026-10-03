import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// A static site: `vite build` gives a dist/ for any static host that serves index.html for every path the app has
// (/session/11377, /live: src/url.ts), at the root of its domain (absolute base).
// Race data is never part of it: each browser downloads its own from OpenF1 (src/ingest/).
//
// Two pages: the app (index.html) and Called It (predictions/index.html, src/predictions/) at /predictions.
//
// Dev only: the live relay (server/live.ts, `bun run live`) serves the /relay WebSocket and /relay/health.
// LIVE_PORT may come from the shell or .env, like the relay's own.
const livePort = process.env.LIVE_PORT || loadEnv("", process.cwd(), "").LIVE_PORT || "8787";

/** Dev only: /predictions is Called It's page (built, the host serves it from predictions/index.html). */
function predictionsDev(): Plugin {
  return {
    name: "predictions-dev",
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        if (/^\/predictions\/?(\?|#|$)/.test(req.url ?? "")) req.url = "/predictions/";
        next();
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
