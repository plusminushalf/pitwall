// Which app origins may embed and talk to the vault. Pure: used by the frame, the build and the tests.

/** The default for local development: the app's Vite dev server. */
export const DEFAULT_APP_ORIGINS = "http://localhost:5173,http://127.0.0.1:5173";

/**
 * Parse a comma-separated origin list (VAULT_APP_ORIGINS). Each entry must be exactly an http(s) origin:
 * scheme, host and optional port, no path, no trailing slash, no wildcard. Throws on anything else, so a
 * typo fails the build instead of silently allowing nothing (or too much).
 */
export function parseOrigins(csv: string): string[] {
  const list = csv
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!list.length) throw new Error("VAULT_APP_ORIGINS: no origins");
  for (const o of list) {
    let url: URL;
    try {
      url = new URL(o);
    } catch {
      throw new Error(`VAULT_APP_ORIGINS: not a URL: ${o}`);
    }
    if ((url.protocol !== "https:" && url.protocol !== "http:") || url.origin !== o || o.includes("*")) {
      throw new Error(`VAULT_APP_ORIGINS: not an exact http(s) origin: ${o} (expected ${url.origin})`);
    }
  }
  return [...new Set(list)];
}

/** Exact string match only. "null" (opaque origins) is never allowed. */
export const isAllowed = (origin: unknown, allowed: readonly string[]): origin is string =>
  typeof origin === "string" && origin !== "null" && allowed.includes(origin);

/**
 * The embedding app's origin, if the vault may talk to it: the frame's direct parent (Chromium's
 * location.ancestorOrigins[0]), and only when that is allowlisted. Null for a top-level page too.
 */
export function parentOrigin(ancestorOrigins: ArrayLike<string> | undefined, allowed: readonly string[]): string | null {
  const o = ancestorOrigins?.[0];
  return isAllowed(o, allowed) ? o : null;
}

/**
 * Whether a window message is the app's hello: from our own parent window (not another frame or popup)
 * and from the allowlisted origin we sent "ready" to.
 */
export const fromParent = (e: { origin: string; source: unknown }, parent: unknown, expectedOrigin: string, allowed: readonly string[]) =>
  e.source === parent && e.origin === expectedOrigin && isAllowed(e.origin, allowed);
