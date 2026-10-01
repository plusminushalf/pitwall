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
/** How requests are paced: at most `perMinute` starts in any 60 s, and at least `gapMs` between two starts. */
export interface Pace {
  perMinute: number;
  gapMs: number;
}
// 24 a minute: the free tier's 30/min, less room for the page's own requests (the calendar, a session lookup) from
// the same IP. At ~27/min, a race download with requests in flight in parallel (ingestCore) hit a 429 once the
// catalogue's 4 requests counted in the same minute (vault:e2e --downloads, 2026-09-30). In a burst (the start of a
// download, which a replay is waiting for) 2/s: 0.4 s apart drew 429s (Retry-After: 1, the free tier's 3/s) when
// connection set-up jitter brought four within a second (race 11377, 2026-10-01).
export const FREE_PACE: Pace = { perMinute: 24, gapMs: 500 };
export const SPONSOR_PACE: Pace = { perMinute: 54, gapMs: 250 }; // under 60/min and 6/s, with the same margin
const MAX_RETRIES = 5;
const TOKEN_MARGIN_MS = 5 * 60_000; // refresh tokens this long before they expire

/** Request starts reserved in the last minute (ascending): each request reserves its slot, so concurrent callers stay paced too. */
let starts: number[] = [];
/** No request starts before this (the gap after the last one, or a rate-limit backoff). */
let nextSlotAt = 0;
let paceOverride: Pace | null = null;

/** The earliest start for the next request, at or after `now` and `notBefore`, given the starts reserved before it. */
export function nextStart(reserved: readonly number[], now: number, notBefore: number, pace: Pace): number {
  const at = Math.max(now, notBefore);
  const k = reserved.length - pace.perMinute;
  return k >= 0 ? Math.max(at, reserved[k]! + 60_000) : at;
}

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

/**
 * Requests that started elsewhere in the last minute (ms since epoch): an earlier worker's in the same browser, which
 * OpenF1 counts against the same IP. The pace makes room for them.
 */
export function seedRequestStarts(at: readonly number[]): void {
  const now = Date.now();
  starts = [...starts, ...at.filter((t) => t > now - 60_000 && t <= now)].sort((a, b) => a - b);
  if (starts.length) nextSlotAt = Math.max(nextSlotAt, starts[starts.length - 1]! + FREE_PACE.gapMs);
}

/** Test hook: a fixed gap between requests and no per-minute cap (null = the tier's pace). */
export function setRequestInterval(ms: number | null): void {
  paceOverride = ms == null ? null : { perMinute: Infinity, gapMs: ms };
  starts = [];
  nextSlotAt = 0;
}

/**
 * Resolves once a request could start at the tier's pace (without reserving it), leaving `reserve` of the minute's
 * requests for others: a caller that picks what to request when it can go (ingest's telemetry slices, from wherever
 * the replay is by then) waits here first.
 */
export async function untilRequestSlot(reserve = 0): Promise<void> {
  for (;;) {
    const base = paceOverride ?? (credentialSource() ? SPONSOR_PACE : FREE_PACE);
    const pace = { ...base, perMinute: Math.max(1, base.perMinute - reserve) };
    const now = Date.now();
    starts = starts.filter((t) => t > now - 60_000);
    const wait = nextStart(starts, now, nextSlotAt, pace) - now;
    if (wait <= 0) return;
    await sleep(wait);
  }
}

/**
 * One request, started when the tier's pace allows (Pace). Safe with concurrent callers (ingest runs several
 * requests at once): each one reserves its start before it waits.
 */
async function throttledFetch(url: string, bearer: string | null): Promise<Response> {
  const pace = paceOverride ?? (bearer ? SPONSOR_PACE : FREE_PACE);
  const now = Date.now();
  starts = starts.filter((t) => t > now - 60_000);
  const at = nextStart(starts, now, nextSlotAt, pace);
  starts.push(at);
  nextSlotAt = at + pace.gapMs;
  if (at > now) await sleep(at - now);
  const t0 = Date.now();
  const res = await fetch(url, {
    signal: AbortSignal.timeout(120_000),
    ...(bearer ? { headers: { Authorization: `Bearer ${bearer}` } } : {}),
  });
  requestObserver?.({ url, status: res.status, ms: Date.now() - t0 });
  return res;
}

/**
 * The query string. A name with a comparison suffix is written the way OpenF1 reads it, `date>=2024-03-02` (as
 * the vault does, vault/src/rest.ts): `date%3E%3D=2024-03-02` (URLSearchParams) reads as `date >= "=2024-03-02"`.
 */
export function queryString(params: Record<string, string | number>): string {
  return Object.entries(params)
    .map(([k, v]) => {
      const m = /^(.*?)(>=|<=|>|<)?$/.exec(k)!;
      return `${encodeURIComponent(m[1]!)}${m[2] ?? "="}${encodeURIComponent(String(v))}`;
    })
    .join("&");
}

export async function fetchEndpoint<T>(
  endpoint: string,
  params: Record<string, string | number>,
): Promise<T[]> {
  const url = `${BASE}/${endpoint}?${queryString(params)}`;

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
    // (A first 429 is usually the per-second limit: OpenF1 says Retry-After: 1.)
    const backoff = retryAfter > 0 ? retryAfter * 1000 : res.status === 429 && attempt === 0 ? 2_000 : 5_000 * 2 ** attempt;
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
