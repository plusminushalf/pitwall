// OpenF1 login: POST https://api.openf1.org/token. Pure apart from the injected fetch, so bun can test it.
//
// Verified 2026-09-30 (docs/modular-hypotheses.md, facts): a form body with username and password;
// 200 {"access_token", "token_type": "bearer", "expires_in": "3600"} with expires_in a STRING; 401 JSON
// for a wrong login; an nginx HTML 429 on bursts. No refresh token: a new token needs the password again.

import type { LoginError } from "./protocol";

export const TOKEN_URL = "https://api.openf1.org/token";

/**
 * The token lives only in vault memory. `issuedAt` is when the /token request was sent (local clock), and
 * `expiresAt` = issuedAt + its lifetime, both ms since the epoch. Counting from the send rather than the
 * receive time errs early by one round trip, which is the safe side: REST 401s from the first second after
 * `exp`.
 */
export type Token = { accessToken: string; issuedAt: number; expiresAt: number };

export type TokenResult = { ok: true; token: Token } | { ok: false; error: LoginError };

export const LOGIN_MESSAGES: Record<LoginError["code"], string> = {
  wrong_credentials: "OpenF1 didn't accept that email and password.",
  rate_limited: "OpenF1 is limiting login attempts right now. Wait a minute and try again.",
  network: "Couldn't reach OpenF1. Check your connection and try again.",
  server: "OpenF1 answered with an error. Try again in a moment.",
  storage: "The vault couldn't read or save your login on this device.",
  passkey: "That passkey didn't unlock your login.",
  expired: "This window has expired. Close it and click Connect in the app again.",
};

export const loginError = (code: LoginError["code"]): LoginError => ({ code, message: LOGIN_MESSAGES[code] });

/** Longest lifetime we believe (a day). Anything longer or non-positive is a response we can't read. */
const MAX_LIFETIME_S = 86_400;

/**
 * A /token response to a result. `now` is when the request was sent (so expiry errs early).
 * `expires_in` comes as a string ("3600"); a number is accepted too. Never throws.
 */
export function parseTokenResponse(status: number, body: string, now: number): TokenResult {
  if (status === 401 || status === 403) return { ok: false, error: loginError("wrong_credentials") };
  if (status === 429) return { ok: false, error: loginError("rate_limited") };
  if (status !== 200) return { ok: false, error: loginError("server") };
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return { ok: false, error: loginError("server") };
  }
  if (typeof json !== "object" || json === null) return { ok: false, error: loginError("server") };
  const { access_token, expires_in } = json as Record<string, unknown>;
  const seconds = typeof expires_in === "string" && /^\d{1,6}$/.test(expires_in) ? Number(expires_in) : typeof expires_in === "number" ? expires_in : NaN;
  if (typeof access_token !== "string" || access_token.length < 16 || access_token.length > 8192 || !Number.isInteger(seconds) || seconds <= 0 || seconds > MAX_LIFETIME_S) {
    return { ok: false, error: loginError("server") };
  }
  // Sanity check against the JWT's own claims: if exp - iat is shorter than expires_in, believe the JWT.
  // (A lifetime, not an absolute time, so a skewed local clock doesn't matter.) Never logged.
  const claimed = jwtLifetime(access_token);
  const lifetime = claimed !== null && claimed < seconds ? claimed : seconds;
  return { ok: true, token: { accessToken: access_token, issuedAt: now, expiresAt: now + lifetime * 1000 } };
}

/** `exp - iat` in seconds from a JWT's payload, or null if it isn't a JWT we can read. Never throws. */
export function jwtLifetime(jwt: string): number | null {
  const part = jwt.split(".")[1];
  if (!part || part.length > 4096) return null;
  try {
    const b64 = part.replaceAll("-", "+").replaceAll("_", "/");
    const claims: unknown = JSON.parse(atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4)));
    if (typeof claims !== "object" || claims === null) return null;
    const { iat, exp } = claims as Record<string, unknown>;
    if (typeof iat !== "number" || typeof exp !== "number" || !Number.isFinite(iat) || !Number.isFinite(exp)) return null;
    const life = exp - iat;
    return life > 0 && life <= MAX_LIFETIME_S ? life : null;
  } catch {
    return null;
  }
}

export type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; credentials: "omit"; referrerPolicy: "no-referrer" }) => Promise<{ status: number; text(): Promise<string> }>;

/** Exchange a username and password for a token. Never throws; never puts the password in an error. */
export async function requestToken(fetch: Fetch, username: string, password: string, now: () => number): Promise<TokenResult> {
  const sent = now();
  let res: { status: number; text(): Promise<string> };
  try {
    res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ username, password }).toString(),
      credentials: "omit",
      referrerPolicy: "no-referrer",
    });
  } catch {
    return { ok: false, error: loginError("network") };
  }
  let body = "";
  try {
    body = await res.text();
  } catch {
    return { ok: false, error: loginError("network") };
  }
  return parseTokenResponse(res.status, body, sent);
}
