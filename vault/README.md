# The OpenF1 credential vault

A tiny static site, deployed on a **different site** (registrable domain) from the app, that will be the only
code ever to see a user's OpenF1 password or access token. The app embeds it as a hidden iframe and gets
data from it, never credentials. Design and reasoning: `docs/modular-hypotheses.md`, H2.4 (why a separate
site), H2.5 (the protocol), H2.10 (live streams and token refresh) and H2.11 (weak points and defences).

Note: OpenF1's auth docs say the token exchange should happen in a backend. The vault does it in the browser
on purpose (each user brings their own OpenF1 account; there is no shared backend login), isolated on its own
site. It's an experiment, not something OpenF1 endorses.

Status: spike S3, all 6 steps. The handshake, the protocol, the headers, the popup login, both storage
modes (stay connected, passkey PRF), silent token refresh, `get` in parallel within one REST budget per browser,
the live MQTT stream (token handover, reconnect + REST gap-fill), the cross-tab leader (with heartbeat takeover
from a frozen leader), the simulate mode (a cached session replayed as live, dev only) and signed-in downloads
(the download worker talks to the vault over its own port, and falls back to the free tier on its own) work.
The S3 success check runs as `bun run vault:e2e --s3`, the download check as `bun run vault:e2e --downloads`.

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
| `src/rest.ts` | `get`: OpenF1 REST reads, authenticated when there's a token, retried once after a 401, a 429 after the budget's pause |
| `src/budget.ts` | The REST budget: OpenF1's rate limits, parallel requests, live gap-fills first, callers taking turns, 429 backoff (pure) |
| `src/mqtt.ts` | A hand-written MQTT 3.1.1-over-WebSocket client (the subset the vault needs; no dependencies) |
| `src/live.ts` | The live stream: sessions, handover, CONNACK 5, reconnect, REST gap-fill, dedupe, batching (pure) |
| `src/tabs.ts` | The cross-tab leader (Web Locks) and the BroadcastChannel among vault frames (pure) |
| `src/debug.ts` | Dev-only testing knobs (fake expiry, spoil the token, refresh now); not in a build |
| `src/freeze.ts` | Dev-only `debug:freeze`: freeze one frame like Chrome freezes a background tab; not in a build |
| `src/sim.ts` | Dev-only simulate mode: the in-vault simulated broker (MQTT bytes behind a socket); not in a build |
| `src/brokercodec.ts` | The broker side of the MQTT codec (for the fake and simulated brokers only) |
| `src/origins.ts` | The app-origin allowlist: parsing `VAULT_APP_ORIGINS`, matching the parent |
| `src/rpc.ts` | Request dispatch over a `MessagePort` |
| `headers.ts` | Every response header (CSP and the rest): one source for dev, `_headers` and `serve.ts` |
| `vite.config.ts` | Dev server and build (Vite is a build tool only: no runtime npm dependencies) |
| `serve.ts` | Serves `dist/` locally with exactly the headers in `dist/_headers` |
| `e2e.ts` | Browser checks (Playwright, Chromium), including the real login from `.env` |
| `leakcheck.ts` | The secret-leak check from the app's origin (heap snapshot + all app-origin storage), reused by e2e |
| `fakebroker.ts` | Dev/test only, never shipped: a local fake OpenF1 broker (MQTT over WS) and REST, with controls |
| `testkit.ts` | Test helpers: a fake clock, fake sockets, an in-memory broker |
| `simdata.ts` | Dev/test only: data/raw/<key> turned into the timeline a live session publishes (server/simulate.ts's rules), and REST over it |
| `simserver.ts` | Dev only: the vault dev server's `/__sim/` endpoints (feed, REST, /token, sessions, faults) |
| `s3.ts` | The S3 success check (`vault:e2e --s3`) |
| `downloads.ts` | The download check (`vault:e2e --downloads`, also in the full run): direct vs through the vault vs the vault gone mid-download |

The build is unminified, so the deployed JavaScript reads like this source.

## Running it

```sh
bun run vault           # dev server, http://localhost:5174 (no HMR, no Vite client: reload by hand)
bun run vault:build     # vault/dist, with dist/_headers for Netlify / Cloudflare Pages
bun run vault:serve     # dist/ on :5174 with the production headers
bun run vault:deploy    # build for the app at pitwall.plusminushalf.com, upload to pitwall-auth.garvit.in (Cloudflare; CI does it on every push to main)
bun run vault:e2e       # browser checks against the built vault (--dev: against the dev server; --quick: skip the 5-min refresh run)
bun run vault:e2e --s3  # only the S3 success check: a simulated session in two tabs, ~22 min (needs data/raw/11291)
bun run vault:e2e --downloads  # only the download check, ~6 min (the real login from .env; race 11377 three times)
bun vault/fakebroker.ts # a local fake OpenF1 broker on :5191 (see "The live stream")
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
| `status` | | `{state, mode?, account?, error?, live, version, stream?, tab?, budget?}` plus the refresh status (below) |
| `connect` | `ticket` | status. The app has just opened the popup with this ticket; the frame expects it |
| `unlock` | `ticket` | status. The same, for a passkey-locked login (state `locked` only) |
| `cancel` | `ticket` | status. The popup closed: stop expecting it, drop a half-done passkey setup |
| `disconnect` | | status. Wipes storage and memory, and the frames in other tabs |
| `subscribe` / `unsubscribe` | `topics`: 1–32 distinct names from `LIVE_TOPICS` | `{topics}`: this port's topics after the change |
| `get` | `endpoint` from `REST_ENDPOINTS`, `params` (≤ 8, names from `PARAM_KEYS` with optional `>`, `<`, `>=`, `<=`; finite numbers or ≤ 64 chars of `[A-Za-z0-9 :.+_-]`) | `{status, body: ArrayBuffer, auth}` (body transferred); `network` error if OpenF1 can't be reached, `rate_limited` if this port has 128 queued already. Runs in parallel within the REST budget (below) |
| `openPort` | one transferred `MessagePort` | `{}`; the port then speaks this protocol too (≤ 8 ports; at the cap the `openPort` port idle longest, with nothing pending, is dropped for the new one) |
| `close` | | `{}`, then nothing more on this port: its queued gets are dropped, its subscriptions removed (MessagePorts have no close event: measured in Chrome 153, not even when the other end's worker is terminated) |

There is no method that returns a password or a token, and there never will be. Status changes are pushed
as `{v:1, type:"event", event:"status", status}`. Live data is pushed as `{v:1, type:"event", event:"data",
topic, messages}`: batches every ~150 ms, one event per topic, only topics that port subscribed to, each
message once and in `date` order within a batch, parsed JSON as OpenF1 sent it (MQTT ones carry `_id` and
`_key`, gap-filled REST rows don't). In the app: `getVault().onData((topic, messages) => …)`. `state` is one of `unavailable` (storage blocked),
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
says so. Live windows need the login. Every `get` goes through the REST budget (below).

## The REST budget

`src/budget.ts`, owned by the leader frame (followers forward their gets, so it is one budget per browser and
account; see "Tabs"). Pure, tested with a fake clock (`budget.test.ts`).

- **Limits**: OpenF1's (docs/modular-hypotheses.md, facts): 6 requests/s and 60/min with a token (sponsor tier),
  3/s and 30/min without, whichever applies when a request may start. Starts are spaced 1.15 / perSecond apart
  (no bursts; the 15% is for network jitter, measured against the simulation's limiter) and at most perMinute
  start in any 60 s. Within that, requests run **in parallel**: at most 8 in flight.
- **Priorities**: live gap-fills first (caller `live`, priority `live`). While the stream runs, everything else
  leaves 14 of each minute's requests (one per topic) for them, so a gap-fill after a drop never waits for a
  download's minute to roll over.
- **Fairness**: each app port is a caller (`<frame id>/p<n>`: the app's main port, the download worker's, one per
  future module); callers take turns, one start each (round robin), none has more than 6 in flight or 128
  queued (then `rate_limited`). So one busy or misbehaving caller can't starve the others, and whatever it asks,
  the account stays under OpenF1's limits. A closed port (`close`), a dropped one (the cap) or a closed tab
  (its frame lock gone, or its `bye`) has its queued gets dropped.
- **429**: everything pauses (Retry-After if the response lets us read it, which cross-origin it usually
  doesn't; else 2 s doubling to 60 s, jittered) and the limits are halved for a minute; the request is retried
  up to 3 times after the pause, then its 429 goes back to the caller.
- **401**: the refresh-and-retry-once path above, the retry through the budget too.
- **Takeover**: the leader's heartbeat carries its request starts of the last minute; a frame that takes over
  counts them against its own minute.
- **Timeouts**: 120 s per request (a download's telemetry is ~5 MB), 30 s for gap-fills. A forwarded get waits
  as long as it needs in the leader's queue while the leader is alive (a download's worth of requests can be
  ahead of it), and fails once the leader has been silent for 35 s (or after 10 minutes in all).
- `status.budget`: `{auth, perSecond, perMinute, inFlight, queued, usedThisMinute, callers, reserve, started,
  rateLimited, pausedUntil?, shrunkUntil?}`, pushed at most every 500 ms; the debug panel shows it.

## Downloads through the vault

The app's download worker (`src/ingest/worker.ts`) gets its own port: the page creates a MessageChannel, hands one
end to the vault (`openPort`) and transfers the other to the worker (`src/ingest/runner.ts`), so requests go
worker <-> vault with nothing relayed on the main thread. The worker asks the vault's `status`
(`src/ingest/vaultPort.ts`): signed in with a working token, its requests go through the vault's `get` (the
account's limits, 6 at a time in the ingest core); otherwise (no login, locked, no vault) straight to OpenF1 at
the free tier's pace as before. If the vault stops answering mid-download (the worker pings `status` every 2 s
while requests are pending; 5 s without an answer and it's down) or loses its token (an `auth: false` answer),
the rest of the download, requests in flight included, goes direct: no failure, no prompt. The worker only ever
receives response bodies (the protocol has no message that carries a token); `vault:e2e --downloads` searches
its heap mid-download for the password and `eyJhbGciOi`. The worker sends `close` when it's done; on cancel the
page tells it first and terminates it 200 ms later. The Library's progress line says "fast (signed in)" or
"free tier". The ingest core (`scripts/lib/ingestCore.ts`) runs its requests concurrently (6 through the vault, 3
direct, 4 in the CLI) in the order it always did, keeps what's downloaded when one fails, and resumes from it.

Measured by `vault:e2e --downloads` (race 11377, 57 OpenF1 requests, 2026-09-30, this 2-vCPU VM): direct 144 s,
through the vault 36 s (6 in flight, 57 requests in 34 s), the vault gone after 18 requests 113 s; no 429 in
any run; the processed output identical in all three and to the CLI's. The direct path's pacing went from 2.2 s
to 2.5 s between requests (~24/min): at 2.2 s with requests in parallel, a download hit a 429 once the page's own
calendar requests counted in the same minute.

## The live stream

`src/mqtt.ts` + `src/live.ts`, run by the leader frame (below) for the union of every tab's subscriptions. The
broker facts it's built on (docs/modular-hypotheses.md, facts): the password is the token; the username must be the account's email (measured 2026-09-30 while building
this step: any other username gets CONNACK 5 even with a valid token, correcting the facts table); at
most 10 connections per account, the 11th refused with CONNACK 5, **the same code as an expired token**; a
reused clientId kicks the older session; an open session outlives its token (the broker checks only at
CONNECT).

- MQTT 3.1.1 over `wss://mqtt.openf1.org:8084/mqtt`, subprotocol `mqtt`, binary frames (one frame may hold
  part of a packet or several). Clean session, keepalive **90 s**: a PINGREQ after 45 s without sending, checked
  by a timer and also on every inbound packet; no answer within 10 s and the session is dead. Why 90: a hidden
  tab's timers can be aligned to one minute (Chrome's intensive throttling), so the timer's ping can go out as
  late as ~105 s after the last packet, still inside the broker's 1.5 x keepalive = 135 s; while data flows the
  inbound check sends it on time anyway. The price: a silent dead link takes up to ~55 s to notice (a live
  session is never silent that long). QoS 0 subscriptions; a QoS 1 PUBLISH is PUBACKed anyway.
