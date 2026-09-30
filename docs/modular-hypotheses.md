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
| One account can hold **up to 10 MQTT connections at once** (the docs say the same). Connection 11 is refused with CONNACK 135 (v5) / 5 (v3.1.1) "Not authorized", **the same code as an expired token**. Two sessions on one token, or on two tokens, run side by side. Reusing a clientId kicks the older session (DISCONNECT 142, session taken over) | measured 2026-09-30, held for 67 min |
| **An open MQTT session outlives its token.** Held 7 min past `exp` with no disconnect. The broker checks the token only at CONNECT: reconnecting with an expired token is refused (135 / 5) | measured 2026-09-30 |
| `normalize.ts`, `quali.ts` and `server/store.ts` are pure. The Bun-only code is about 40 lines of file and gzip handling, which maps onto the browser's file storage (OPFS) and `CompressionStream` | code read |
| Normalizing one race: about 8 s total, **600–730 MB peak memory** | measured, races 11377 and 11234 |
| One race: 57 OpenF1 requests + 1 MultiViewer request, about 2 min at today's one-at-a-time pace (about 1 min possible on sponsor tier with parallel requests) | measured |
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
- **If the password is changed or revoked,** the stream runs until the current token expires, and a banner asks the user to reconnect.
- **Downloads (goal 4):** without a login, the download worker keeps fetching directly. With one, it sends requests through the vault's `get`, which runs them in parallel within the 6/s limit and returns response bodies as transferable buffers.
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
  shape: 1,                    // width : height, or a function of session info
  width: { min: 1, default: 1, max: 3 },
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
- A slow block drops its own frames; it never stalls playback for everyone else (don't copy Foxglove's `done()` rule).
- *Test:* today's full screen as blocks at 60 fps within 8 ms per frame on a mid-range laptop.

**H3.7: A shared UI kit.** `Stat`, `Bar`, `Sparkline`, `DriverTag`, team colours, fonts and the theme, so community blocks look like they belong in the app. Looks are what sets us apart, so this matters almost as much as the hooks.

### Layout

**H3.8: A snap grid, with each block's shape set by the block.**
- The grid is a fixed number of columns wide with unlimited rows. **10 columns is a placeholder**; the right number comes from trying layouts on real screen sizes.
- Each block declares its **shape** (a width-to-height ratio) and a minimum, default and maximum width in columns. The user only sets the width; the shape sets the height. Contents scale with the block's width.
- A shape can depend on session info but never on live data. The tower's shape comes from the driver count, and the track map's from the circuit outline. The race feed has a fixed shape and scrolls inside it, so the layout never jumps.
- Heights rarely land on whole rows, so the vertical snap step is fine-grained (around a quarter of a column's width).
- Blocks settle upwards, so removing one never leaves a hole.
- Cells grow with the screen, so every block scales with it. The minimum width keeps text readable. Narrow screens (fewer columns, blocks repacked into a stack) come later; we're desktop-first.
- *Wrong if:* blocks with different shapes won't pack without ugly gaps, or text-scales-with-width makes blocks unreadable on common laptop sizes.

**H3.9: The top bar and the timeline are fixed.** Blocks fill everything between them, and only that middle area scrolls. Play and seek are always reachable, and no layout can end up without them. The default layout should fit a normal laptop screen without scrolling.

**H3.10: Normal mode and edit mode**, like the iPhone home screen.
- *Normal mode:* blocks are locked. Clicking a car or row selects a driver as today, and nothing moves by accident.
- *Edit mode*, from an "Edit layout" button in the top bar: the grid becomes visible; drag to move (other blocks slide out of the way); drag a corner to change width a column at a time; ✕ removes a block and ⚙ opens its settings; **+** opens the block picker (installed blocks, plus a link to the marketplace); **Done** saves and **Reset** restores the default.
- The race keeps playing while editing if performance allows. If re-rendering during drags costs too much, playback pauses in edit mode.

**H3.11: One layout per browser, and each block at most once.**
- Stored in the browser. No multiple saved layouts and no share links for now.
- A block can be placed only once, so its id also identifies it in the layout and the picker hides blocks already placed. "Pinned to #16" still works for a single block.
- Format: `{version, columns, blocks: {blockId: {blockVersion, x, y, width, settings}}}`. Heights are derived from shapes.

**H3.12: The default layout is today's screen, split into blocks.** New users see what they see now.

| Block | Shape | Min width |
|---|---|---|
| Timing tower | from the driver count (tall and thin) | 2 |
| Track map | from the circuit outline | 3 |
| Driver header (headshot, name, position, places gained) | wide strip, about 4:1 | 2 |
| Speed and gear | square-ish | 1 |
| Throttle, brake and RPM bars | wide strip | 2 |
| Last-60 s trace | about 2:1 | 2 |
| Lap times (lap, last, best) | wide strip | 2 |
| Sectors with mini-sectors | wide strip | 2 |
| Tyre strip | thin strip | 2 |
| Race feed | fixed and tall, scrolls inside | 2 |
| Weather (moved out of the top bar) | small | 1 |

All the driver blocks follow the selected driver by default, so stacked together they look like today's driver panel.

### Trust and the marketplace

**H3.13: Trust comes in phases.**
- **P1:** our own blocks, compiled into the app. A lint rule enforces the boundary: blocks may only import React and the block kit.
- **P2:** reviewed marketplace blocks, installed with the user's consent, pinned by hash, running in-page.
- **P3:** blocks in sandboxed iframes, with the hooks backed by a message channel instead of memory. Authors' code doesn't change.
- *Why P2 is acceptable for a long time:* with credentials in the vault's separate origin (H2.4, H2.5), a malicious in-page block can only draw fake UI (countered by "passwords only in the vault's popup"), tamper with the race library (re-downloadable), track the user, or waste CPU. F1 data isn't secret. P3 has to land before review is loosened (auto-merge or unreviewed updates), not before submissions open.

**H3.14: The marketplace is a folder in this repo, not a service.**
- Community blocks live in `blocks/` in this repo. Submitting a block means opening a PR. A separate repo can come later if block PRs crowd out app PRs.
- On merge, CI builds each block into a content-hashed ES bundle and regenerates a static `registry.json` (id, name, author, version, block-kit version, hash, shape, sessions, screenshots, whether it uses `useWholeSession`). Both are served from the same static host as the app. No accounts, database or backend.
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

1. **Block kit:** the hooks and `defineBlock`, built on the current store. Nothing visible changes.
2. **Today's screen as blocks:** split the driver panel into its sections and place everything in a fixed default layout on the grid. Check performance with everything on screen.
3. **Grid and edit mode:** dragging, width resizing, the block picker, saving the layout. Tune the column count here.
4. **Shared UI kit:** pull the common pieces out of the rebuilt blocks.
5. **Marketplace:** the `blocks/` folder, CI build and import check, `registry.json`, install and update in the app, the template with a fixture race, developer mode.
6. **Open submissions.**

Steps 1–3 prove the idea: if our own blocks can be built using only the hooks, the API is good enough to offer to others.

## Where the wants collide

- **Credentials and third-party code on the same website.** Solved by putting credentials on a separate site (H2.4). The vault must exist before P2.
- **Browser-only and 700 MB normalize.** Phones may not be able to download races (H2.8).
- **Browser-only and share links.** The recipient waits about 2 minutes on first open (H1.4).
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
9. How many grid columns, and how fine a vertical step? 10 columns is a placeholder; settle it by trying layouts on real screens (H3.8).
10. What do the qualifying hooks look like (ghost clock, distance axis, compared laps)? Deferred until the race hooks have settled (H3.5).
