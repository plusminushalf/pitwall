# Modular rewrite: hypotheses

Draft for discussion, 2026-09-29; module marketplace added 2026-09-30; want 3 redesigned around UI blocks on 2026-09-30. Want 1 and most of want 2 are now built for historical replay (commit 49515e4); want 3 is designed but not started. Facts come from research on 2026-09-29; hypotheses are marked **H** and each says what would prove it wrong.

## The three wants

1. **Install and use from the web** with little or no command line.
2. **Bring your own data.** Each user fetches from OpenF1 with their own access. We never host, resell or pass along F1 data.
3. **Everything is a block, and anyone can publish one.** Everything between the top bar and the timeline is a UI block that reads the shared race data and decides what to show and how. Users arrange blocks on a snap grid. Anyone can add a block by opening a PR, and users install the ones they want from an in-app marketplace.

## What we checked (facts)

| Fact | Evidence |
|---|---|
| OpenF1 REST works from any website: CORS header `*`, the pre-check for `Authorization` passes, and 401/404/429 errors carry CORS headers too | curl with `Origin: https://example.com` |
| The token endpoint (`POST /token`, form body) needs no CORS pre-check and returns CORS header `*` | curl with fake credentials |
| The live feed is MQTT over `wss://mqtt.openf1.org:8084/mqtt`, with no check on the requesting website. OpenF1's docs recommend it for browser apps | WebSocket handshake; [auth docs](https://openf1.org/auth.html) |
| The MultiViewer circuit API returns CORS header `*` | curl |
| Team radio MP3s only allow formula1.com websites. So `<audio>` playback should work (not confirmed from our cloud IP), but fetching the files to keep offline is blocked | curl |
| Historical data needs **no login**: 3 requests/s, 30/min. Sponsor tier (€9.90/mo) gives live data and 6/s, 60/min | [openf1.org](https://openf1.org) |
| Free users are reportedly blocked from **every** endpoint during live windows (30 min before a session to 30 min after) | third-party bug report, not verified |
| Licence is CC BY-NC-SA 4.0 and the tiers are labelled "personal use" (non-commercial). There are no terms about caching or users bringing their own key | openf1.org |
| OpenF1: exchanging username and password for a token "MUST be implemented in your backend". Never embed them in client-side apps, and avoid keeping tokens in localStorage | [auth docs](https://openf1.org/auth.html) |
| `POST /token` returns `{"access_token", "token_type": "bearer", "expires_in": "3600"}`. `expires_in` is a **string**. The token is a Firebase ID token (JWT, `exp - iat` = 3600) that carries the account email. There is **no refresh token**: `grant_type` must be `password` (anything else is a 422), and the docs only say "Tokens expire after 1 hour… request a new one" | real response and probes, 2026-09-30; [auth docs](https://openf1.org/auth.html) |
| Getting a new token does not invalidate older ones. About 15 tokens minted within one hour were all valid until their own `exp`. Tokens minted in the same second are identical. `/token` returns an nginx 429 on bursts (8 requests in about 1.6 s) | measured 2026-09-30 |
| REST has **no grace period**: 401 `Invalid ID token: Token expired` from the first second after `exp`. Bad or missing tokens also give 401 (`Could not verify token signature`, `Can't read bearer token`). REST sends no rate-limit headers | measured 2026-09-30 |
| One account can hold **up to 10 MQTT connections at once** (the docs say the same). Connection 11 is refused with CONNACK 135 (v5) / 5 (v3.1.1) "Not authorized", **the same code as an expired token**. Two sessions on one token, or on two tokens, run side by side. Reusing a clientId kicks the older session (DISCONNECT 142, session taken over). **The MQTT username must be the account email**: any other username gets CONNACK 5 even with a valid token, although the docs say "typically any non-empty string" | measured 2026-09-30, held for 67 min; username checked with our client and mqtt.js |
| **An open MQTT session outlives its token.** Held 7 min past `exp` with no disconnect. The broker checks the token only at CONNECT: reconnecting with an expired token is refused (135 / 5) | measured 2026-09-30 |
| `normalize.ts`, `quali.ts` and `server/store.ts` are pure. The Bun-only code is about 40 lines of file and gzip handling, which maps onto the browser's file storage (OPFS) and `CompressionStream` | code read |
| Normalizing one race: about 8 s total, **600–730 MB peak memory** | measured, races 11377 and 11234 |
| One race: 57 OpenF1 requests + 1 MultiViewer request. Into the browser: 144 s on the free tier (the worker's own requests, ~24/min to leave room for the page's), **36 s signed in through the vault** (6 in flight within its 6/s, 60/min budget), no 429 either way, identical output | measured (race 11377, `vault:e2e --downloads`, 2026-09-30) |
| Storage: about 5 MB gzipped processed per race (110–150 MB per season); raw data 10–16 MB gzipped per race. Browser quotas are in the GBs; the risk is the browser deleting data, not size (Safari's 7-day rule unless added to the Home Screen) | du; MDN, WebKit |
| No F1 tool combines user-arranged layouts, a plugin API and a synced replay timeline, let alone a community marketplace | see "Does anyone do this?" |

## Want 1: install and access

**H1.1: A hosted static web app (installable as a PWA) can do the full historical replay with nothing to install and no server of ours.**
- Every source we need works from a browser, and the pipeline is pure.
- Bonus: OpenF1 rate limits are per IP, so every user's browser gets its own quota. A central server shares one quota and gets blocked, which is what killed f1-dash.
- **Scope (2026-09-30): Chromium only for now.** Firefox and Safari are deferred.
- *Wrong if:* ingest won't finish in Chromium (memory), OpenF1 starts rejecting browser requests, or the first-run wait is unacceptable. Tested by spike S1.

**H1.2: One core, several shells.** The UI talks to a `SessionSource` / backend interface. Possible implementations:
1. A browser worker (the default).
2. An optional local companion, a single `bunx` command for live relay, caching radio audio, or power users.
3. A desktop app (Tauri), only if browser limits get in the way.

Build shells 2 and 3 only when a spike shows we need them.

**H1.3: "Install" means installing the PWA, plus a "Deploy your own copy" button.** It's a static site, so it runs on any host. No accounts, and no backend of ours.

**H1.4: Share links are the real UX problem.** A link to lap 34 of a race the recipient hasn't downloaded means about 2 minutes of downloading first.
- **Starting assumption:** show the track and metadata straight away and let drivers stream in with visible progress.
- **Deferred:** fetching the time window around `t` first is possible with OpenF1 date filters, but it clashes with repairs that need the whole session.
- **Built (2026-10-01):** a link (or Watch) plays in ~5 s on the free tier. Telemetry comes in time slices of every car, from `t` on; until it's all in, the replay is provisional and the repairs that need telemetry use only what's in (none drives a car across a gap). Then the stored replay, with every repair, takes over where the viewer is. It's byte-identical to a download's (docs/development.md, "Watching while it downloads").

## Want 2: bring your own data

**H2.1: Most users never need to log in.** Historical replay is free and anonymous. A login only adds live data, double the rate limit, and access during live windows. So first run has no login, and "Add OpenF1 account" is an upgrade.

**H2.2: A local library.**
- The session catalogue comes from `/v1/sessions`. Each session is available, queued, downloading (n%), ready, needs reprocessing, or blocked (live window).
- There is one download queue per browser. Web Locks stop two tabs downloading the same thing.
- Downloads resume per endpoint, the same way the raw cache works today.

**H2.3: Keep the raw responses in browser storage too** (10–16 MB per race). When an app update improves the repairs, the browser re-runs normalize with no network needed. The processed format carries a version number.
- Cost: about double the storage, roughly 0.5 GB per season. That's fine on desktop; phones get a "don't keep raw data" option.

**H2.4: Credentials live in a vault on a separate site.** Revised 2026-09-30 for the goals: users bring their own OpenF1 login, set it up once in the website, watch live without interruption (we refresh tokens ourselves, with nothing asked of the user), and downloads use the login when present because it's faster.
- *Verified 2026-09-30:* `POST /token` returns an access token that lasts one hour, and there is no refresh token. Getting a new token means sending the username and password again, so silent refresh means the password must be available to code without a user gesture.
- Anything that can decrypt the password without asking can also leak it. Encryption can't protect it from code running on the same origin, whether that's a bug, a compromised npm package or a marketplace block. The browser's origin boundary can. So the password and tokens never touch the app's origin.
- **The vault** is a tiny page on a different *site* from the app (e.g. app `f1replay.app`, vault `f1vault.dev`). A different registrable domain gives process isolation as well as storage isolation; a subdomain would only give the second.
  - It is the only code that sees the password or a token. It does login, token refresh, MQTT and authenticated REST fetches, and hands the app data only.
  - It is embedded in the app as a hidden iframe, so it runs for as long as the app is open.
  - Tiny and audited: its own folder, its own deploy, no npm dependencies beyond an MQTT client (or a hand-written MQTT-over-WebSocket subset).
  - Served with a strict CSP (`default-src 'none'`, scripts only from itself, `connect-src` only `api.openf1.org` and `mqtt.openf1.org`) and `frame-ancestors` set to the app's origin only, so no other site can embed it or talk to it.
- **Setup happens in a popup on the vault's own origin**, never in a form inside the app. The user sees the vault's address in the URL bar, and the browser's password manager autofills there. Rule we tell users: *the app never asks for your password inside its own pages*. That defeats a malicious block drawing a fake login form. The vault checks the login once with `POST /token`, then stores the password encrypted.
  - *Found building S3 (2026-09-30):* the **app** opens the popup from its own click handler, because a cross-origin iframe can't open a popup without a click of its own. Chrome also partitions the iframe's storage by the app's site, so the popup (top-level, the vault's own storage) and the iframe (embedded under the app) **don't share IndexedDB**. So the popup does no storing. It sends the login straight to the vault iframe with `opener.frames[i].postMessage(…, VAULT_ORIGIN)`, and the iframe checks it and stores it in its own partition. The app window relays nothing and can't read the message. Passkey prompts also run in the popup, since the hidden iframe never gets a click. Tabs of one app share the iframe's partition, so the cross-tab leader still works.
  - *Found deploying (2026-10-01):* an extension that wraps `window.open` can open the popup from a frame of its own inside the app. The popup's `opener` is then that frame, with no frames under it, and the hello never reached the vault (seen in Arc with extensions; a private window worked). So the popup says hello to every frame under `opener.top` instead.
  - Two subdomains of one domain are the same *site*, so a vault on a sibling subdomain gets origin isolation but not process isolation. Local cross-site testing uses app `127.0.0.1:5173` and vault `localhost:5174`.
- **Storage, user's choice:**
  - *Stay connected on this device* (default): the password is encrypted with a non-extractable AES key, both in the vault's IndexedDB. Fully silent, even after a browser restart. App code can't reach it; someone with the whole browser profile could.
  - *Unlock with passkey*: the password is encrypted with a key derived from a passkey (WebAuthn PRF: Touch ID, Windows Hello, a security key). One tap when the app opens, then silent refresh for as long as the tab is open. A copied profile isn't enough.
  - In both modes the token only ever lives in the vault's memory, never in storage, as OpenF1 recommends.
- **If OpenF1 ever offers a revocable refresh token or scoped API key,** the vault stores that instead of the password, so a leak can be revoked without a password change. Write the vault's storage layer so this can be swapped in.
- *Rejected:* a relay server of ours (we'd hold every user's password, all users would share one IP's rate limit, and we'd be passing along F1 data); the Credential Management API on its own (returning the password without a click means any app code can get it; still useful for autofill in the popup); a token broker the user deploys (the browser then needs a credential to talk to the broker, which moves the problem rather than solving it).
- *Wrong if:* OpenF1 objects to user-held credentials in the browser, Chrome's storage partitioning or third-party iframe rules break the embedded vault, or passkey PRF support is too patchy to offer.

**H2.5: The app talks to the vault through a narrow, capability-only protocol.** Blocks get data, never tokens (the core sits between blocks and the vault). This is what makes third-party blocks possible (H3.13).
- The vault accepts `postMessage` only from the configured app origin and validates every message against a schema.
- It offers: `status`, `connect` (opens the setup popup), `subscribe(topics)`, `get(endpoint, params)` for a fixed list of OpenF1 read endpoints, and `disconnect`. There is no "give me the token".
- It caps request rates, so a bug in the app can't burn the user's quota or get the account flagged.
- Correction to the earlier draft: a separate *worker* is not an isolation boundary. A worker on the same origin shares storage with the page, so any page code could read a saved password. Only a separate origin is.

**H2.10: Live streams survive token expiry without the viewer noticing.**
- **One connection across tabs.** Every tab embeds a vault iframe; they elect a leader with Web Locks. The leader holds the one token, the one MQTT connection and the rate-limit budget, and fans data out to the other tabs over a BroadcastChannel. If the leader tab closes, another takes over.
- **Refresh schedule:** at about 5/6 of the token's `expires_in` (about 50 minutes for a one-hour token), not a hard-coded interval. A failed refresh retries with backoff until the old token really expires. A 401 from REST or MQTT triggers an immediate refresh. On `visibilitychange` and `online` (e.g. waking from sleep) the vault re-checks expiry, since background timers get throttled.
- **Token handover on MQTT:** connect a second session with the new token, subscribe to the same topics, then close the old one, dropping duplicate messages from the overlap by topic plus timestamp or id. After a real disconnect, fill the gap from REST with `date > lastSeen`.
  - *Checked 2026-09-30:* the broker never drops a session when its token expires; it only refuses to *reconnect* with an expired token. So the handover is a safeguard (in case OpenF1 starts enforcing expiry on open sessions), not something the stream depends on. What really matters is always having a valid token ready for a reconnect after a network blip.
  - Every session gets a **fresh clientId**. Reusing one kicks the old session before the new one has subscribed.
  - **CONNACK 135 / 5 is ambiguous:** it means an expired token *or* the 10-connection cap. The vault checks the token's `exp` locally first. If the token is still valid, it treats the refusal as the cap: it keeps the old session, doesn't throw the token away, backs off and shows "connection limit reached". (Today's `server/openf1Source.ts` invalidates the token on any refusal, which would loop at the cap.)
  - Only the leader tab calls `/token`, with jitter, because `/token` rate-limits bursts. REST 401s start the moment the token expires, so the vault schedules against the local `exp` rather than waiting for a 401.
- *Found building S3:* gap-fill can't use `date > lastSeen`, nor `date >= lastSeen`: a record can be published after later-dated ones. Pit stops are published when the car leaves the pit lane but dated when it entered (up to 36 min later under a red flag in the cached races; 14 of 25 sessions have a stop published after a later-dated one), and on the real broker a lagging driver's telemetry does the same. So the small topics (pit, position, race control, weather, radio, overtakes, and the undated laps, drivers, stints, results) are refetched whole, and car_data, location and intervals from lastSeen minus an overlap (30 s, 60 s); dedupe drops the repeats. The old session stays open about 2 s after the new one's SUBACK, so messages still in flight on it aren't lost.
- **A frozen or throttled leader tab** would stall every tab. Chrome throttles timers in hidden tabs, so the vault sends MQTT pings from the socket's message handler too and uses a long keepalive. Followers watch a leader heartbeat and take the lock with `steal: true` if it goes quiet.
- **If the password is changed or revoked,** the stream runs until the current token expires, and a banner asks the user to reconnect.
- **Downloads (goal 4):** without a login, the download worker keeps fetching directly. With one, it sends requests through the vault's `get`, which runs them in parallel within the 6/s limit and returns response bodies as transferable buffers.
  - *Built in S3:* the worker gets its own port to the vault (no main-thread relay) and falls back to fetching directly if the vault isn't signed in or goes away mid-download. The budget is the leader frame's, one per browser: live gap-fills first, callers taking turns, a 429 pauses everything and halves the limits for a minute. Race 11377: 36 s instead of 144 s.
- *Wrong if:* an existing MQTT session is dropped at token expiry faster than a new one can subscribe, or OpenF1 rejects two concurrent sessions per account. Then the handover needs a short REST backfill instead of an overlap. **Checked 2026-09-30: neither happens** (see the facts table). The real limit is 10 connections per account, which the cross-tab leader keeps us well under (one per browser, two during a handover).

**H2.11: The vault's weak points, and the defence for each.**
- *A compromised vault release* could steal passwords as users load it. Defence: tiny audited code, a separate deploy with its own 2FA-protected credentials, releases only from reviewed tagged commits, and a published hash from a reproducible build.
- *Malware or all-sites browser extensions on the device:* no web app can defend against these.
- *Password reuse:* the setup popup pushes for a unique, generated password.
- *Self-hosted forks* need their own vault domain, configured in two places (the app's vault URL and the vault's `frame-ancestors`). The "Deploy your own copy" template sets up both.

**H2.6: Surviving browser cleanup.**
- Call `navigator.storage.persist()`, and nudge Safari users to install the app.
- Show "stored on this device: X MB".
- ~~Offer export and import of your own library as a file, for backup.~~ Dropped (2026-09-30): data just lives in the browser.
- If data is lost anyway, download it again.

**H2.7: Radio streams from F1's CDN in `<audio>`, with no offline radio.** We accept that. We do not run a hosted proxy for it.

**H2.8: Per-driver streaming normalize brings peak memory under ~250 MB, so phones can download races too.**
- *Wrong if:* the repairs need all drivers loaded at once. Then phones can't download races themselves and only view races imported from a desktop.
- Tested by spike S4.

**H2.9: Legal position.**
- We host code only. Each user fetches data for personal use.
- We show OpenF1 attribution and keep the project non-commercial.
- Any money-making plan means talking to OpenF1 first.

## Want 3: everything is a block, and anyone can publish one

Rewritten 2026-09-30 after a design discussion. The earlier draft treated modules as plugins that could publish their own data streams for each other, with nine contribution points (map layers, tower columns, timeline markers and so on) and dockview as the layout engine. That is dropped. A module is now simply a **UI block**: it reads the one shared data stream and decides what to show and how. The user arranges blocks on a grid.

### Does anyone do this?

No F1 tool does. The nearest attempts:
- **MultiViewer (closed):** saved window layouts plus a local API, but all third-party code runs outside the app.
- **Grafana-based f1-live-data:** arrangeable panels and plugins, but no replay clock.
- **Delta:** a fixed grid where panels can collapse, maximise or pop out.
- **f1telemetry.com:** 8 fixed widgets you can drag, saved in a cookie.
- **IAmTomShaw/f1-race-replay:** an extension base class plus a one-way telemetry stream to other programs.
- **None of them have a place where the community publishes blocks for others to install.**

Precedents outside F1:
- **Layout: iPhone home-screen widgets and Grafana dashboards.** An invisible grid that blocks snap into, with blocks settling upwards so there are no holes. iPhone widgets also show more detail at larger sizes.
- **Block API: Foxglove / Lichtblick** (robotics log viewers): panels read a shared clock and shared data through a small context API. Its extensions run in-page with no sandbox.
- **Marketplace: Raycast** (from memory, not re-checked). Every extension's source lives in one public repo; authors open a PR, the team reviews it, and CI builds and publishes it. Obsidian (code in the author's own repo, fetched from their release) and VS Code / Grafana (hosted marketplace with accounts) are the rejected alternatives.

### What a block is

**H3.1: A block is a UI piece over one shared data stream.**
- The core owns the data: the downloaded race or the live feed, the clock, and which drivers are selected.
- A block only reads. It never fetches data, stores data, or publishes data for other blocks. Blocks never import each other.
- Data sources (OpenF1 historical, live over MQTT, simulate) and normalize stay in the core, so data quality has one source of truth.
- What-if scenarios become a core feature that produces an alternative stream; blocks display whichever stream they're given.
- *Test:* rebuild every part of today's screen as blocks using only the public hooks. Any need to reach into internals shows a gap in the API.

**H3.2: Blocks are React components that read data through hooks.** Not a component handed the whole stream as a prop.

```tsx
export default defineBlock({
  id: "speed-gear",
  name: "Speed & gear",
  version: "1.0.0",
  height: 70,                  // CSS px, or { min } to stretch (H3.8)
  width: { min: 7, default: 7, max: 12 },  // percent of the grid, snapped to columns
  sessions: ["race"],
  settings: { driver: "follow-selection" },
  Component: () => {
    const car = useCar(useSelectedDriver());
    return <Stat value={car.speed} unit="km/h" />;
  },
});
```

- *Why hooks:* the core knows exactly what each block reads, so it only re-renders blocks whose data changed, caps update rates and pauses off-screen blocks. The hooks are the contract, not how data gets delivered, so moving blocks into a sandbox later (H3.13) changes nothing for authors. And the API is simply the list of hooks, which is easy to document, version and check in CI.
- *Cost:* authors must use React, and the app's copy of it (bundles mark React as external). A low-level "mount into this element" escape hatch for other frameworks can be added underneath later if anyone needs it.

**H3.3: Version 1 hooks.** Taken from an inventory of what today's UI reads.
- *Time and playback:* `useTime()` (10 Hz); `useFrame(draw)` for canvas blocks, called every animation frame with the exact time and no React re-render; `usePlayback()` for play, pause, seek, jump to lap and speed.
- *Session info, fixed for the session:* `useDrivers()` (names, teams, colours, headshots), `useTrack()` (outline, pit lane, corners, sector marks), `useSessionInfo()` (circuit, session name, total laps, local time).
- *The race at t:* `useRace()` (track status, flags, weather, fastest lap, running order), `useDriver(n)` (position, gap, interval, tyres, laps, status), `useCar(n)` (speed, gear, RPM, throttle, brake, DRS), `useCarHistory(n, windowMs)`, `useLaps(n)`, `useStints(n)`, `useFeed()`.
- *Selection:* `useSelection()` (selected and focused drivers, plus setters), and `useSelectedDriver()`, which applies today's rule (focused, else best-placed selected, else leader) unless the block's settings pin a driver.
- *The block itself:* `useSettings()` (e.g. the tower's gap/interval toggle, which is app-wide state today but belongs to one block) and `useBlockSize()`.

**H3.4: Hooks are spoiler-free by default.** Every hook returns data up to the current time only, as the tyre strip already does by hand, so no community block can spoil a race by accident. Blocks that genuinely need the whole session (the timeline's safety-car bands and event markers) ask for it explicitly through `useWholeSession()`, and the marketplace shows that the block uses it.

**H3.5: Race first.** Each block declares the session types it supports. Version 1 hooks cover race sessions only. Qualifying works differently (a second ghost-lap clock, and hover and zoom measured in metres along the lap, not seconds), so it gets its own small set of hooks once the race set has settled.

**H3.6: Two update rates are part of the contract**, as they are today.
- Race state is computed once at 10 Hz and shared; React hooks update at most that often.
- `useFrame` blocks draw every animation frame, reading the clock directly.
- Off-screen blocks pause.
- A slow block drops its own frames; it never stalls playback for everyone else (don't copy Foxglove's `done()` rule). As built: a block whose draws typically take more than 4 ms (half the screen's budget; the median of its last 5 draws, so one GC pause skips nothing) skips the next frames in proportion, but still draws a few times a second. Each block's timing is its own.
- Edit mode pauses playback (H3.10), so dragging blocks never competes with the race for frames.
- *Test:* today's full screen as blocks at 60 fps within 8 ms per frame on a mid-range laptop.

**H3.7: A shared UI kit.** `Stat`, `Bar`, `Sparkline`, `DriverTag`, team colours, fonts and the theme, so community blocks look like they belong in the app. Looks are what sets us apart, so this matters almost as much as the hooks.

### Layout

**H3.8: A grid of equal columns exactly as tall as the screen; heights come from the blocks unless the user sets one.** Rewritten 2026-09-30 to match what's built; the earlier "shape" idea (a width-to-height ratio, contents zooming with width, unlimited rows, a fine vertical snap step) is dropped. User-set heights added 2026-10-01.
- **Columns:** `COLUMNS` in `src/grid/layout.ts` is the one tunable number. It's 38, chosen so the default layout's side columns match the old fixed 410 px and 360 px at a 1720 px wide window, while the speed column still fits its contents at 1440 px.
- **Widths** are declared in percent (`width: {min, default, max}`), so they mean the same at any column count, and snapped to whole columns.
- **Fixed type sizes.** Block contents never zoom: a wider block gets more room, not bigger text.
- **Heights come from the block by default.** `height` is a fixed number of CSS px (what its contents need; it may depend on session info, the selection or the block's own settings, never on live data, so the layout doesn't move while the race plays), or `{ min }` to stretch. Heights never depend on width.
- **The user can set a block's height** in edit mode (at least `MIN_HEIGHT`, 40 px). The block is then that tall: it no longer stretches or follows its contents. If its contents need more (its own height, or a stretching block's minimum), they keep their height and the block scrolls.
- **Heights snap to rows, as widths snap to columns.** The edge being dragged lands on a line every `ROW` px (20) from the grid's top, or on the grid's bottom, so blocks in different columns line up. Rows are fixed px, not a share of the grid, so a set height doesn't change with the window. The block's own height is a snap point too: there it goes back to having none, so a stretching block fills its column again.
- **Every column ends flush.** Blocks settle upwards in stacking order; then the last stretching block in each column grows to the bottom of the grid (a block spanning several columns grows by the least room any of them has).
- **A column with no stretching block** (e.g. the feed removed) keeps empty space at the bottom; fixed blocks aren't stretched to hide it. Normal mode shows plain background there; edit mode shows it as an empty slot with "+ Add block".
- **Blocks spanning several columns whose stacks differ** rest below the lowest block above them in any of their columns, so the shorter columns get a gap above them, which edit mode also shows as an empty slot.
- **Too tall for the screen:** stretching blocks give up room down to their minimum. If a column still overflows, the edit is refused (H3.10). A saved layout that overflows only because the window got shorter is left alone: the bottom is cut off, and edit mode labels those blocks "Cut off at this window height".
- **Groups:** blocks in the same `group` read as one panel, with no divider between them. Dividers (1 px hairlines) appear only between touching blocks of different groups.
- Narrow screens (fewer columns, blocks repacked into a stack) come later; we're desktop-first.
- *Wrong if:* common layouts can't be made to end flush without gaps, or fixed type sizes leave blocks cramped on common laptop sizes.

**H3.9: The top bar and the timeline are fixed**, and the grid is exactly the height between them. The grid never scrolls: blocks that have more to show (the tower, the feed) scroll inside themselves, and so does a block the user made shorter than its contents (H3.8). Play and seek are always reachable, and no layout can end up without them. The default layout fits a normal laptop screen.

**H3.10: Normal mode and edit mode**, like the iPhone home screen. Built 2026-09-30 (`src/grid/`, core code: blocks know nothing about it).
- *Normal mode:* blocks are locked. Clicking a car or row selects a driver as before, and nothing moves by accident. It's pixel-identical to the screen without edit mode.
- *Edit mode*, from "Edit layout" in the top bar (race sessions; that's the top bar's only change, and in edit mode its slot shows "+ Add block", "Reset" and "Done"):
  - Faint column guides show, and each block gets a thin ring, its name, ⚙ (only if it has settings) and ✕. Block contents don't receive clicks while editing.
  - **Drag to move.** The drop target is a column and a position in the stack of blocks under the dragged one. Other blocks slide out of the way (animated by position only; sizes snap, so canvases don't reallocate every frame). A drop that doesn't fit turns red ("Doesn't fit") and snaps back; Esc cancels.
  - **Drag the grip on a block's edge to change height** (H3.8), in rows; row guides show while dragging. The grip is on the edge the height moves: the bottom, where what's under the block moves with it and a stretching block under it gives up room down to its minimum; or the top, for a block resting on the grid's bottom under a stretching block, which gives way. Past that, or below 40 px, the edge stops and turns red. Double-click the grip to go back to the block's own height.
  - **Drag the grip in the middle of a side to change width**, one column at a time, within the block's min and max. **Neighbours give way**, since every column is full by default: widening takes the column from the touching blocks on that side (each shrinks if above its min, otherwise shifts over and passes the column on); narrowing hands the column to touching neighbours below their max, otherwise leaves a gap. A step that would push something off the grid or overflow is refused, and the grip turns red.
  - **✕** removes a block. **⚙** opens a generic editor over the block's settings: blocks declare how each setting is shown (`fields`: choice, driver, toggle, number); a `driver` setting is "Selected driver" (follow the selection) or "Pinned" to one of the session's drivers; switching to Pinned pins whoever the block shows at that moment. A block pinned to a driver says who in its edit-mode name tag ("Lap times · HAM"). The tower's gap/interval mode is a choice.
  - **+** (or an empty slot) opens the picker: every race block, with how many are on screen already, their `description` and default width, "No room" when a block fits nowhere, and a disabled "Marketplace · Coming soon" entry.
  - **Done** saves; **Reset** restores the default (Done then saves it).
- Groups survive moves: a block keeps its `group`, so moved away from its group-mates it gets its dividers back, and moved back it re-joins the panel. Blocks added from the picker are their own group. Resizing never changes groups.
- **Playback pauses while editing.** We tried keeping it running: dragging then dropped frames (production build, 16×, 20 s runs: 1440×900 at 4× CPU throttle 40 fps and ~390 dropped vs 56 fps and ~70 in normal mode, worst frames 83–100 ms; 1920×1080 unthrottled 54 fps and ~125 dropped vs 60 and 0). Entering edit mode now pauses ("Paused while editing" in the top bar), and Done resumes if the race was playing and the user hasn't taken over playback meanwhile. With the pause, plus a compositor layer for the dragged box and memoised block frames, a drag runs at 60 fps unthrottled at 1440 (57 fps at 1920) and 51 fps at 4× throttle; edit mode with nothing moving costs ~0.3 ms per frame. Normal mode is unchanged within noise (1440 at 16× and 4× throttle: 13.8 ± 0.4 ms of main-thread work per frame before and after). Still costly: each resize step resizes and reallocates block canvases (37 long frames in 20 s at 1920 with 4× throttle).

**H3.11: One layout per browser; a block can be placed more than once.** Changed 2026-10-01 (it was "each block at most once"): pinning driver blocks to favourite drivers needs a panel per driver.
- Stored in `localStorage` (`f1-replay:layout`; synchronous, so the default never flashes before the saved layout loads). No multiple saved layouts and no share links for now.
- Each placement has a key of its own. The first of a block is keyed by the block's id, so layouts from before keep working; another one gets `<block id>:<n>` (the least free n from 2) and names its block in `block`. Each has its own settings, so two lap-times blocks can be pinned to different drivers.
- Format: `{version, columns, blocks: {key: {block?, blockVersion, x, y, width, height?, group?, settings}}}`; `block` defaults to the key. `x` and `width` are in columns; `y` is the stacking order (blocks settle upwards in order of y, then x), not a pixel position. Heights are derived (H3.8) unless `height` (CSS px) is set.
- **Loading** validates it and falls back to the default layout if it's missing, corrupt, of an unknown version, or has no usable block left. Entries of unknown blocks and of blocks without race support are dropped. Settings keep only keys the block has, with values its fields accept.
- **A different column count** (`columns` != `COLUMNS`) is rescaled proportionally by block edges, so neighbours stay adjacent, then clamped to each block's range.
- **The layout pins `blockVersion`.** With only compiled-in blocks there's one version to run: same major version keeps the settings, a different major resets that block's settings, and the pin moves to the running version. Offering updates comes with the marketplace (H3.16).
- Settings changed outside edit mode (the tower's own gap/interval toggle) save at once; everything done in edit mode saves on Done.

**H3.12: The default layout is today's screen, split into blocks** (`src/grid/defaultLayout.ts`). New users see what they saw before blocks (commit 07d720a): the tower on the left, the map filling the middle, the driver panel on the right (header; speed and gear beside the throttle/brake/RPM bars; the last-60 s trace; lap times and sectors; tyres) with the race feed filling the rest. Weather is back in the top bar; its block exists but isn't placed.

| Block | Height | Width (percent: min / default / max) |
|---|---|---|
| Timing tower | stretches (min: header + 5 rows); scrolls inside | 22 / 35 / 45 |
| Track map | stretches (min 200 px) | 20 / 55 / 80 |
| Driver header (headshot, name, position, places gained) | fixed, from the selection and its driver setting | 15 / 21 / 40 |
| Speed and gear | 70 px | 7 / 7 / 12 |
| Throttle, brake and RPM bars | 70 px | 10 / 15 / 30 |
| Last-60 s trace | fixed | 12 / 21 / 60 |
| Lap times (lap, last, best) | fixed | 12 / 21 / 40 |
| Sectors with mini-sectors | fixed | 12 / 21 / 40 |
| Tyre strip | fixed | 12 / 21 / 60 |
| Race feed | stretches (min 150 px); scrolls inside | 15 / 21 / 40 |
| Weather (not placed; in the top bar) | 72 px | 8 / 10 / 25 |

All the driver blocks follow the selected driver by default, so stacked together they look like the old driver panel. Speed-and-gear and the bars share the "telemetry" group with the trace; lap times and sectors share "laps".

### Trust and the marketplace

**H3.13: Trust comes in phases.**
- **P1:** our own blocks, compiled into the app. A lint rule enforces the boundary: blocks may only import React and the block kit.
- **P2:** reviewed marketplace blocks, installed with the user's consent, pinned by hash, running in-page.
- **P3:** blocks in sandboxed iframes, with the hooks backed by a message channel instead of memory. Authors' code doesn't change.
- *Why P2 is acceptable for a long time:* with credentials in the vault's separate origin (H2.4, H2.5), a malicious in-page block can only draw fake UI (countered by "passwords only in the vault's popup"), tamper with the race library (re-downloadable), track the user, or waste CPU. F1 data isn't secret. P3 has to land before review is loosened (auto-merge or unreviewed updates), not before submissions open.

**H3.14: The marketplace is a folder in this repo, not a service.**
- Community blocks live in `blocks/` in this repo. Submitting a block means opening a PR. A separate repo can come later if block PRs crowd out app PRs.
- On merge, CI builds each block into a content-hashed ES bundle and regenerates a static `registry.json` (id, name, author, version, block-kit version, hash, width and height, sessions, screenshots, whether it uses `useWholeSession`). Both are served from the same static host as the app. No accounts, database or backend.
- Building from reviewed source means users run exactly the code that was reviewed, unlike the Obsidian model.
- *Wrong if:* review becomes the bottleneck, or authors want to ship updates without waiting for review.

**H3.15: CI checks mistakes; the maintainer reviews.** A submission must pass automatically:
- a valid block definition, and a block-kit version the app supports;
- imports only from React and the block kit;
- a bundle size budget;
- the H3.6 frame budget, against a fixture session with the block mounted;
- a licence that allows redistribution (the data stays under OpenF1's non-commercial terms).

Static checks catch mistakes, not a determined attacker (e.g. building the name `fetch` at runtime), so human review is the real gate. **The repo maintainer reviews every submission.** A short published checklist tells authors what to expect: only React and the block kit, works at its default and minimum width, no noticeable frame-rate cost, not a near-copy of an existing block. Whether it's polished enough is the reviewer's call on top. Updates go through the same PR path.

**H3.16: Installing is per browser, and needs the user's say.**
- The app reads `registry.json` and shows a marketplace view: search, screenshots, supported sessions, and whether the block sees the whole session.
- Install downloads the bundle, checks its hash against the registry, stores it in browser storage next to the race library, and adds it to the block picker. It works offline from then on.
- Updates are offered, not forced. The layout pins `blockVersion`.
- Our own blocks are listed in the same marketplace and come preinstalled.
- **Kill switch:** a version can be marked revoked in `registry.json`. The app checks on start (when online), disables revoked versions and tells the user why.

**H3.17: Writing a block takes one command and no F1 data setup.**
- A template (`bun create f1-block`) with a dev server, block-kit types and a bundled fixture race, so authors need no OpenF1 account or downloaded race.
- The app's developer mode loads a block straight from `localhost` with live reload.
- The same CI checks run locally (`bun run check`).

**H3.18: Submissions open only after our own blocks have proved the API.** The block kit is the compatibility promise: it's versioned with semver from the first public block, each block declares the version it needs, and the app hides blocks it can't run.

### Build order

1. **Block kit:** the hooks and `defineBlock`, built on the current store. Nothing visible changes. *Done.*
2. **Today's screen as blocks:** split the driver panel into its sections and place everything in a fixed default layout on the grid. Check performance with everything on screen. *Done.*
3. **Grid and edit mode:** dragging, width resizing, the block picker, saving the layout. Tune the column count here. *Done 2026-09-30* (H3.8–H3.12): 38 columns; blocks needed nothing new from the kit beyond `description` and `fields` on `defineBlock`.
4. **Shared UI kit:** pull the common pieces out of the rebuilt blocks. *Started 2026-10-01* (H3.7): `Label`, `Stat`, `Icon`, `DriverTag` and `TyreBadge` in `src/blockkit/ui/`, on the theme in DESIGN.md; every block uses them. Still to come: `Bar`, `Sparkline`, fonts.
5. **Marketplace:** the `blocks/` folder, CI build and import check, `registry.json`, install and update in the app, the template with a fixture race, developer mode.
6. **Open submissions.**

Steps 1–3 prove the idea: if our own blocks can be built using only the hooks, the API is good enough to offer to others.

## Where the wants collide

- **Credentials and third-party code on the same website.** Solved by putting credentials on a separate site (H2.4). The vault must exist before P2.
- **Browser-only and 700 MB normalize.** Phones may not be able to download races (H2.8).
- **Browser-only and share links.** The recipient waited about 2 minutes on first open; with time slices it plays in ~5 s (H1.4).
- **Fast data sharing with sandboxed blocks.** `SharedArrayBuffer` needs COOP/COEP headers, which can block cross-origin media such as team radio. Use transferables until it's truly needed.
- **The vault iframe and cross-origin isolation.** If the app ever turns on COOP/COEP for `SharedArrayBuffer`, the vault must send matching `Cross-Origin-Resource-Policy` / COEP headers or it won't load.
- **The free-tier live blackout.** The library must detect it, pause, and explain why.
- **Open submissions and in-page code.** Until P3, a malicious block that slips past review runs in the same page as everything else. The vault's separate origin keeps credentials out of its reach, but it could still mess with the UI, including drawing a fake login form (hence setup only ever in the vault's popup). Review, hash pinning and the kill switch are the defence until sandboxing lands.
- **A marketplace and a static site with no backend.** No install counts, ratings or reviews without a server. GitHub stars or reactions on the block's folder could stand in.
- **Marketplace and API stability.** Once other people's blocks depend on the block kit, breaking it breaks them. The block kit needs semver from the first public block, and the app hides blocks that need a newer or older block kit than it has.

## Spikes, cheapest first

- **S1: browser ingest.** A worker fetches and normalizes one race into browser storage, and today's replay UI reads it from there. Measure time and peak memory in Chrome, Firefox and Safari on desktop. Checks H1.1, H2.2 and H2.3.
  - **Result (2026-09-29, Chromium only):** every threshold passed.
    - Compute-only (medians): 18.7 s for race 11377 (10.8 s on a quiet machine), 12.7 s for 11234, 9.2 s for qualifying.
    - Peak memory above idle: at most 646 MB.
    - Network ingest: 146 s, no 429s.
    - Output identical to the CLI in all 28 runs.
    - No main-thread long tasks.
    - Replay loads from OPFS at the same speed as HTTP.
    - Firefox and WebKit are **not tested**: system libraries are missing and there's no sudo. Deferred: we target Chromium for now.
    - Surprise: reading raw back (gunzip+parse, 7.3 s) costs more than normalize (3.3 s).
    - Machine: 2-vCPU shared server VM. The spike (`spikes/s1/`, removed since; see commit bf4a0a2) became the app's in-browser downloader: `src/ingest/`, `src/storage/` and `scripts/lib/ingestCore.ts`.
- **S2: blocks on the current store.** Build the block kit (hooks and `defineBlock`), rebuild today's screen as blocks in a fixed default layout on the grid, then add edit mode and try column counts. Benchmark the full screen. This is build steps 1–3 and checks H3.1 to H3.12.
- **S3: the vault.** A second-origin vault (two local ports are enough to start, a separate domain before release) with:
  - popup login and both storage modes, including passkey PRF unlock;
  - silent refresh on a shortened token lifetime (fake a 2-minute `expires_in`) to exercise the schedule, the backoff and the 401 path;
  - MQTT token handover with overlap and dedupe, plus REST gap-fill after a forced disconnect;
  - a cross-tab leader with failover when the leader tab closes;
  - authenticated parallel downloads through `get`;
  - a simulate mode that replays cached raw data inside the vault, so all of this can be tested outside race weekends.
  - Success: a simulated 3-hour session across two tabs with no visible gap, and no password or token readable from the app's origin (checked from DevTools on the app's origin).
  - Checks H2.4, H2.5, H2.10 and H2.11. First confirm the token lifetime, the refresh-token question, and whether two MQTT sessions per account are allowed.
  - **Result (2026-09-30, Chromium only): passed, with two caveats.** Built in `vault/`, commits 99adb92 to fdfb4dc. The token and MQTT facts are in the facts table.
    - `bun run vault:e2e --s3`:
      - Replays a whole cached race through the real MQTT, handover, leader and gap-fill code. That's 2.2 h of race time at 6× speed with 2-minute tokens.
      - Runs across two tabs, plus a replacement tab after the leader closes.
      - Faults: 2 forced drops, a connection-cap refusal, a follower reload, a leader freeze, and a pit stop published late inside an outage.
      - No tab lost or duplicated a message, and no gap was longer than the source's own. Over the run there were 12 handovers and never more than 2 broker sessions.
      - A leader freeze costs about 10 s of wall time before a follower takes over.
    - Leak check, on the app's origin: its storage, a heap snapshot of the app's process and one of the download worker hold no password and no JWT. The vault's own process is the positive control.
    - Against the real API and broker: silent refreshes on fake 2-minute tokens, backoff after `/token` 503s, the reauth banner on a `/token` 401, and refresh-and-retry on a REST 401. It also got through 4 real MQTT handovers.
    - Downloads: 36–40 s signed in through the vault versus 144 s direct, with identical output. If the vault dies mid-download, the direct path finishes it.
    - *Caveat:* the race data covers 2.2 h, not 3 h. A wall-clock 3-hour soak hasn't been run yet.
    - *Caveat:* the leader freeze is simulated inside the frame, because Chrome's lifecycle freeze has no effect under Playwright. Headless tabs are always visible, so "a hidden follower never takes over" is only unit-tested.
    - Surprises:
      - The MQTT username must be the account email.
      - Chrome partitions the iframe's storage away from the popup, so the popup hands the login to the frame.
      - Playwright's default flags turn off storage partitioning and full site isolation, which would have hidden both of those. The e2e forces Chrome's shipped behaviour.
      - Gap-fill by `date` misses late-published pit stops.
    - Still unverified until a live weekend: whether REST rows exactly match MQTT payloads (the dedupe depends on it), and the real broker's publish lag (the 30/60 s overlaps are a chosen margin).
- **S4: streaming normalize** for phone memory. Checks H2.8.
- **S5: marketplace end to end.** Move one built-in block (e.g. the timing tower) into `blocks/`, have CI build it and emit `registry.json`, then uninstall and reinstall it from the in-app marketplace. Then have someone outside the project write and submit a small block using only the template. Checks H3.14 to H3.18. Depends on S2.
- **Not code: email OpenF1** about logging in with your own key in the browser, refresh tokens or scoped API keys, two concurrent MQTT sessions per account, and the non-commercial scope.

## Open questions

1. ~~Are third-party modules a day-one goal or a later phase?~~ Resolved 2026-09-30: they're a goal, but submissions open only after our own blocks have proved the API (H3.18).
2. ~~Marketplace in this repo or a separate repo?~~ Resolved 2026-09-30: this repo, in `blocks/`, for now (H3.14).
3. ~~Who reviews submissions, and what's the bar?~~ Resolved 2026-09-30: the repo maintainer, against a published checklist, with polish as the reviewer's call (H3.15).
4. Are phones first-class or desktop-first?
5. Could this ever be commercial? The OpenF1 licence is non-commercial, and paid marketplace blocks would run into it too.
6. Should we contact OpenF1 before building? Two questions for them: is a user's own login held in their own browser acceptable, and would they offer refresh tokens or scoped API keys (H2.4)?
7. Do we keep the Bun server as an optional companion, or retire it? With the vault handling live data in the browser, its only remaining role would be local caching of team radio.
8. Which domain hosts the vault, and who holds its deploy credentials?
9. ~~How many grid columns, and how fine a vertical step?~~ Resolved 2026-09-30: 38 columns (`COLUMNS`), and no vertical step: heights come from the blocks (H3.8).
10. What do the qualifying hooks look like (ghost clock, distance axis, compared laps)? Deferred until the race hooks have settled (H3.5).
