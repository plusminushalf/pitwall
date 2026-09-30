// Dev-only testing knobs for the token refresh. frame.ts uses this module only behind `__VAULT_DEV__`,
// which vite.config.ts replaces with `false` in `vault:build`, so the bundler drops it: a production vault
// has no debug methods (parseRequest rejects them as unknown types) and no fake expiry. Otherwise any app
// code could make the vault spoil its token or hammer /token.
//
// - fake expiry (VAULT_FAKE_EXPIRES_IN on the dev server, or debug:fakeExpiry): every new token is treated
//   as lasting that many seconds (never longer than its real lifetime), so a refresh cycle takes minutes.
// - debug:spoilToken: the token in hand is sent corrupted (one signature character changed) until the
//   next token replaces it, so the next authenticated get gets a real 401 from OpenF1 and takes the
//   refresh-and-retry path.
// - debug:refreshNow: a refresh now, through the scheduler (coalesced, backoff on failure).
// - debug:failToken: the next N /token calls answer 401 / 429 / 503 without reaching OpenF1, to try the
//   backoff and the "reconnect" path by hand (e2e fakes them with Playwright routes instead).

import { TOKEN_URL, type Fetch, type Token } from "./openf1";
import type { DebugMethod, Request } from "./protocol";
import type { TokenSource } from "./rest";
import type { TokenScheduler } from "./scheduler";

/** Change one character in the middle of the JWT signature (the last one may only carry padding bits). */
export function corrupt(token: string): string {
  const dot = token.lastIndexOf(".");
  const i = dot >= 0 && token.length - dot > 12 ? dot + 8 : Math.floor(token.length / 2);
  return token.slice(0, i) + (token[i] === "A" ? "B" : "A") + token.slice(i + 1);
}

export class DevKnobs {
  private fakeSeconds: number;
  /** The real token that's being sent corrupted, until the scheduler replaces it. */
  private spoiled: string | null = null;
  private fault: { status: number; left: number } | null = null;

  constructor(
    private scheduler: TokenScheduler,
    fakeExpiresIn: number,
    private status: () => unknown,
  ) {
    this.fakeSeconds = fakeExpiresIn;
  }

  /** For CoreDeps.tokenFilter. */
  filter = (t: Token): Token => (this.fakeSeconds > 0 ? { ...t, expiresAt: Math.min(t.expiresAt, t.issuedAt + this.fakeSeconds * 1000) } : t);

  /** For CoreDeps.fetch: /token with the injected failures. */
  tokenFetch(real: Fetch): Fetch {
    return (url, init) => {
      const f = this.fault;
      if (url !== TOKEN_URL || !f || f.left <= 0) return real(url, init);
      f.left--;
      const body = f.status === 401 ? '{"detail":"Incorrect username or password (debug:failToken)"}' : `<html>${f.status} (debug:failToken)</html>`;
      return Promise.resolve({ status: f.status, text: async () => body });
    };
  }

  /** The scheduler as REST sees it, with the spoiled token swapped in. */
  tokens(): TokenSource {
    return {
      current: () => {
        const t = this.scheduler.current();
        if (t === null || t !== this.spoiled) return t;
        return corrupt(t);
      },
      onUnauthorized: (used) => this.scheduler.onUnauthorized(this.spoiled !== null && used === corrupt(this.spoiled) ? this.spoiled : used),
    };
  }

  async handle(req: Request<DebugMethod>): Promise<unknown> {
    switch (req.type) {
      case "debug:spoilToken":
        this.spoiled = this.scheduler.current();
        break;
      case "debug:fakeExpiry":
        this.fakeSeconds = req.seconds;
        break;
      case "debug:refreshNow":
        await this.scheduler.refresh();
        break;
      case "debug:failToken":
        this.fault = req.times > 0 ? { status: req.status, left: req.times } : null;
        break;
    }
    return this.status();
  }
}