- Every session gets a fresh random clientId (from the CSPRNG).
- **Handover** on every new token: open session B with it, subscribe, and 2 s after B's SUBACK close A (not at
  once: a message published just before B subscribed can still be in flight on A's socket). Never a third
  session: a handover waits for the previous one's old session to close.
- **CONNACK 5 with a token that is still valid locally** is the connection cap: keep A, keep the token, back
  off (5 s doubling to 2 min), phase `connection-limit` ("connection limit reached"). With an expired token:
  refresh, then retry.
- **An unexpected drop** (close, error, ping timeout): reconnect with backoff (0.5 s doubling to 30 s; a fresh
  token first if needed), then **gap-fill** over REST per topic before live resumes (`GAP_FILL` in live.ts),
  `session_key` = the live session's (from the messages) or `latest`. Not `date>=lastSeen`: a record can be
  published after later-dated ones and then falls below lastSeen. Pit stops are published when the car leaves
  the pit lane but dated when it entered: in the 25 cached sessions (data/raw) lane times reach 36 minutes (a
  red flag) and 14 sessions have a stop published after a later-dated one. On the real broker a lagging
  driver's telemetry does the same. So the small, low-rate topics are refetched **whole** (pit, position,
  race_control, weather, team_radio, overtakes, and the undated drivers, laps, stints, session_result,
  sessions: at most ~1,500 rows a session), and the three big ones from **`date>=lastSeen - overlap`**: 30 s for
  car_data and location, 60 s for intervals (a chosen margin: the REST cache comes back sorted by date with no
  publish time, so their lag can't be measured from it; 30 s of telemetry is a quarter of the dedupe window).
  A topic with nothing delivered yet is filled from when it started streaming minus the larger of its overlap
  and 30 s. Rows go through the same dedupe (the overlap's and the whole refetch's repeats are dropped by
  content: this relies on a REST row having the MQTT message's content, as `>=` already did), in date order;
  live messages that arrive meanwhile are held back and follow. A topic whose gap-fill fails 3 times is
  reported in `lastError`. The requests go first in the REST budget (below), so a gap-fill of 14 topics never
  bursts and never waits behind a download.
- **Dedupe**: a message is known by OpenF1's `_id` (MQTT) and always by topic + `date` + a hash of its content
  without `_id` / `_key` (what a REST row has). Either key seen = a duplicate. Memory is bounded: the newest
  20,000 keys per topic (about 2 minutes of car_data), so a car_data flood never evicts laps.
- Status (`status.stream`): `phase` (`off`, `waiting`, `connecting`, `connected`, `handover`, `reconnecting`,
  `gap-filling`, `connection-limit`), `topics`, `sessions` open now and `maxSessions`, `handovers`,
  `reconnects`, `delivered`, `duplicates`, `gapFilled`, `lastSeen` per topic, `since` per topic,
  `lastError`, `retryAt`. Pushed on every phase change, and at most once a second for the counters.

## Tabs: one leader

`src/tabs.ts`. Every tab of the app has its own vault frame; they share one storage partition (the vault's
origin under the app's site), hence one BroadcastChannel and one set of Web Locks, and nothing else can join
them: one trust boundary.

- The leader holds `navigator.locks` lock `f1-vault-leader` for its lifetime; the others queue for it. The
  leader alone calls `/token` (the refresh schedule), runs the stream and spends the REST budget. Followers
  forward `get` and the dev knobs to it, send it their subscriptions (the leader streams the union), and get
  data and status over the channel. `status.tab`: `{role, id, leader, frames}`.
- A browser that refuses Web Locks (third-party storage blocked, e.g. Helium by default: every call is a
  `SecurityError`) gets no election: each frame leads alone. It refuses IndexedDB too, so the vault says
  `unavailable`, and the app asks the user to allow third-party cookies for its site.
- A login, unlock or disconnect in any tab reaches every frame. The leader shares the login with the other
  vault frames **in memory** (the decrypted secret and the current token, on every refresh), never to the app
  or to storage. So a new tab is connected at once with no `/token`, and a passkey login is unlocked in every
  open tab with one tap.
- **A frozen or throttled leader** (Chrome freezes background tabs; timers in hidden tabs can be held for a
  minute) must not stall the others. The leader sends a heartbeat every 2 s (its data and status count too); a
  *visible* follower that hears nothing from it for 10 s takes the lock with `navigator.locks.request(…,
  {steal: true})` and takes over as below. The old leader, when it wakes, must not deliver its stale session's
  backlog: it holds a lease that only its own heartbeat renews, and only while that timer runs on time. Once a
  beat is late by more than 3.5 s the lease is void, and until it has re-checked the lock
  (`navigator.locks.query()`: is `f1-vault-leader` held by this frame's clientId?) live.ts buffers raw MQTT
  messages and opens no session. Lost (or the stolen lock's request rejects, or another frame acts as
  leader): it demotes (closes its sessions, drops the buffer, stops refreshing), replays what the new leader
  broadcast while it was frozen (its app missed that), and queues for the lock again. Followers take data and
  status only from the leader they know, so a stale leader's burst reaches nobody, and a leader without a valid
  lease answers no `hello` or forwarded request before the lock check (otherwise a tab that joined during the
  freeze could be synced by the stale leader and follow it; a hidden one would never steal its way back). A follower that was itself
  frozen gives the leader's queued messages a chance before judging. A hidden follower never steals: with every
  tab hidden, a throttled leader keeps leading (its WebSocket events aren't throttled).
- A frozen leader's sessions stay open at the broker (until 1.5 x keepalive of silence), so a steal could make
  three. The heartbeat carries the leader's active session's clientId; the stealer's first session reuses it,
  so the broker kicks the frozen one (OpenF1 kicks the older session on a reused clientId), and the stealer
  hands over to a new token only once the old leader has been heard from as a follower (it has closed its
  sessions) or 1.5 x keepalive (135 s) has passed. The token in hand stays valid meanwhile, and an open session
  outlives its token anyway (the broker checks only at CONNECT). Measured by the S3 run: without this, 3.
- A new or rejoining frame gets a `sync` (the login, the status, the seen keys for dedupe). The leader flushes
  its batch first, and the follower takes that batch before merging the keys: otherwise the batch arrives
  "already seen" and the follower's app never gets it (found by the S3 run).
- When the leader's tab closes, the next frame in line gets the lock and takes over: the login it was given
  (no passkey tap, no immediate `/token`), and the stream: a new session, then a gap-fill from the `lastSeen`
  it tracked from the data it was forwarded, deduped against everything the tabs already got. The old
  leader's topics are kept for 3 s until every follower has re-sent its own. Each frame also holds lock
  `f1-vault-frame:<id>`; the leader lists them every 5 s to forget the subscriptions of closed tabs.

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
| `debug:freeze` | `ms`: 1000–120000 | Freeze **this** frame (not forwarded): timers, sockets, channel and port messages, lock callbacks and fetch answers wait, then run in order (freeze.ts) |
| `debug:sim` | `action`: `drop` or `refuse` | Simulate mode: drop every broker session now, or CONNACK 5 the next CONNECT |

`VAULT_FAKE_BROKER` (dev server only): the origin of a local fake broker (`fakebroker.ts`), e.g.
`http://127.0.0.1:5191`; only `http://127.0.0.1:PORT` or `http://localhost:PORT`. The dev vault's MQTT URL and
REST base then point at it, and the dev frame's CSP `connect-src` adds exactly that origin (`http:` and
`ws:`). Like the other knobs it is baked in by `vaultConstants()` only on the dev server: a build always has
OpenF1's URLs and the production CSP (e2e checks both, and that `dist/` has no trace of it).

The fake broker (`bun vault/fakebroker.ts [--port 5191] [--rate 20]`) speaks MQTT 3.1.1 over WebSocket at
`/mqtt` (any non-empty password, an email as the username like OpenF1; a reused clientId kicks the older session), serves what it published at
`/v1/<topic>` with OpenF1's filters (`session_key`, `date>=` …; no `_id` / `_key`, like OpenF1's REST), and takes
`POST /control/stream?rate=N` (a synthetic stream; 0 stops), `/control/drop` (every connection, abruptly),
`/control/refuse?n=1` (the next CONNECT gets CONNACK 5), `GET /control/stats` (sessions now / max, connects,
refusals). e2e drives the same class in process.

To watch the stream by hand (the fake broker takes any token, but the popup still checks the login with
OpenF1's `/token`, so Connect with your real login):

```sh
bun vault/fakebroker.ts --rate 20
VAULT_FAKE_BROKER=http://127.0.0.1:5191 bun run vault
bun run dev        # open http://127.0.0.1:5173/?vault=debug in two tabs, Connect in one
```

In the panel's "Live stream" section click topics to subscribe (in both tabs: the leader streams the union);
the arrival strip shows messages per second over the last 2 minutes. Refresh now = a handover;
`curl -X POST localhost:5191/control/drop` = a reconnect and gap-fill; `curl -X POST
'localhost:5191/control/refuse?n=1'` then Refresh now = "connection limit reached", the old session keeps
streaming; close the leader tab and the other one takes over. None of these should leave a hole in the strip.
Without `VAULT_FAKE_BROKER` the dev vault uses OpenF1's real broker (empty outside a live session).

By hand: `VAULT_FAKE_EXPIRES_IN=120 bun run vault`, `bun run dev`, open `http://127.0.0.1:5173/?vault=debug`,
Connect. The debug panel shows the refresh phase, next refresh, last result and count, plus buttons: get
`/v1/sessions?session_key=latest` (status, bytes, authenticated or not), Spoil token (then get: still 200,
one more refresh; wait 10 s after a refresh first, or the fresh-token guard gives up), Refresh now, Fake
120 s tokens (from the next token), Real expiry, `/token 503 ×2` (then a refresh: watch it retry after
about 5 s and 10 s and recover) and `/token 401` (then a refresh: the reconnect banner, while gets keep
working until the token expires; Reconnect or Disconnect clears it). e2e fakes the same `/token` answers
with Playwright routes instead, on the real network path.

## Simulate mode (dev only)

A cached session replayed inside the vault as if it were live, so the stream, the handover, the gap-fill and
the tabs can be tried and tested outside race weekends, with no OpenF1 login. Only on the vault dev server:
`vite.config.ts` sets `__VAULT_SIMULATE__` from `VAULT_SIMULATE` there and to `false` in a build, which drops
`src/sim.ts` and `src/freeze.ts` (e2e checks `dist/`).

The substitution is at the transport boundary, so the real code runs from the socket up: `mqtt.ts`, `live.ts`,
the scheduler and the tabs are unchanged.

- **MQTT**: the frame's socket factory returns the simulated broker's `SocketLike` (`src/sim.ts`). It speaks
  MQTT 3.1.1 bytes: CONNECT (token, email and armed refusals checked by the dev server; CONNACK 5 otherwise),
  SUBSCRIBE / UNSUBSCRIBE, PINGREQ, a 1.5 x keepalive timeout, clientId kicks, PUBLISH in WebSocket frames cut
  at random (a packet may span frames), optional delivery jitter.
- **The data**: the vault dev server (`simserver.ts`, at `/__sim/` on the vault's own origin; the dev frame's
  `connect-src` adds `'self'`) builds the session's timeline from `data/raw/<key>/` with `server/simulate.ts`'s
  rules (`simdata.ts`: same topics and fields; laps at start, after each sector and complete, stints per lap, pit
  stops after the pit lane, telemetry from 10 min before the session, plus the session record at the start), with
  dates shifted onto the sim clock and written OpenF1's way. The broker fetches `/__sim/feed` just ahead of the
  clock. Payloads carry `_id` (the event's place in the timeline, so every frame's broker numbers them alike) and
  `_key`. (It serves the timeline rather than the raw files: 1.2 million records per frame would be ~300 MB in
  every tab.)
- **The clock**: the dev server holds the anchor, so every frame, reload and new tab sees the same session at the
  same moment: sim time = anchor + (now - anchor) x speed.
- **REST and /token**: `get` (the real `Rest`, pacer included) goes to `/__sim/v1/`, answered from the same
  timeline as of the current sim time (each document's latest version; 401 for a bad or expired token; 429 over
  6/s or 60/min). `/token` goes to `/__sim/token`: any email and password, a fake JWT (`eyJhbGciOi…`) lasting
  `VAULT_SIMULATE_TOKEN_S`. The fake login is stored in its own IndexedDB database (`f1-vault-sim`).
- **Sessions and faults** live in the dev server, so they are shared by every frame: its session table (a
  frozen tab's session stays until 1.5 x keepalive, like OpenF1's broker; a reused clientId kicks the older
  session, whichever frame holds it) gives the concurrent-session count; drops and refusals are counted there.
- The app shows **SIMULATED** (an amber badge by Home's Settings button) whenever `status.sim` is set, and the login
  popup says so too (any email and password; don't type a real one).

| Variable (vault dev server) | Default | |
| --- | --- | --- |
| `VAULT_SIMULATE` | off | The session key (its raw cache must exist: `bun run ingest <key>`) |
| `VAULT_SIMULATE_SPEED` | 1 | 0.1–60 |
| `VAULT_SIMULATE_START` | -60 | Seconds from lights out where it starts |
| `VAULT_SIMULATE_TOKEN_S` | 3600 | Fake token lifetime, 20–3600 s (a handover every 5/6 of it) |
| `VAULT_SIMULATE_DROP_EVERY` | 0 | Drop every session every N wall minutes |
| `VAULT_SIMULATE_REFUSE_AT` | off | One CONNACK 5 at the first CONNECT N wall minutes in |
| `VAULT_SIMULATE_JITTER` | 0 | Random delivery delay per frame, ms (order kept) |

Controls: `curl -X POST localhost:5174/__sim/control/drop`, `…/refuse?n=1`,
`…/reset?speed=6&start=-1800&token=120` (restarts the session now; open tabs reconnect), `curl
localhost:5174/__sim/stats` (sessions now / max, refusals, drops, tokens, REST, 429s).

To watch one in two tabs:

```sh
VAULT_SIMULATE=11377 VAULT_SIMULATE_SPEED=6 VAULT_SIMULATE_START=-1800 VAULT_SIMULATE_TOKEN_S=120 bun run vault
bun run dev    # open http://127.0.0.1:5173/?vault=debug in two tabs; Connect in one with any email + password
```

In the debug panel's "Live stream": click topics in each tab (the leader streams the union). The amber box
has the sim clock and three buttons (Drop now, CONNACK 5 + refresh, Freeze this tab 20 s); under the arrival
strip there is one **coverage strip per topic, in message (sim) time**: a hole is data this tab never got, and a
gap-fill closes it. Counters: handovers / reconnects, delivered (dupes dropped, gap-filled), leader changes /
steals / lost. Telemetry starts 10 min before the session (at 6x: 2 minutes in, from a -1800 start).

## The S3 check

`bun run vault:e2e --s3` (`s3.ts`): race 11291 (Montreal 2026) from 30 min before lights out to 5 min after the
finish (2.1 h) at 6x (~22 min), 120 s tokens (a handover every 100 s), 30 ms jitter, all 14 topics in every tab.
On the way: two forced drops, one CONNACK 5 on a handover, the leader tab closes and a new tab opens, the new
follower reloads, **an outage timed on a late pit stop** (#87's slow stop on lap 30 entered the pit lane before
three others and left after them: the broker drops just after the first of those is published and the
reconnect is refused once, so #87's stop is published during the outage, dated before the pit lastSeen: a
`date>=lastSeen` gap-fill misses it; the check fails unless every open tab gets it once), the leader's frame
freezes for 25 s (the follower steals). Race 11377 can't show the late pit stop (none of its stops is
published after a later-dated one), hence 11291 (`VAULT_S3_SESSION` picks another; the scenario finds its
late stop in the data). Per tab (a reload is a new tab), for the
time it was open: every message once and nothing extra (laps and stints: each document's final version, since
REST can't return a version that was replaced during an outage; those are counted), no gap between message
dates beyond the source's own + 2 s sim; at most 2 concurrent broker sessions; no REST 429; then the leak check
in both open tabs. It prints a summary table, with the freeze -> steal window's size and the arrival stalls
(the longest time without car_data / location reaching the app, in and outside that window: a drop's stall is
the reconnect plus the gap-fill, whose rows land in place, so the date-gap check is the "no visible gap" one).

Why `debug:freeze` and not CDP: the vault frames of every tab are same-site, so Chrome runs them in one renderer
process. `Debugger.pause` (or a busy loop) in one stops them all, leader and followers alike, and
`Page.setWebLifecycleState` did nothing under Playwright (both measured 2026-09-30). A real tab freeze is per page.

## Login

Chrome partitions the iframe's storage by the app's site, so the popup (top level, the vault's own storage)
and the frame don't share IndexedDB. The popup stores nothing: it hands the login to the frame.

1. The user clicks Connect in the app. `VaultClient.connect()` opens `popup.html#mode=connect&ticket=T`
   synchronously in that click (window name `f1-vault`, so a second click reuses the window), then sends
   `connect {ticket:T}` to its frame. `T` is 128 random bits.
2. The popup posts `popup:hello {ticket}` to every frame of the app window with targetOrigin = the vault origin:
   breadth-first from `opener.top`, at most 64 (not just `opener.frames`: an extension that wraps `window.open`
   can open the popup from a frame of its own, with no frames under it). Only the frame expecting `T` answers
   (to `event.source`); other vault frames stay quiet. The frame binds the ticket to that popup window. A popup
   nobody answers within 4 s says it couldn't reach Pitwall. Tickets expire after 10 minutes and are single-use.
3. The user submits the form (JS only; `form-action 'none'`). `popup:login {username, password, mode}` goes to
   the frame, which calls `POST https://api.openf1.org/token` and answers ok, or `wrong_credentials` (401),
   `rate_limited` (429), `network`, `server`. The popup shows the error or closes itself. Nothing in the
   frame can hang it: `/token` times out after 30 s (`network`) and every IndexedDB request after 10 s
   (`storage`), well inside the popup's 45 s wait.
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
- Dev server with `VAULT_FAKE_BROKER` only: the frame's `connect-src` also has that one local origin.
- Every response: `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`,
  `Cross-Origin-Resource-Policy: cross-origin` (so the frame still loads if the app ever enables COEP),
  `Cache-Control: public, max-age=0, must-revalidate, no-transform` (no-transform: Cloudflare serves the files
  as built instead of injecting its Web Analytics script).
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
