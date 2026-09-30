// `get`: OpenF1 REST reads, authenticated when the vault holds a valid token. Pure apart from the injected
// fetch, so bun can test it. One request at a time, paced under OpenF1's rate limits (Pacer; step 6 adds
// parallelism within them).
//
// A 401 on an authenticated request goes to the scheduler (onUnauthorized): it refreshes, or says the
// token that was used has already been replaced, and the request is retried once with the new token. If
// there's no valid token the request goes out unauthenticated: historical data needs no login.

import type { GetResult, Params, RestEndpoint } from "./protocol";

export const REST_BASE = "https://api.openf1.org/v1/";

export type RestFetch = (
  url: string,
  init: { method: "GET"; headers: Record<string, string>; credentials: "omit"; referrerPolicy: "no-referrer" },
) => Promise<{ status: number; arrayBuffer(): Promise<ArrayBuffer> }>;

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

/** OpenF1's published rate limits (docs/modular-hypotheses.md, facts): per second and per minute. */
export type RateLimit = { perSecond: number; perMinute: number };
export const AUTH_LIMIT: RateLimit = { perSecond: 6, perMinute: 60 };
export const ANON_LIMIT: RateLimit = { perSecond: 3, perMinute: 30 };

/**
 * The REST budget, until step 6 generalises it: request starts are spaced at least 1.15/perSecond apart (no
 * bursts, even of a few requests; the 15% is for network jitter, so the server never counts perSecond + 1 in
 * one second: measured against the simulation's limiter, which exact 1/perSecond spacing tripped) and at most
 * perMinute start in any 60 s. The leader alone spends it
 * (followers forward their gets), so it is per browser. Clock and sleep are injected for tests.
 */
/** ms per (1 / perSecond): 1000 plus a margin for jitter. */
export const SPACING = 1150;

export class Pacer {
  private starts: number[] = [];

  constructor(private clock: { now(): number; sleep(ms: number): Promise<void> }) {}

  /** Resolves when a request may start under `limit` (and counts it). */
  async take(limit: RateLimit): Promise<void> {
    for (;;) {
      const now = this.clock.now();
      while (this.starts.length && this.starts[0]! <= now - 60_000) this.starts.shift();
      const last = this.starts.at(-1);
      const spacing = last === undefined ? 0 : last + SPACING / limit.perSecond - now;
      const minute = this.starts.length >= limit.perMinute ? this.starts[this.starts.length - limit.perMinute]! + 60_000 - now : 0;
      const wait = Math.max(spacing, minute);
      if (wait <= 0) {
        this.starts.push(now);
        return;
      }
      await this.clock.sleep(Math.ceil(wait));
    }
  }
}

export class Rest {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private fetch: RestFetch,
    private tokens: TokenSource,
    /** REST_BASE; the dev vault can point it at the local fake broker (vault/fakebroker.ts) or the simulation. */
    private base = REST_BASE,
    /** The rate budget (frame.ts always passes one; unit tests may not). */
    private pacer: Pacer | null = null,
  ) {}

  /** One read, queued behind the others. Rejects only with RestError (the network). */
  get(endpoint: RestEndpoint, params: Params): Promise<GetResult> {
    const run = this.queue.then(() => this.run(restUrl(endpoint, params, this.base)));
    this.queue = run.catch(() => {});
    return run;
  }

  private async run(url: string): Promise<GetResult> {
    const token = this.tokens.current();
    const first = await this.once(url, token);
    if (first.status !== 401 || token === null) return first;
    if ((await this.tokens.onUnauthorized(token)) !== "retry") return first;
    const next = this.tokens.current();
    return next ? this.once(url, next) : first;
  }

  private async once(url: string, token: string | null): Promise<GetResult> {
    await this.pacer?.take(token ? AUTH_LIMIT : ANON_LIMIT);
    try {
      const res = await this.fetch(url, {
        method: "GET",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        credentials: "omit",
        referrerPolicy: "no-referrer",
      });
      return { status: res.status, body: await res.arrayBuffer(), auth: token !== null };
    } catch {
      throw new RestError("network");
    }
  }
}
