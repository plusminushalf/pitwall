// Serve the built vault (vault/dist) the way the production static host does: static files only, with
// exactly the headers in dist/_headers (the file that gets deployed). For local testing of the real CSP.
//
//   bun run vault:build && bun run vault:serve      (VAULT_PORT, default 5174)

import { existsSync, statSync } from "node:fs";
import { join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { headersFor, OTHER_CSP, parseHeaders, COMMON_HEADERS } from "./headers";

const dist = fileURLToPath(new URL("./dist", import.meta.url));
const headersFile = join(dist, "_headers");
if (!existsSync(headersFile)) throw new Error("vault/dist/_headers missing: run `bun run vault:build` first");
const rules = parseHeaders(await Bun.file(headersFile).text());
const port = Number(process.env.VAULT_PORT || 5174);

/** A request path to a file in dist, or null (traversal, dotfiles, _headers, directories, missing). */
function fileFor(pathname: string): string | null {
  let path: string;
  try {
    path = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  // Pretty URLs like the static hosts: /frame serves frame.html.
  if (!/\.[a-z0-9]+$/i.test(path)) path += ".html";
  const file = normalize(join(dist, path));
  if (!file.startsWith(dist + "/") || /\/[._]/.test(file.slice(dist.length))) return null;
  return existsSync(file) && statSync(file).isFile() ? file : null;
}

const server = Bun.serve({
  port,
  hostname: "0.0.0.0",
  fetch(req) {
    const { pathname } = new URL(req.url);
    const file = req.method === "GET" || req.method === "HEAD" ? fileFor(pathname) : null;
    if (!file) return new Response("Not found\n", { status: 404, headers: { ...COMMON_HEADERS, "Content-Security-Policy": OTHER_CSP } });
    return new Response(Bun.file(file), { headers: headersFor(rules, pathname) });
  },
});
console.log(`vault (built) on http://localhost:${server.port}`);
