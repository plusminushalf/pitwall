// The vault's HTTP response headers: the one source of truth for the Vite dev server (vite.config.ts),
// the built _headers file (Netlify / Cloudflare Pages format) and the local static server (serve.ts),
// so they cannot drift apart.

/**
 * Where the vault may connect: OpenF1's REST API and its MQTT-over-WebSocket broker, and its own origin for the REST
 * pass-through (proxy.ts, `/openf1/v1/`: OpenF1 refuses browsers' CORS preflight during live sessions). Nothing else.
 */
export const OPENF1_CONNECT = ["https://api.openf1.org", "wss://mqtt.openf1.org:8084", "'self'"] as const;

export type Page = "frame" | "popup";

/** Paths each page is served at (Cloudflare Pages also serves /frame.html as /frame). */
export const PAGE_PATHS: Record<Page, readonly string[]> = {
  frame: ["/frame.html", "/frame"],
  popup: ["/popup.html", "/popup"],
};

/**
 * The Content-Security-Policy of a page. frame.html may be embedded only by the app origins; the popup by
 * nobody. `devConnect` adds connect-src sources for the dev server only (empty in production).
 */
export function csp(page: Page, appOrigins: readonly string[], devConnect: readonly string[] = []): string {
  if (!appOrigins.length) throw new Error("csp: no app origins");
  return [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self'",
    `connect-src ${[...new Set([...OPENF1_CONNECT, ...devConnect])].join(" ")}`,
    "base-uri 'none'",
    "form-action 'none'",
    `frame-ancestors ${page === "frame" ? appOrigins.join(" ") : "'none'"}`,
  ].join("; ");
}

/**
 * Headers on every response. Deliberately no Cross-Origin-Opener-Policy: the setup popup must keep
 * window.opener to reach the vault frame inside the app. CORP cross-origin lets the frame load inside an
 * app that one day turns on COEP.
 */
export const COMMON_HEADERS: Readonly<Record<string, string>> = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Resource-Policy": "cross-origin",
  // no-transform: a CDN in front (Cloudflare) must serve the files as built, e.g. not inject its analytics
  // script into the pages (the CSP would block it, but nothing else belongs in them). The rest is the static
  // host's default: always revalidate.
  "Cache-Control": "public, max-age=0, must-revalidate, no-transform",
};

/** Anything that isn't a page (404s, stray files): nothing may run, nothing may embed it. */
export const OTHER_CSP = "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

export const pageHeaders = (page: Page, appOrigins: readonly string[], devConnect: readonly string[] = []) => ({
  ...COMMON_HEADERS,
  "Content-Security-Policy": csp(page, appOrigins, devConnect),
});

/** Which page a request path is, if any. */
export function pageOf(pathname: string): Page | null {
  for (const page of ["frame", "popup"] as const) if (PAGE_PATHS[page].includes(pathname)) return page;
  return null;
}

// ---------------------------------------------------------------- the _headers file

export type HeaderRules = { path: string; headers: Record<string, string> }[];

/** Rules for the production build. Each page path gets its own CSP; `/*` the common headers. */
export function headerRules(appOrigins: readonly string[]): HeaderRules {
  return [
    { path: "/*", headers: { ...COMMON_HEADERS } },
    ...(["frame", "popup"] as const).flatMap((page) =>
      PAGE_PATHS[page].map((path) => ({ path, headers: { "Content-Security-Policy": csp(page, appOrigins) } })),
    ),
  ];
}

/** Netlify / Cloudflare Pages `_headers`: a path line, then indented `Name: value` lines. */
export const formatHeaders = (rules: HeaderRules) =>
  `${rules.map((r) => [r.path, ...Object.entries(r.headers).map(([k, v]) => `  ${k}: ${v}`)].join("\n")).join("\n")}\n`;

export function parseHeaders(text: string): HeaderRules {
  const rules: HeaderRules = [];
  for (const line of text.split("\n")) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    if (!/^\s/.test(line)) {
      rules.push({ path: line.trim(), headers: {} });
      continue;
    }
    const at = line.indexOf(":");
    if (at < 0 || !rules.length) throw new Error(`_headers: bad line: ${line}`);
    rules.at(-1)!.headers[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return rules;
}

/** The headers for a path under the rules, as the static hosts apply them: every matching rule, merged. */
export function headersFor(rules: HeaderRules, pathname: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of rules) {
    const match = r.path.endsWith("/*") ? pathname.startsWith(r.path.slice(0, -1)) : pathname === r.path;
    if (match) Object.assign(out, r.headers);
  }
  return out;
}
