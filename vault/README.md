# The OpenF1 credential vault

A tiny static site, deployed on a **different site** (registrable domain) from the app, that will be the only
code ever to see a user's OpenF1 password or access token. The app embeds it as a hidden iframe and gets
data from it, never credentials. Design and reasoning: `docs/modular-hypotheses.md`, H2.4 (why a separate
site), H2.5 (the protocol), H2.10 (live streams and token refresh) and H2.11 (weak points and defences).

Status: spike S3, step 2 of 6. The handshake, the protocol, the headers, the popup login and both storage
modes (stay connected, passkey PRF) work: the frame gets one token on connect / unlock / restore and
reports its expiry. Refresh, MQTT, `get` and the cross-tab leader are later steps (`not_implemented`).

## What's here

| File | What it is |
| --- | --- |
| `frame.html`, `src/frame.ts` | The hidden iframe: checks who embeds it, does the handshake, serves the protocol |
| `popup.html`, `src/popup.ts`, `src/popup.css` | The login / unlock popup, on the vault's own address; runs the passkey prompts |
| `src/protocol.ts` | The message protocol (app <-> frame, popup <-> frame) and its validators: the single source of truth (the app imports its types) |
| `src/core.ts` | The vault's state: stored login, in-memory password and token, the popup it's waiting for. No DOM |
| `src/storage.ts` | What's stored and how: the swappable `Secret`, AES-GCM sealing (device key / passkey PRF), IndexedDB |
| `src/openf1.ts` | `POST /token` and parsing its response |
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
bun run vault:e2e       # browser checks against the built vault (--dev: against the dev server)
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
| `status` | | `{state, mode?, account?, tokenExpiresAt?, error?, live, version}` |
| `connect` | `ticket` | status. The app has just opened the popup with this ticket; the frame expects it |
| `unlock` | `ticket` | status. The same, for a passkey-locked login (state `locked` only) |
| `cancel` | `ticket` | status. The popup closed: stop expecting it, drop a half-done passkey setup |
| `disconnect` | | status. Wipes storage and memory, and the frames in other tabs |
| `subscribe` / `unsubscribe` | `topics`: 1–32 distinct names from `LIVE_TOPICS` | `{topics}` |
| `get` | `endpoint` from `REST_ENDPOINTS`, `params` (≤ 8, names from `PARAM_KEYS` with optional `>`, `<`, `>=`, `<=`; finite numbers or ≤ 64 chars of `[A-Za-z0-9 :.+_-]`) | `{status, body: ArrayBuffer}` |
| `openPort` | one transferred `MessagePort` | `{}`; the port then speaks this protocol too (≤ 8 ports) |

There is no method that returns a password or a token, and there never will be. Status changes are pushed
as `{v:1, type:"event", event:"status", status}`. `state` is one of `unavailable` (storage blocked),
`disconnected`, `locked` (passkey, not unlocked yet), `connecting`, `connected`, `error` (a stored login stopped
working: `error.code` says why). `account` is masked (`d***@example.com`); `tokenExpiresAt` is ms since the epoch.

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
