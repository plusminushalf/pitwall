import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { ingestPlugin } from "./devserver/ingestPlugin.ts";

// Live mode: the relay (server/live.ts, `bun run live`) serves the /live WebSocket and /live/health.
// LIVE_PORT may come from the shell or .env, like the relay's own.
const livePort = process.env.LIVE_PORT || loadEnv("", process.cwd(), "").LIVE_PORT || "8787";

export default defineConfig({
  plugins: [react(), tailwindcss(), ingestPlugin()],
  server: {
    host: true,
    proxy: { "^/live(/|\\?|$)": { target: `http://localhost:${livePort}`, ws: true } },
  },
});
