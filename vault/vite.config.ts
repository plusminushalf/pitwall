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

import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv, type Plugin } from "vite";
import { COMMON_HEADERS, formatHeaders, headerRules, pageHeaders, pageOf } from "./headers.ts";
import { DEFAULT_APP_ORIGINS, parseOrigins } from "./src/origins.ts";

const root = fileURLToPath(new URL(".", import.meta.url));
const repo = fileURLToPath(new URL("..", import.meta.url));
const env = (name: string) => process.env[name] || loadEnv("", repo, "")[name] || "";

const appOrigins = parseOrigins(env("VAULT_APP_ORIGINS") || DEFAULT_APP_ORIGINS);
const VERSION = "0.1.0";

/** VAULT_FAKE_EXPIRES_IN as whole seconds (0: off), bounded like debug:fakeExpiry. */
function fakeExpiresIn(): number {
  const raw = env("VAULT_FAKE_EXPIRES_IN");
  if (!raw) return 0;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 20 || n > 3600) throw new Error(`VAULT_FAKE_EXPIRES_IN: whole seconds, 20 to 3600 (got ${raw})`);
  return n;
}

/**
 * The build-time constants (__VAULT_APP_ORIGINS__, __VAULT_VERSION__, __VAULT_DEV__,
 * __VAULT_FAKE_EXPIRES_IN__), replaced in vault source. Not Vite's `define`: in dev that relies on the Vite
 * client, which the vault pages don't load. A build always gets __VAULT_DEV__ = false, whatever the
 * environment says, so the dev knobs (src/debug.ts) are dropped from it.
 */
function vaultConstants(): Plugin {
  let version = VERSION;
  let dev = false;
  let fake = 0;
  return {
    name: "vault-constants",
    configResolved(config) {
      dev = config.command === "serve";
      if (dev) {
        version = `${VERSION}-dev`;
        fake = fakeExpiresIn();
      }
    },
    transform(code, id) {
      if (!id.startsWith(`${root}src/`)) return;
      return code
        .replaceAll("__VAULT_APP_ORIGINS__", JSON.stringify(appOrigins))
        .replaceAll("__VAULT_VERSION__", JSON.stringify(version))
        .replaceAll("__VAULT_DEV__", JSON.stringify(dev))
        .replaceAll("__VAULT_FAKE_EXPIRES_IN__", JSON.stringify(fake));
    },
  };
}

/** The production headers, on the dev server too. */
function vaultHeaders(): Plugin {
  return {
    name: "vault-headers",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const page = pageOf(new URL(req.url ?? "/", "http://vault").pathname);
        for (const [k, v] of Object.entries(page ? pageHeaders(page, appOrigins) : COMMON_HEADERS)) res.setHeader(k, v);
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
  plugins: [vaultConstants(), vaultHeaders()],
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
