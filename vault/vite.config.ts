// The vault's own Vite project (root: vault/). Vite is only the dev server and bundler: the vault has no
// runtime dependencies.
//
//   bun run vault         dev server on :5174 (no HMR or Vite client: reload by hand; dev CSP = production CSP)
//   bun run vault:build   vault/dist, including dist/_headers for the static host
//   bun run vault:serve   vault/dist on :5174 with exactly the headers in dist/_headers
//
// VAULT_APP_ORIGINS (shell or the repo's .env): comma-separated app origins that may embed the vault,
// baked into the build (the frame's allowlist and its CSP frame-ancestors). Default: the local app.
// VAULT_ALLOWED_HOSTS: extra Host names the dev server answers to (comma-separated), for public dev URLs.
// VAULT_FAKE_EXPIRES_IN (dev server only): treat every token as lasting this many seconds (e.g. 120), to
// watch refreshes happen. A build ignores it: its dev knobs are compiled out (__VAULT_DEV__ = false).
// VAULT_FAKE_BROKER (dev server only): the local fake broker's origin (vault/fakebroker.ts), e.g.
// http://127.0.0.1:5191. The dev vault's MQTT URL and REST base point at it, and the dev CSP's connect-src
// adds exactly that origin (http + ws). A build ignores it: production URLs and CSP are fixed.
// VAULT_SIMULATE=<session_key> (dev server only): simulate mode. The dev server replays data/raw/<key>/ as a live
// session (simserver.ts at /__sim/: the feed for the in-vault simulated broker, REST, /token, the faults), the
// dev frame's connect-src adds 'self' (its own origin: nothing under the app's), and the frame runs src/sim.ts.
// VAULT_SIMULATE_SPEED, _START (s from lights out), _TOKEN_S, _DROP_EVERY (min), _REFUSE_AT (min), _JITTER
// (ms): see simserver.ts. A build ignores all of it (__VAULT_SIMULATE__ = false; e2e checks dist/).

import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv, type Plugin } from "vite";
import { COMMON_HEADERS, formatHeaders, headerRules, pageHeaders, pageOf } from "./headers.ts";
import { handleProxy, type ProxyOpts } from "./proxy.ts";
import { SimServer, simOptionsFromEnv } from "./simserver.ts";
import { DEFAULT_APP_ORIGINS, parseOrigins } from "./src/origins.ts";

const root = fileURLToPath(new URL(".", import.meta.url));
const repo = fileURLToPath(new URL("..", import.meta.url));
const env = (name: string) => process.env[name] || loadEnv("", repo, "")[name] || "";

const appOrigins = parseOrigins(env("VAULT_APP_ORIGINS") || DEFAULT_APP_ORIGINS);
const VERSION = "0.1.0";

/**
 * The build: a hash of the vault's source (src/, not the tests). In the version, so frames of different builds never
 * share a leader (tabs.ts, lockNames): a tab still open from before a deploy runs the old code.
 */
function buildHash(): string {
  const h = createHash("sha256");
  for (const f of readdirSync(`${root}src`).filter((n) => n.endsWith(".ts") && !n.endsWith(".test.ts")).sort()) h.update(f).update(readFileSync(`${root}src/${f}`));
  return h.digest("hex").slice(0, 10);
}

/** VAULT_FAKE_EXPIRES_IN as whole seconds (0: off), bounded like debug:fakeExpiry. */
function fakeExpiresIn(): number {
  const raw = env("VAULT_FAKE_EXPIRES_IN");
  if (!raw) return 0;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 20 || n > 3600) throw new Error(`VAULT_FAKE_EXPIRES_IN: whole seconds, 20 to 3600 (got ${raw})`);
  return n;
}

/** VAULT_FAKE_BROKER as an origin (""; off). Only a local http origin: this is for a broker on this machine. */
function fakeBroker(): string {
  const raw = env("VAULT_FAKE_BROKER");
  if (!raw) return "";
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`VAULT_FAKE_BROKER: an origin like http://127.0.0.1:5191 (got ${raw})`);
  }
  if (u.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(u.hostname) || !u.port || u.origin !== raw.replace(/\/$/, ""))
    throw new Error(`VAULT_FAKE_BROKER: http://127.0.0.1:PORT or http://localhost:PORT only (got ${raw})`);
  return u.origin;
}

/** The dev server's extra connect-src (the fake broker's http and ws origins; 'self' in simulate mode), or none. */
function devConnect(dev: boolean): string[] {
  const f = dev ? fakeBroker() : "";
  return [...(f ? [f, f.replace(/^http/, "ws")] : []), ...(dev && env("VAULT_SIMULATE") ? ["'self'"] : [])];
}

/**
 * The build-time constants (__VAULT_APP_ORIGINS__, __VAULT_VERSION__, __VAULT_DEV__,
 * __VAULT_FAKE_EXPIRES_IN__), replaced in vault source. Not Vite's `define`: in dev that relies on the Vite
 * client, which the vault pages don't load. A build always gets __VAULT_DEV__ = false, whatever the
 * environment says, so the dev knobs (src/debug.ts) are dropped from it.
 */
