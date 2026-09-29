// Platform-agnostic OpenF1 HTTP client (fetch only, no file system, no process.env): rate-limited to
// stay under OpenF1's limits, retries on 429/5xx, optional OAuth bearer token. Shared by the Bun
// scripts (via scripts/openf1.ts, which supplies credentials from the environment) and the browser
// ingest worker (spikes/s1, free tier: no credential source).
//
// Without credentials it uses the free tier (30 req/min, 3 req/s). With credentials (paid "sponsor"
// tier, needed for live sessions) requests carry a bearer token and may go faster (60 req/min, 6 req/s).

import type { RawCircuit } from "./openf1Types";

const BASE = "https://api.openf1.org/v1";
export const TOKEN_URL = "https://api.openf1.org/token";
const FREE_INTERVAL_MS = 2_200; // ~27 req/min
const SPONSOR_INTERVAL_MS = 1_100; // ~54 req/min
const MAX_RETRIES = 5;
const TOKEN_MARGIN_MS = 5 * 60_000; // refresh tokens this long before they expire

let lastRequestAt = 0;
let intervalOverride: number | null = null;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface Credentials {
  username: string;
  password: string;
}

let credentialSource: () => Credentials | null = () => null;

/** Where accessToken() gets credentials from (scripts/openf1.ts: the environment). Default: none. */
export function setCredentialSource(source: () => Credentials | null): void {
  credentialSource = source;
}

/** One finished HTTP request to OpenF1 (for request / 429 counters). */
export interface RequestEvent {
  url: string;
  status: number;
  ms: number;
}
let requestObserver: ((e: RequestEvent) => void) | null = null;

/** Observe every OpenF1 data request (after its response headers arrive); null to stop. */
export function setRequestObserver(observer: ((e: RequestEvent) => void) | null): void {
  requestObserver = observer;
}

/** Thrown when OpenF1 refuses the credentials (bad username/password or no sponsor tier). */
export class AuthError extends Error {
  override name = "AuthError";
}

let token: { value: string; expiresAt: number; username: string } | null = null;
let tokenRequest: Promise<string> | null = null;

async function requestToken(creds: Credentials): Promise<string> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username: creds.username, password: creds.password }),
    signal: AbortSignal.timeout(30_000),
  });
  // Never echo the response: keep anything credential-related out of logs.
  if (res.status === 401 || res.status === 403) {
    throw new AuthError(`OpenF1 rejected the credentials (HTTP ${res.status}); check OPENF1_USERNAME / OPENF1_PASSWORD`);
  }
  if (!res.ok) throw new Error(`OpenF1 token request failed (HTTP ${res.status})`);
  const body = (await res.json()) as { access_token?: string; expires_in?: string | number };
  if (!body.access_token) throw new Error("OpenF1 token response has no access_token");
  const seconds = Number(body.expires_in);
  const lifetime = (Number.isFinite(seconds) && seconds > 0 ? seconds : 3600) * 1000;
  token = { value: body.access_token, expiresAt: Date.now() + lifetime, username: creds.username };
  return token.value;
}

/**
 * A valid access token, or null without credentials. Cached, refreshed a few minutes before it
 * expires (or immediately with `force`, e.g. after a 401); concurrent callers share one request.
 */
export async function accessToken(force = false): Promise<string | null> {
  const creds = credentialSource();
  if (!creds) return null;
  if (!force && token && token.username === creds.username && Date.now() < token.expiresAt - TOKEN_MARGIN_MS) return token.value;
  if (!tokenRequest) {
    tokenRequest = requestToken(creds).finally(() => {
      tokenRequest = null;
    });
  }
  return tokenRequest;
}

/** When the cached token expires (ms epoch), or null. */
export function tokenExpiresAt(): number | null {
  return token?.expiresAt ?? null;
}

/** Forget the cached token (next call fetches a new one). */
export function invalidateToken(): void {
  token = null;
}

/** Test hook: override the minimum gap between requests (null = tier default). */
export function setRequestInterval(ms: number | null): void {
  intervalOverride = ms;
  lastRequestAt = 0;
}

async function throttledFetch(url: string, bearer: string | null): Promise<Response> {
  const interval = intervalOverride ?? (bearer ? SPONSOR_INTERVAL_MS : FREE_INTERVAL_MS);
  const wait = lastRequestAt + interval - Date.now();
  if (wait > 0) await sleep(wait);
  lastRequestAt = Date.now();
  const res = await fetch(url, {
    signal: AbortSignal.timeout(120_000),
    ...(bearer ? { headers: { Authorization: `Bearer ${bearer}` } } : {}),
  });
  requestObserver?.({ url, status: res.status, ms: Date.now() - lastRequestAt });
  return res;
}

export async function fetchEndpoint<T>(
  endpoint: string,
  params: Record<string, string | number>,
): Promise<T[]> {
  const qs = new URLSearchParams(
    Object.entries(params).map(([k, v]): [string, string] => [k, String(v)]),
  );
  const url = `${BASE}/${endpoint}?${qs}`;

  let reauthed = false;
  for (let attempt = 0; ; attempt++) {
    const bearer = await accessToken();
    const res = await throttledFetch(url, bearer);
    if (res.ok) return (await res.json()) as T[];
    // OpenF1 answers 404 {"detail":"No results found."} for empty queries.
    if (res.status === 404) return [];

    const body = await res.text();
    // Expired or revoked token: get a fresh one and retry once.
    if (bearer && res.status === 401 && !reauthed) {
      reauthed = true;
      invalidateToken();
      attempt--;
      continue;
    }
    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt >= MAX_RETRIES) {
      throw new Error(`OpenF1 ${res.status} for ${url}: ${body.slice(0, 300)}`);
    }
    // Browsers can't read retry-after cross-origin (OpenF1 doesn't expose it), so there it's always the backoff.
    const retryAfter = Number(res.headers.get("retry-after"));
    const backoff = retryAfter > 0 ? retryAfter * 1000 : 5_000 * 2 ** attempt;
    console.warn(`  ${res.status} on ${endpoint}, retrying in ${backoff / 1000}s`);
    await sleep(backoff);
  }
}

/** Circuit map from the MultiViewer API (meeting.circuit_info_url): rotation, corners, trace. */
export async function fetchCircuit(url: string): Promise<RawCircuit> {
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as RawCircuit;
}
