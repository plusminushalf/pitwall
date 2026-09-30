# The OpenF1 credential vault

A tiny static site, deployed on a **different site** (registrable domain) from the app, that will be the only
code ever to see a user's OpenF1 password or access token. The app embeds it as a hidden iframe and gets
data from it, never credentials. Design and reasoning: `docs/modular-hypotheses.md`, H2.4 (why a separate
site), H2.5 (the protocol), H2.10 (live streams and token refresh) and H2.11 (weak points and defences).

Status: spike S3, step 3 of 6. The handshake, the protocol, the headers, the popup login, both storage
modes (stay connected, passkey PRF), silent token refresh and a one-at-a-time `get` work. MQTT, the
cross-tab leader and parallel downloads are later steps (`subscribe` answers `not_implemented`).

## What's here

| File | What it is |
| --- | --- |
| `frame.html`, `src/frame.ts` | The hidden iframe: checks who embeds it, does the handshake, serves the protocol |
| `popup.html`, `src/popup.ts`, `src/popup.css` | The login / unlock popup, on the vault's own address; runs the passkey prompts |
| `src/protocol.ts` | The message protocol (app <-> frame, popup <-> frame) and its validators: the single source of truth (the app imports its types) |
| `src/core.ts` | The vault's state: stored login, in-memory password and token, the popup it's waiting for. No DOM |
| `src/storage.ts` | What's stored and how: the swappable `Secret`, AES-GCM sealing (device key / passkey PRF), IndexedDB |
| `src/openf1.ts` | `POST /token` and parsing its response |
| `src/scheduler.ts` | The token refresh schedule (pure: injected clock, timers, `/token`) |
| `src/rest.ts` | `get`: OpenF1 REST reads, authenticated when there's a token, retried once after a 401 |
| `src/debug.ts` | Dev-only testing knobs (fake expiry, spoil the token, refresh now); not in a build |
| `src/origins.ts` | The app-origin allowlist: parsing `VAULT_APP_ORIGINS`, matching the parent |
| `src/rpc.ts` | Request dispatch over a `MessagePort` |
| `headers.ts` | Every response header (CSP and the rest): one source for dev, `_headers` and `serve.ts` |
| `vite.config.ts` | Dev server and build (Vite is a build tool only: no runtime npm dependencies) |
| `serve.ts` | Serves `dist/` locally with exactly the headers in `dist/_headers` |
| `e2e.ts` | Browser checks (Playwright, Chromium), including the real login from `.env` |
| `leakcheck.ts` | The secret-leak check from the app's origin (heap snapshot + all app-origin storage), reused by e2e |

The build is unminified, so the deployed JavaScript reads like this source.

## Running it

```sh
bun run vault           # dev server, http://localhost:5174 (no HMR, no Vite client: reload by hand)
bun run vault:build     # vault/dist, with dist/_headers for Netlify / Cloudflare Pages
bun run vault:serve     # dist/ on :5174 with the production headers
bun run vault:e2e       # browser checks against the built vault (--dev: against the dev server; --quick: skip the 5-min refresh run)
```

The app finds the vault at `VITE_VAULT_ORIGIN` (default `http://localhost:5174`; `off` disables it). Open the
app with `?vault=debug` for a debug panel (handshake state, origin, `status` round-trip time).