function vaultConstants(): Plugin {
  let version = `${VERSION}+${buildHash()}`;
  let dev = false;
  let fake = 0;
  let broker = "";
  let simulate = false;
  return {
    name: "vault-constants",
    configResolved(config) {
      dev = config.command === "serve";
      if (dev) {
        version = `${VERSION}-dev+${buildHash()}`;
        fake = fakeExpiresIn();
        broker = fakeBroker();
        simulate = !!env("VAULT_SIMULATE");
      }
    },
    transform(code, id) {
      if (!id.startsWith(`${root}src/`)) return;
      return code
        .replaceAll("__VAULT_APP_ORIGINS__", JSON.stringify(appOrigins))
        .replaceAll("__VAULT_VERSION__", JSON.stringify(version))
        .replaceAll("__VAULT_DEV__", JSON.stringify(dev))
        .replaceAll("__VAULT_FAKE_EXPIRES_IN__", JSON.stringify(fake))
        .replaceAll("__VAULT_FAKE_BROKER__", JSON.stringify(broker))
        .replaceAll("__VAULT_SIMULATE__", JSON.stringify(simulate));
    },
  };
}

/** The dev server's simulation, if it runs one (the pass-through answers from it). */
let simServer: SimServer | null = null;

/** Simulate mode (dev server only): the simulation's endpoints at /__sim/ (simserver.ts). */
function vaultSimulate(): Plugin {
  return {
    name: "vault-simulate",
    apply: "serve",
    configureServer(server) {
      const opts = simOptionsFromEnv(env);
      if (!opts) return;
      const sim = (simServer = new SimServer(repo, opts, (s) => server.config.logger.info(s)));
      server.middlewares.use((req, res, next) => {
        if (!sim.handle(req, res)) next();
      });
    },
  };
}

/**
 * The REST pass-through at /openf1/v1/ (proxy.ts), as the production Worker runs it: to OpenF1, or to the simulation
 * (in-process) or the fake broker when the dev server uses one.
 */
function vaultProxy(): Plugin {
  return {
    name: "vault-proxy",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith("/openf1/")) return next();
        void (async () => {
          const pick = (name: string) => (typeof req.headers[name] === "string" ? [[name, req.headers[name] as string] as [string, string]] : []);
          const request = new Request(new URL(req.url!, `http://${req.headers.host ?? "localhost"}`), {
            method: req.method,
            headers: [...pick("sec-fetch-site"), ...pick("authorization"), ...pick("accept")],
          });
          const broker = fakeBroker();
          const opts: ProxyOpts = simServer ? { fetch: simServer.fetchRest as typeof fetch } : broker ? { upstream: `${broker}/v1/` } : {};
          const response = await handleProxy(request, opts);
          res.statusCode = response.status;
          response.headers.forEach((v, k) => res.setHeader(k, v));
          res.end(Buffer.from(await response.arrayBuffer()));
        })().catch(next);
      });
    },
  };
}

/** The production headers, on the dev server too. */
function vaultHeaders(): Plugin {
  return {
    name: "vault-headers",
    configureServer(server) {
      // Dev server only: the fake broker's origin, if VAULT_FAKE_BROKER is set. The build's _headers never has it.
      const extra = devConnect(true);
      server.middlewares.use((req, res, next) => {
        const page = pageOf(new URL(req.url ?? "/", "http://vault").pathname);
        for (const [k, v] of Object.entries(page ? pageHeaders(page, appOrigins, page === "frame" ? extra : []) : COMMON_HEADERS)) res.setHeader(k, v);
        next();
      });
    },
    // No Vite client in dev pages: with HMR off it only opens a WebSocket that the production CSP (rightly)
    // blocks. So dev runs under exactly the production CSP.
    transformIndexHtml: {
      order: "post",
      handler: (html) => html.replace(/\s*<script type="module" src="\/@vite\/client"><\/script>/, ""),
    },
    generateBundle() {
      this.emitFile({ type: "asset", fileName: "_headers", source: formatHeaders(headerRules(appOrigins)) });
    },
  };
}

export default defineConfig({
  root,
  base: "/",
  appType: "mpa",
  publicDir: false,
  // Nothing from .env reaches vault code (it reads no import.meta.env): only vaultConstants().
  envPrefix: "VAULT_PUBLIC_",
  plugins: [vaultConstants(), vaultHeaders(), vaultSimulate(), vaultProxy()],
  server: {
    port: 5174,
    strictPort: true,
    host: true,
    // No HMR: its WebSocket would need a looser connect-src than production.
    hmr: false,
    allowedHosts: ["localhost", "127.0.0.1", ...env("VAULT_ALLOWED_HOSTS").split(",").filter(Boolean)],
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2022",
    modulePreload: { polyfill: false },
    // Unminified: the deployed code should read like the audited source.
    minify: false,
    rolldownOptions: {
      input: { frame: `${root}frame.html`, popup: `${root}popup.html` },
    },
  },
});
