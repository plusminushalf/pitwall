// Dev server for spike S1, separate from the app's own (vite.config.ts is untouched):
//
//   bunx vite --config spikes/s1/vite.config.ts            -> http://localhost:5199/spike-s1.html
//
// Same app plugins (the replay UI at / is needed for the OPFS read path), plus /__s1/raw/<key>/ serving the
// local raw cache (data/raw/<key>/*.json.gz) for compute-only runs. No race-downloader API, no live proxy,
// and its own dependency cache so it can run next to the main dev server.
// OPFS needs a secure context: from another device use https (a tunnel), not http://<lan-ip>.

import { createReadStream, existsSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const root = fileURLToPath(new URL("../..", import.meta.url));

function rawCache(): Plugin {
  return {
    name: "s1-raw-cache",
    configureServer(server) {
      server.middlewares.use("/__s1/raw", (req, res, next) => {
        const m = /^\/(\d+)\/([\w.-]*\.json\.gz)?$/.exec((req.url ?? "").split("?")[0]);
        if (!m || req.method !== "GET") return next();
        const dir = join(root, "data/raw", m[1]);
        if (!existsSync(dir)) {
          res.statusCode = 404;
          return res.end();
        }
        res.setHeader("Cache-Control", "no-store");
        if (!m[2]) {
          const files = readdirSync(dir)
            .filter((f) => f.endsWith(".json.gz"))
            .sort()
            .map((name) => ({ name, size: statSync(join(dir, name)).size }));
          res.setHeader("Content-Type", "application/json");
          return res.end(JSON.stringify(files));
        }
        const file = join(dir, m[2]);
        if (!existsSync(file)) {
          res.statusCode = 404;
          return res.end();
        }
        res.setHeader("Content-Type", "application/octet-stream");
        createReadStream(file).pipe(res);
      });
    },
  };
}

export default defineConfig({
  root,
  cacheDir: join(root, "node_modules/.vite-s1"),
  plugins: [react(), tailwindcss(), rawCache()],
  server: { port: 5199, strictPort: true },
});
