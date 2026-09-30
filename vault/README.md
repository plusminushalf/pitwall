# The OpenF1 credential vault

A tiny static site, deployed on a **different site** (registrable domain) from the app, that will be the only
code ever to see a user's OpenF1 password or access token. The app embeds it as a hidden iframe and gets
data from it, never credentials. Design and reasoning: `docs/modular-hypotheses.md`, H2.4 (why a separate
site), H2.5 (the protocol), H2.10 (live streams and token refresh) and H2.11 (weak points and defences).

Status: spike S3, step 1 of 6. The handshake, the protocol with its validation, the headers and `status`
work. Every other method answers `not_implemented`. Nothing is stored and nothing talks to OpenF1 yet.

## What's here

| File | What it is |
| --- | --- |
| `frame.html`, `src/frame.ts` | The hidden iframe: checks who embeds it, does the handshake, serves the protocol |
| `popup.html`, `src/popup.css` | The setup popup, on the vault's own address (placeholder until step 2) |
| `src/protocol.ts` | The message protocol and its validators: the single source of truth (the app imports its types) |
| `src/origins.ts` | The app-origin allowlist: parsing `VAULT_APP_ORIGINS`, matching the parent |
| `src/rpc.ts` | Request dispatch over a `MessagePort` |
| `headers.ts` | Every response header (CSP and the rest): one source for dev, `_headers` and `serve.ts` |
| `vite.config.ts` | Dev server and build (Vite is a build tool only: no runtime npm dependencies) |
| `serve.ts` | Serves `dist/` locally with exactly the headers in `dist/_headers` |
| `e2e.ts` | Browser checks (Playwright, Chromium) |

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
| `status` | | `{account, storage, live, version}` |
| `connect` | | status (step 2: login in the popup) |
| `disconnect` | | status |
| `subscribe` / `unsubscribe` | `topics`: 1–32 distinct names from `LIVE_TOPICS` | `{topics}` |
| `get` | `endpoint` from `REST_ENDPOINTS`, `params` (≤ 8, names from `PARAM_KEYS` with optional `>`, `<`, `>=`, `<=`; finite numbers or ≤ 64 chars of `[A-Za-z0-9 :.+_-]`) | `{status, body: ArrayBuffer}` |
| `openPort` | one transferred `MessagePort` | `{}`; the port then speaks this protocol too (≤ 8 ports) |

There is no method that returns a password or a token, and there never will be.

Validation (`parseRequest`) is hand-written and total: it never throws. It rejects non-plain objects,
unknown types, missing or extra fields, wrong types, unknown endpoints, topics and parameter names, oversized
strings and arrays, and the wrong number of transferred ports. A rejected request with a usable `id` gets a
`bad_request` error; one without is dropped. A handler that throws answers a generic `internal` error, never
the exception's message.

## Headers

From `headers.ts`, identical in dev, in `dist/_headers` and in `serve.ts`:

- `frame.html`: `Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src https://api.openf1.org wss://mqtt.openf1.org:8084; base-uri 'none'; form-action 'none'; frame-ancestors <VAULT_APP_ORIGINS>`
- `popup.html`: the same, but `frame-ancestors 'none'`.
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
