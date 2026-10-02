// `get`: OpenF1 REST reads, authenticated when the vault holds a valid token. Pure apart from the injected
// fetch, so bun can test it. Requests run in parallel, each started by the REST budget (budget.ts: OpenF1's rate
// limits, priorities, per-caller fairness, 429 backoff) when there is one.
//
// A 401 on an authenticated request goes to the scheduler (onUnauthorized): it refreshes, or says the
// token that was used has already been replaced, and the request is retried once with the new token. If
// there's no valid token the request goes out unauthenticated: historical data needs no login. A 429 is
// retried (up to RETRIES_429 times) once the budget's pause is over.

import type { Budget, Priority } from "./budget";
import type { GetResult, Params, RestEndpoint } from "./protocol";

export const REST_BASE = "https://api.openf1.org/v1/";

export type RestFetch = (
  url: string,
  init: { method: "GET"; headers: Record<string, string>; credentials: "omit"; referrerPolicy: "no-referrer"; timeoutMs: number },
) => Promise<{ status: number; arrayBuffer(): Promise<ArrayBuffer>; headers?: { get(name: string): string | null } }>;

export type TokenSource = {
  /** The token to send, or null (go unauthenticated). */
  current(): string | null;
  onUnauthorized(used: string): Promise<"retry" | "give_up">;
};

export class RestError extends Error {
  constructor(readonly code: "network") {
    super("couldn't reach OpenF1");
  }
}

/**
 * The URL for an (already validated) endpoint and params. A name with a comparison suffix is written the
 * way OpenF1 reads it: `date>=2024-03-02` (the URL parser percent-encodes `<` and `>`, OpenF1 decodes them).
 */
export function restUrl(endpoint: RestEndpoint, params: Params, base = REST_BASE): string {
  const parts = Object.entries(params).map(([k, v]) => {
    const m = /^(.*?)(>=|<=|>|<)?$/.exec(k)!;
    const name = encodeURIComponent(m[1]!);
    return `${name}${m[2] ?? "="}${encodeURIComponent(String(v))}`;
  });
  return `${base}${endpoint}${parts.length ? `?${parts.join("&")}` : ""}`;
}

/** OpenF1's published rate limits (docs/hypotheses.md, facts): per second and per minute. */
export type RateLimit = { perSecond: number; perMinute: number };
export const AUTH_LIMIT: RateLimit = { perSecond: 6, perMinute: 60 };
export const ANON_LIMIT: RateLimit = { perSecond: 3, perMinute: 30 };

/** ms per (1 / perSecond) between request starts: 1000 plus a margin for jitter (budget.ts). */
export const SPACING = 1150;
/** A 429 is retried this many times (after the budget's pause) before it goes back to the caller. */
export const RETRIES_429 = 3;
/** Per request (headers and body): live gap-fills must not hang; a download's telemetry can be 5 MB. */
export const TIMEOUT_MS = 120_000;

/** Who is asking (the budget's fairness unit), how urgent it is, and how long the request may take. */
export type RestOpts = { caller: string; priority?: Priority; timeoutMs?: number };

/** Retry-After as ms (seconds or an HTTP date), when the response has it (cross-origin, usually not readable). */
export function retryAfterMs(value: string | null | undefined, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const s = Number(value);
  if (Number.isFinite(s)) return s > 0 ? s * 1000 : undefined;
  const at = Date.parse(value);
  return Number.isFinite(at) && at > now ? at - now : undefined;
}

export class Rest {
  constructor(
    private fetch: RestFetch,
    private tokens: TokenSource,
    /** REST_BASE; the dev vault can point it at the local fake broker (vault/fakebroker.ts) or the simulation. */
    private base = REST_BASE,
    /** The rate budget (frame.ts always passes one; unit tests may not). */
    private budget: Pick<Budget, "acquire"> | null = null,
  ) {}

  /** One read, started when the budget allows. Rejects with RestError (the network) or the budget's BudgetError. */
  get(endpoint: RestEndpoint, params: Params, opts: RestOpts = { caller: "default" }): Promise<GetResult> {
    return this.run(restUrl(endpoint, params, this.base), opts);
  }

  private async run(url: string, opts: RestOpts): Promise<GetResult> {
    let retried401 = false;
    for (let tries429 = 0; ; ) {
      const slot = this.budget ? await this.budget.acquire(opts.caller, opts.priority ?? "normal", { front: tries429 > 0 || retried401 }) : null;
      // The token after the wait: the budget admitted it under the limits that apply to it now.
      const token = this.tokens.current();
      let res: GetResult & { retryAfterMs?: number };
      try {
        res = await this.once(url, token, opts.timeoutMs ?? TIMEOUT_MS);
      } catch (e) {
        slot?.release({ status: null });
        throw e;
      }
      slot?.release({ status: res.status, ...(res.retryAfterMs !== undefined && { retryAfterMs: res.retryAfterMs }) });
      const result: GetResult = { status: res.status, body: res.body, auth: res.auth };
      if (res.status === 429 && tries429 < RETRIES_429) {
        tries429++;
        continue;
      }
      if (res.status !== 401 || token === null || retried401) return result;
      if ((await this.tokens.onUnauthorized(token)) !== "retry" || !this.tokens.current()) return result;
      retried401 = true;
    }
  }

  private async once(url: string, token: string | null, timeoutMs: number): Promise<GetResult & { retryAfterMs?: number }> {
    try {
      const res = await this.fetch(url, {
        method: "GET",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        credentials: "omit",
        referrerPolicy: "no-referrer",
        timeoutMs,
      });
      const body = await res.arrayBuffer();
      const after = res.status === 429 ? retryAfterMs(res.headers?.get("retry-after")) : undefined;
      return { status: res.status, body, auth: token !== null, ...(after !== undefined && { retryAfterMs: after }) };
    } catch {
      throw new RestError("network");
    }
  }
}
