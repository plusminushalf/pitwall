// Platform-agnostic OpenF1 HTTP client (fetch only, no file system, no process.env): rate-limited to
// stay under OpenF1's limits, retries on 429/5xx, optional OAuth bearer token. Shared by the Bun
// scripts (via scripts/openf1.ts, which supplies credentials from the environment) and the browser
// ingest worker (src/ingest/worker.ts, free tier: no credential source).
//
// Without credentials it uses the free tier (30 req/min, 3 req/s). With credentials (paid "sponsor"
// tier, needed for live sessions) requests carry a bearer token and may go faster (60 req/min, 6 req/s).

import type { RawCircuit } from "./openf1Types";

const BASE = "https://api.openf1.org/v1";
export const TOKEN_URL = "https://api.openf1.org/token";
// ~24 req/min: the free tier's 30/min, less room for the page's own requests (the calendar, a session lookup)
// from the same IP. At 2.2 s (~27/min), a race download with requests in flight in parallel (ingestCore) hit a 429
// once the catalogue's 4 requests counted in the same minute (vault:e2e --downloads, 2026-09-30).
const FREE_INTERVAL_MS = 2_500;
const SPONSOR_INTERVAL_MS = 1_100; // ~54 req/min
const MAX_RETRIES = 5;
const TOKEN_MARGIN_MS = 5 * 60_000; // refresh tokens this long before they expire

/** When the next request may start: each request reserves its slot, so concurrent callers stay spaced too. */
let nextSlotAt = 0;
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

/**
 * OpenF1 refused an anonymous (free-tier) request with 401/403: it locks free users out of every endpoint
 * while a session is live (from 30 min before it to 30 min after; the body says e.g. "Live F1 session in
 * progress"). Not worth retrying until the window is over.
 */
export class LiveWindowError extends Error {
  override name = "LiveWindowError";
  constructor(
    readonly status: number,
    readonly detail: string,
    message: string,
  ) {
    super(message);
  }
}

/** A request that will be retried after a 429 / 5xx, and how long until then. */
export interface RetryEvent {
  endpoint: string;
  status: number;
  waitMs: number;
}
let retryObserver: ((e: RetryEvent) => void) | null = null;

/** Observe retry waits (rate limits, server errors); null to stop. */
export function setRetryObserver(observer: ((e: RetryEvent) => void) | null): void {
  retryObserver = observer;
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
  nextSlotAt = 0;
}

/**
 * One request, started no sooner than the tier's interval after the previous start. Safe with concurrent
 * callers (ingest runs several requests at once): each one reserves the next slot before it waits.
 */
async function throttledFetch(url: string, bearer: string | null): Promise<Response> {
  const interval = intervalOverride ?? (bearer ? SPONSOR_INTERVAL_MS : FREE_INTERVAL_MS);
  const now = Date.now();
  const at = Math.max(now, nextSlotAt);
  nextSlotAt = at + interval;
  if (at > now) await sleep(at - now);
  const t0 = Date.now();
  const res = await fetch(url, {
    signal: AbortSignal.timeout(120_000),
    ...(bearer ? { headers: { Authorization: `Bearer ${bearer}` } } : {}),
  });
  requestObserver?.({ url, status: res.status, ms: Date.now() - t0 });
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
    // Expired or revoked token: get a fresh one and retry once. (Unless a concurrent request already has:
    // then the token in the cache is newer than the one this request used.)
    if (bearer && res.status === 401 && !reauthed) {
      reauthed = true;
      if (token?.value === bearer) invalidateToken();
      attempt--;
      continue;
    }
    if (!bearer && (res.status === 401 || res.status === 403)) {
      let detail = body.slice(0, 200);
      try {
        const parsed = JSON.parse(body) as { detail?: unknown; message?: unknown };
        detail = String(parsed.detail ?? parsed.message ?? detail);
      } catch {}
      throw new LiveWindowError(res.status, detail, `OpenF1 ${res.status} for ${url}: ${body.slice(0, 300)}`);
    }
    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt >= MAX_RETRIES) {
      throw new Error(`OpenF1 ${res.status} for ${url}: ${body.slice(0, 300)}`);
    }
    // Browsers can't read retry-after cross-origin (OpenF1 doesn't expose it), so there it's always the backoff.
    const retryAfter = Number(res.headers.get("retry-after"));
    const backoff = retryAfter > 0 ? retryAfter * 1000 : 5_000 * 2 ** attempt;
    console.warn(`  ${res.status} on ${endpoint}, retrying in ${backoff / 1000}s`);
    retryObserver?.({ endpoint, status: res.status, waitMs: backoff });
    // Over the limit: every other request waits too, not just this one.
    if (res.status === 429) nextSlotAt = Math.max(nextSlotAt, Date.now() + backoff);
    await sleep(backoff);
  }
}

/** Circuit map from the MultiViewer API (meeting.circuit_info_url): rotation, corners, trace. */
export async function fetchCircuit(url: string): Promise<RawCircuit> {
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as RawCircuit;
}
