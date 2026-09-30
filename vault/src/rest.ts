// `get`: OpenF1 REST reads, authenticated when the vault holds a valid token. Pure apart from the injected
// fetch, so bun can test it. One request at a time for now (step 6 adds parallelism within the rate caps).
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
export function restUrl(endpoint: RestEndpoint, params: Params): string {
  const parts = Object.entries(params).map(([k, v]) => {
    const m = /^(.*?)(>=|<=|>|<)?$/.exec(k)!;
    const name = encodeURIComponent(m[1]!);
    return `${name}${m[2] ?? "="}${encodeURIComponent(String(v))}`;
  });
  return `${REST_BASE}${endpoint}${parts.length ? `?${parts.join("&")}` : ""}`;
}

export class Rest {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private fetch: RestFetch,
    private tokens: TokenSource,
  ) {}

  /** One read, queued behind the others. Rejects only with RestError (the network). */
  get(endpoint: RestEndpoint, params: Params): Promise<GetResult> {
    const run = this.queue.then(() => this.run(restUrl(endpoint, params)));
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
