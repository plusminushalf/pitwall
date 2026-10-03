// The vault's REST pass-through: GET /openf1/v1/<endpoint>?<query> on the vault's own site, forwarded to
// https://api.openf1.org/v1/<endpoint>?<query> with the caller's Authorization header. Run by the Cloudflare Worker in
// front of the vault's static files (worker.ts) and by the vault dev server (vite.config.ts), so dev matches production.
//
// Why: during a live session (from about 30 minutes before it until 30 minutes after) OpenF1 answers the CORS
// preflight of every /v1/* request with 401 and no Access-Control-* headers, so a browser can't send a request with an
// Authorization header to it at all. Measured 2026-10-03 during qualifying:
//   curl -i -X OPTIONS https://api.openf1.org/v1/sessions -H 'Origin: https://pitwall-auth.garvit.in' \
//     -H 'Access-Control-Request-Method: GET' -H 'Access-Control-Request-Headers: authorization'
// The token can only travel in that header (no query parameter works). The vault frame calls this same-origin (no
// preflight) when a request with a token can't reach OpenF1 directly (src/rest.ts).
//
// Rules: GET only; only the frame (Sec-Fetch-Site: same-origin); only the endpoints and parameters the vault's `get`
// accepts (src/protocol.ts); only with a bearer token (never a free-tier proxy for anonymous requests). Only the
// Authorization and Accept headers go on; no cookies; nothing is cached, logged or stored.

import { params as validParams, REST_ENDPOINTS, type Params } from "./src/protocol.ts";
import { restUrl } from "./src/rest.ts";

export const PROXY_PREFIX = "/openf1/v1/";
export const UPSTREAM = "https://api.openf1.org/v1/";
/** Under the vault's own 120 s per request (a download's telemetry can be 5 MB). */
export const PROXY_TIMEOUT_MS = 110_000;

/** On every answer: nothing cached, nothing sniffed or embedded, nothing runs. */
const HEADERS: Readonly<Record<string, string>> = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
};

/** Token characters (a JWT, base64url, or base64). */
const BEARER = /^Bearer [A-Za-z0-9._~+/=-]{1,4096}$/;

const deny = (status: number, detail: string) => new Response(JSON.stringify({ detail }), { status, headers: { ...HEADERS, "Content-Type": "application/json" } });

/** The query as `get` params (`date>=2026-...` -> {"date>=": "2026-..."}), or null when it isn't one `get` accepts. */
export function parseQuery(search: string): Params | null {
  const out: Params = {};
  const parts = search.replace(/^\?/, "").split("&").filter(Boolean);
  for (const part of parts) {
    let raw: string;
    try {
      raw = decodeURIComponent(part.replaceAll("+", " "));
    } catch {
      return null;
    }
    const m = /^([a-z_]+)(>=|<=|>|<|=)(.*)$/.exec(raw);
    if (!m) return null;
    const key = m[2] === "=" ? m[1]! : `${m[1]}${m[2]}`;
    if (key in out) return null;
    out[key] = m[3]!;
  }
  return validParams(out) ? out : null;
}

export type ProxyOpts = { upstream?: string; fetch?: typeof fetch; timeoutMs?: number };

/** Answer one request to PROXY_PREFIX. */
export async function handleProxy(req: Request, opts: ProxyOpts = {}): Promise<Response> {
  const url = new URL(req.url);
  if (req.method !== "GET") return deny(405, "GET only");
  if (req.headers.get("sec-fetch-site") !== "same-origin") return deny(403, "only the vault's own pages");
  const endpoint = url.pathname.startsWith(PROXY_PREFIX) ? url.pathname.slice(PROXY_PREFIX.length) : "";
  if (!(REST_ENDPOINTS as readonly string[]).includes(endpoint)) return deny(404, "Not Found");
  const query = parseQuery(url.search);
  if (!query) return deny(400, "query not allowed");
  const auth = req.headers.get("authorization") ?? "";
  if (!BEARER.test(auth)) return deny(401, "a bearer token is required");
  let res: Response;
  try {
    res = await (opts.fetch ?? fetch)(restUrl(endpoint as (typeof REST_ENDPOINTS)[number], query, opts.upstream ?? UPSTREAM), {
      method: "GET",
      headers: { Authorization: auth, Accept: req.headers.get("accept") || "application/json" },
      redirect: "manual",
      signal: AbortSignal.timeout(opts.timeoutMs ?? PROXY_TIMEOUT_MS),
    });
  } catch (e) {
    return deny((e as Error)?.name === "TimeoutError" ? 504 : 502, "couldn't reach OpenF1");
  }
  if (res.status < 200 || (res.status >= 300 && res.status < 400) || res.status > 599) return deny(502, `OpenF1 answered ${res.status}`);
  const headers: Record<string, string> = { ...HEADERS, "Content-Type": res.headers.get("content-type") ?? "application/json" };
  const retryAfter = res.headers.get("retry-after");
  if (retryAfter) headers["Retry-After"] = retryAfter;
  return new Response(res.status === 204 || res.status === 205 ? null : res.body, { status: res.status, headers });
}