Configuration, baked in at build time (shell or the repo's `.env`):

- `VAULT_APP_ORIGINS`: comma-separated exact app origins allowed to embed the vault. Default
  `http://localhost:5173,http://127.0.0.1:5173`. It sets both the frame's allowlist and its CSP
  `frame-ancestors`, so the two can't disagree. A self-hosted fork sets this plus the app's
  `VITE_VAULT_ORIGIN` (H2.11).
- `VAULT_ALLOWED_HOSTS` (dev server only): extra Host names to answer, beyond localhost and
  127.0.0.1 (e.g. a tunnel's public hostname).
- `VAULT_FAKE_EXPIRES_IN` (dev server only, 20–3600): treat every token as lasting that many seconds, to
  watch refreshes happen. A build ignores it (see "Dev knobs").

Test cross-site, as production runs: the app at `http://127.0.0.1:5173`, the vault at `http://localhost:5174`.
`vault:e2e` launches Chromium with storage partitioning on and `--site-per-process` (Playwright's defaults turn
the first off, and headless Chromium here doesn't isolate every site), and checks both.
Two subdomains of one domain (e.g. two `*.example.dev` URLs) are the *same site*: fine for trying
the flow, but they don't exercise the process isolation a separate domain gives.

## The protocol

All in `src/protocol.ts`. Version `v: 1` on every message.

1. The app mounts `<iframe src="VAULT/frame.html" hidden>`.
2. The frame reads its parent's origin from `location.ancestorOrigins[0]` (Chromium). If it isn't on the
   allowlist, or the page isn't framed at all, the frame does nothing.
3. The frame posts `{v:1, type:"ready"}` to `window.parent`, with that exact origin as `targetOrigin`.
4. The app answers `{v:1, type:"hello"}`, transferring one `MessagePort`. The frame accepts it only if
   `event.source === window.parent`, `event.origin` is the allowlisted origin from step 3, and the message is
   exactly that shape with exactly one port. It accepts one hello per page load, then stops listening to
   window messages altogether.
5. From then on, only the port. Requests `{v:1, id, type, ...args}`, responses `{v:1, id, ok:true, result}`
   or `{v:1, id, ok:false, error:{code, message}}`, and unsolicited `{v:1, type:"event", ...}`.

| Method | Arguments | Result |
| --- | --- | --- |
| `status` | | `{state, mode?, account?, error?, live, version}` plus the refresh status (below) |
| `connect` | `ticket` | status. The app has just opened the popup with this ticket; the frame expects it |
| `unlock` | `ticket` | status. The same, for a passkey-locked login (state `locked` only) |
| `cancel` | `ticket` | status. The popup closed: stop expecting it, drop a half-done passkey setup |
| `disconnect` | | status. Wipes storage and memory, and the frames in other tabs |
| `subscribe` / `unsubscribe` | `topics`: 1–32 distinct names from `LIVE_TOPICS` | `{topics}` |
| `get` | `endpoint` from `REST_ENDPOINTS`, `params` (≤ 8, names from `PARAM_KEYS` with optional `>`, `<`, `>=`, `<=`; finite numbers or ≤ 64 chars of `[A-Za-z0-9 :.+_-]`) | `{status, body: ArrayBuffer, auth}` (body transferred); `network` error if OpenF1 can't be reached |
| `openPort` | one transferred `MessagePort` | `{}`; the port then speaks this protocol too (≤ 8 ports) |

There is no method that returns a password or a token, and there never will be. Status changes are pushed
as `{v:1, type:"event", event:"status", status}`. `state` is one of `unavailable` (storage blocked),
`disconnected`, `locked` (passkey, not unlocked yet), `connecting`, `connected`, `error` (a stored login stopped
working: `error.code` says why). `account` is masked (`d***@example.com`).

The refresh status, while a login is in memory (all times ms since the epoch): `tokenExpiresAt`,
`nextRefreshAt`, `lastRefresh {at, ok, error?}`, `refreshCount` (silent refreshes since the login),
`needsReauth`, and `refresh`: `scheduled`, `refreshing`, `retrying` (the token still works), `expired` (it
doesn't), or `stopped` (`needsReauth`). Every change is pushed as a status event.

## Token refresh

`src/scheduler.ts`, built on the facts in docs/modular-hypotheses.md (no refresh token, so a refresh is the
password grant again; new tokens don't invalidate old ones; REST 401s from the first second after `exp`;
`/token` 429s bursts):

- Refresh at 5/6 of the lifetime (50 min for 3600 s), counted from when the `/token` request was **sent**
  (local clock; errs early by one round trip). The lifetime is `expires_in`, or the JWT's `exp - iat` if that
  is shorter (a lifetime, so local clock skew doesn't matter). Neither is ever logged.
- A failure retries with exponential backoff and ±20% jitter: 5 s, 10 s, 20 s … capped at 2 min; a 429
  starts at 30 s. Once the token has expired the phase is `expired`, `get` goes unauthenticated, and
  retries continue at the cap. A `/token` call that hangs for 30 s counts as a network failure.
- A 401 from `/token` (password changed or revoked) stops retrying: `needsReauth`, the current token is used
  until it expires, and the app shows "Reconnect your OpenF1 account". When it expires the state becomes
  `error` (`wrong_credentials`), like a restore with a changed password. Reconnecting (the popup) clears it.
- Refreshes are coalesced: one `/token` call in flight, whoever asks.
- A REST 401 (later also MQTT) refreshes at once and the request is retried once with the new token.
  If the token it used has already been replaced, it just retries. If the token was issued under 10 s ago,
  OpenF1 is refusing fresh tokens: no refresh, the 401 goes back to the caller, `get` goes unauthenticated
  and the next try is at the 2-minute cap (`lastRefresh.error: "rejected"`). During a backoff a 401 never
  skips it. So a flood of 401s costs at most about one `/token` call per 2 minutes.
- Timers are armed against absolute times and never sleep more than 60 s; `visibilitychange` (visible)
  and `online` re-check the wall clock, since background tabs throttle timers and a sleeping laptop stops
  them. `online` also retries a network failure at once.
- A restore that fails for a network reason (offline at load) shows `error` and keeps retrying; the first
  success moves it to `connected`.

`get` without a valid token (no login, locked, expired while refreshes fail, rejected) is sent
unauthenticated: historical data is free (3 req/s, 30/min), so the app keeps working, and `auth: false`
says so. Live windows need the login. One request at a time for now; step 6 adds parallel requests within
the rate caps.

## Dev knobs

For trying the refresh paths by hand and in `e2e.ts`. `src/debug.ts` is used only behind `__VAULT_DEV__`,
which the build replaces with `false` (whatever the environment says), so the bundler drops it: a production
vault rejects the debug methods as unknown types and has no fake expiry (e2e checks both, and that
`dist/` has none of it). Otherwise any app code could make the vault spoil its token or hammer `/token`.

| Method (dev vault only) | Arguments | What it does |
| --- | --- | --- |
| `debug:fakeExpiry` | `seconds`: 0 or 20–3600 | New tokens count as lasting that long (never longer than the real lifetime). Starts at `VAULT_FAKE_EXPIRES_IN` |
| `debug:spoilToken` | | The token in hand is sent with one signature character changed until the next token: a real OpenF1 401 |
| `debug:refreshNow` | | A refresh now, through the scheduler (coalesced, backoff on failure) |
| `debug:failToken` | `status`: 401, 429 or 503; `times`: 0–10 | The next `times` `/token` calls answer that status without reaching OpenF1 |

By hand: `VAULT_FAKE_EXPIRES_IN=120 bun run vault`, `bun run dev`, open `http://127.0.0.1:5173/?vault=debug`,
Connect. The debug panel shows the refresh phase, next refresh, last result and count, plus buttons: get
`/v1/sessions?session_key=latest` (status, bytes, authenticated or not), Spoil token (then get: still 200,
one more refresh; wait 10 s after a refresh first, or the fresh-token guard gives up), Refresh now, Fake
120 s tokens (from the next token), Real expiry, `/token 503 ×2` (then a refresh: watch it retry after
about 5 s and 10 s and recover) and `/token 401` (then a refresh: the reconnect banner, while gets keep
working until the token expires; Reconnect or Disconnect clears it). e2e fakes the same `/token` answers
with Playwright routes instead, on the real network path.

## Login

Chrome partitions the iframe's storage by the app's site, so the popup (top level, the vault's own storage)
and the frame don't share IndexedDB. The popup stores nothing: it hands the login to the frame.

1. The user clicks Connect in the app. `VaultClient.connect()` opens `popup.html#mode=connect&ticket=T`
   synchronously in that click (window name `f1-vault`, so a second click reuses the window), then sends
   `connect {ticket:T}` to its frame. `T` is 128 random bits.
2. The popup posts `popup:hello {ticket}` to every `opener.frames[i]` with targetOrigin = the vault origin.
   Only the frame expecting `T` answers (to `event.source`); other vault frames stay quiet. The frame binds the
   ticket to that popup window. A popup nobody answers within 4 s says it has expired. Tickets expire after
   10 minutes and are single-use.
3. The user submits the form (JS only; `form-action 'none'`). `popup:login {username, password, mode}` goes to
   the frame, which calls `POST https://api.openf1.org/token` and answers ok, or `wrong_credentials` (401),
   `rate_limited` (429), `network`, `server`. The popup shows the error or closes itself.
4. Storage (`src/storage.ts`):
   - **Stay connected** (default): an AES-GCM-256 key from `generateKey` with `extractable: false`, stored as a
     CryptoKey in the frame's IndexedDB beside the ciphertext. Restored silently on every load.
   - **Passkey**: the login is checked first (so a typo doesn't leave a useless passkey), then the popup
     creates a discoverable passkey (`rp.id` = the vault's hostname, user verification required) with the
     `prf` extension, falling back to a `get()` if `create()` returns no PRF output. The frame turns the 32-byte
     output into a non-extractable AES key with HKDF, stores ciphertext + PRF salt + HKDF salt + credential id,
     and nothing derived. On load the state is `locked`; Unlock opens the popup in unlock mode, which runs
     `get()` with PRF and sends the output. Without PRF support, the popup says so and offers stay-connected.
   - Both: the password and the token live only in frame memory. Only the masked account is stored in clear.
     If OpenF1 ever offers refresh tokens or API keys, add a kind to `Secret` and store that instead.

The popup offers the browser's password manager the login (`PasswordCredential`) before closing, since the
form never submits.

Validation (`parseRequest`) is hand-written and total: it never throws. It rejects non-plain objects,
unknown types, missing or extra fields, wrong types, unknown endpoints, topics and parameter names, oversized
strings and arrays, and the wrong number of transferred ports. A rejected request with a usable `id` gets a
`bad_request` error; one without is dropped. A handler that throws answers a generic `internal` error, never
the exception's message.

## Headers

From `headers.ts`, identical in dev, in `dist/_headers` and in `serve.ts`:

- `frame.html`: `Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src https://api.openf1.org wss://mqtt.openf1.org:8084; base-uri 'none'; form-action 'none'; frame-ancestors <VAULT_APP_ORIGINS>`
- `popup.html`: the same, but `frame-ancestors 'none'`. The popup makes no requests at all; the frame does.
- Every response: `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`,
  `Cross-Origin-Resource-Policy: cross-origin` (so the frame still loads if the app ever enables COEP).
- Deliberately **no** `Cross-Origin-Opener-Policy`: the popup must keep `window.opener` to reach the vault
  frame inside the app.
- No inline scripts or styles anywhere. The dev server strips Vite's client script (with HMR off it would only
  open a WebSocket the CSP blocks), so dev runs under exactly the production CSP too.

`frame-ancestors` checks every ancestor, not just the parent: a hostile site that frames the app can't get a
working vault inside it (`e2e.ts` checks this).

## Threat model

See H2.11. In short: the separate site keeps the password out of reach of app code, npm packages in the app
and marketplace blocks; the popup on the vault's own address stops fake in-app login forms; the allowlist
plus `frame-ancestors` stop other sites embedding the vault or talking to it. Not defended: a compromised
vault release (hence tiny code, a separate deploy, reviewed tagged releases, a published build hash) and
malware or all-sites extensions on the device.
