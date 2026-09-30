# Modular rewrite: hypotheses

Draft for discussion, 2026-09-29; module marketplace added 2026-09-30. Want 1 and most of want 2 are now built for historical replay (commit 49515e4); want 3 is not started. Facts come from research on 2026-09-29; hypotheses are marked **H** and each says what would prove it wrong.

## The three wants

1. **Install and use from the web** with little or no command line.
2. **Bring your own data.** Each user fetches from OpenF1 with their own access. We never host, resell or pass along F1 data.
3. **Everything is a module, and anyone can publish one.** The dashboard is just modules placed on a layout the user chooses. Anyone can add a module by opening a PR, and users install the ones they want from an in-app marketplace and drop them into their layout.

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

**H2.4: Credentials**, from easiest to strictest:
- **(a)** The user types their username and password into a dedicated worker. The token stays in memory. The password is saved only if they tick "remember me", encrypted with a WebCrypto key that can't be exported. That protects it on disk but not from code running in the page.
- **(b)** An optional one-click "your own token broker" (a Cloudflare Worker the user deploys) for people who want OpenF1's recommended setup.
- **(c)** Ask OpenF1 whether logging in with your own key in your own browser is acceptable.

I believe their "must be backend" rule is aimed at developers shipping their own credentials inside an app. Here the user types their own into their own browser, like a desktop app. That is unverified, so we should ask them.

**H2.5: Credentials and all network access stay inside one isolated worker**, never in the main thread or the store. Modules get data, never tokens. This is what makes third-party modules possible later (H3.9).

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

## Want 3: everything is a module, and anyone can publish one

### Does anyone do this?

No. The nearest attempts:
- **MultiViewer (closed):** saved window layouts plus a local API, but all third-party code runs outside the app.
- **Grafana-based f1-live-data:** arrangeable panels and plugins, but no replay clock.
- **Delta:** a fixed grid where panels can collapse, maximise or pop out.
- **f1telemetry.com:** 8 fixed widgets you can drag, saved in a cookie.
- **IAmTomShaw/f1-race-replay:** an extension base class plus a one-way telemetry stream to other programs.
- **None of them let you open the same panel twice.**
- **None of them have a place where the community publishes panels for others to install.**

The closest match anywhere is **Foxglove / Lichtblick**, a robotics log viewer (Lichtblick is the MPL-2.0 fork). It has:
- `registerPanel`, with a panel context offering `watch("currentTime")`, `subscribe(topics)`, `onRender(state, done)`, `saveState` and a declarative settings tree;
- layouts saved as `{configById, layout tree, variables, playbackConfig}`;
- data sources that run in workers.

Its extensions run in-page with no sandbox.

For the marketplace itself, the useful precedents are outside F1 (from memory, not re-checked):
- **Raycast:** every extension's source lives in one public monorepo. Authors open a PR, the Raycast team reviews it, and their CI builds and publishes it to the store.
- **Obsidian:** code lives in the author's own repo. A PR adds one entry to a central `community-plugins.json`; the app downloads the files from the author's GitHub release. Review happens once, at first listing.
- **VS Code / Grafana:** a hosted marketplace with publisher accounts. That needs a backend, which we don't want.

### Hypotheses

**H3.1: A small core, with everything else a module, including today's 7 components.**
- The core covers: the clock (t, play, speed, seek, hover time), the session data API, selection and link groups, the layout manager, the module registry, persistence, and data sources.
- *Test:* rebuild every current component using only the public API. Any need to reach into internals shows a gap in the API.

**H3.2: Panels alone aren't enough; we need contribution points.** These are the places a module can add to the app, VS Code style:
- panels
- track-map layers
- timing-tower columns
- timeline markers and bands
- event-feed items
- derived signals
- commands and shortcuts
- header chips
- settings

Examples that need more than panels:
- A pit-rejoin ghost is a signal, plus a map layer, plus a tower column.
- DRS zones are a map layer.
- What-if scenarios feed several panels at once.

**H3.3: Modules talk through named, typed signals (Foxglove's "topics").**
- The core publishes `clock`, `race.state`, `car.location`, `car.telemetry` and `events.*`.
- Modules publish derived signals such as `strategy.pitRejoin` and `scenario.<id>.raceState`.
- Modules never import each other.
- A what-if scenario is then just a module that publishes an alternative race state, and any panel can show either the real feed or a scenario feed. **The scenarios feature is the acceptance test for this architecture.**

**H3.4: Two update rates are part of the contract**, as they are today:
- Race state is computed once at 10 Hz and shared.
- Canvas modules draw every animation frame, reading the clock directly.
- Tables update at most 10 Hz, and hidden panels pause.
- Don't copy Foxglove's `done()` rule, which lets one slow panel stall playback for everyone. Drop that panel's frames instead.
- *Test:* 12 panels, including 3 track maps and 4 telemetry charts, at 60 fps within 8 ms per frame on a mid-range laptop.

**H3.5: Use dockview as the layout engine.** It's MIT, 89 KB, supports React 19, and has tabs, docking, floating panels and serialisation via `toJSON` with per-panel params.
- Its popout windows are React portals that share one store, so one clock drives every monitor of a multi-screen pit wall.
- Runner-up: FlexLayout.
- Watch out: canvas code that listens on `document` breaks inside popouts.

**H3.6: Multiple instances, each with its own config, plus link groups.**
- Each panel instance has its own config, e.g. driver = "follow focus" or "pinned: #16".
- Colour-coded link groups share a selection, so two telemetry panels can follow two different drivers side by side.

**H3.7: Layouts are data.**
- Format: `{version, panels: {id: {module, moduleVersion, config}}, tree, linkGroups}`.
- Shared as a compressed URL or a file.
- Presets per device class: pit wall, laptop, phone stack, broadcast.
- **A shared layout never installs code.**

**H3.8: Modules have declarative manifests** listing id, version, API version, `contributes` and `requires` (data channels, session types).
- The app can list modules, and hide ones that don't fit (e.g. qualifying-only panels during a race), without running them.
- It only loads data that active modules need.

**H3.9: Trust for third-party modules comes in phases.**
- **P1:** first-party modules compiled into the app. A lint rule enforces the boundary: modules may only import `core/api`.
- **P2:** trusted third-party ES modules loaded from a URL, with the user's consent and a pinned hash ("developer mode"). This is only safe because of H2.5.
- **P3:** modules in sandboxed iframes with a message-only API, the Figma model.

The marketplace (H3.12) starts at P2: reviewed modules, installed with consent, pinned by hash. P3 has to land before we loosen review (e.g. auto-merge or unreviewed updates).

If the API only passes serialisable data and columnar typed arrays from day one (our driver data is already columnar), then P3 is an adapter rather than a rewrite.

**H3.10: Copy Lichtblick's API design, but build our own shell.** Lichtblick would give us layouts, extensions and playback today. But its UI is built for robotics (topics, ROS), it's on React 18, it runs extensions in-page, and the look would be theirs. Looks are what sets us apart.

**H3.11: Data sources are modules too**: OpenF1 historical, OpenF1 live over MQTT, simulate, and file import, all behind `SessionSource`. Normalize and the repairs stay in the core, so data quality has one source of truth.
- Data-source modules touch the network and credentials, so they stay first-party at first. The marketplace carries display and analysis modules (panels, layers, columns, signals).

### The marketplace

**H3.12: The marketplace is a git repo, not a service.** Follow the Raycast model:
- Community modules live in a `modules/` folder of a public repo (ours, or a dedicated `f1-modules` repo). Submitting a module means opening a PR.
- On merge, CI builds each module into a content-hashed ES bundle and regenerates a static `registry.json` (id, name, author, version, API version, hash, manifest, screenshots). Both are served from the same static host as the app.
- No accounts, no database, no backend. It fits want 1.
- Why not the Obsidian model: if code is fetched from the author's own release, what we reviewed is not necessarily what users run. Building from reviewed source closes that gap.
- *Wrong if:* review becomes the bottleneck (too many PRs for the maintainers), or authors want to ship updates without waiting for review.

**H3.13: CI does most of the review.** A submission PR must pass, automatically:
- manifest schema check, and the API version must be one we support;
- imports only from the public module API (`core/api`); no `fetch`, `WebSocket`, `eval`, or DOM access outside the module's own root;
- a bundle size budget;
- the H3.4 frame budget, run against a fixture session with the module mounted;
- a licence that allows redistribution (the code licence; the data stays under OpenF1's non-commercial terms).

A human reviewer then only checks intent and quality. Updates go through the same PR path.

**H3.14: Installing is per browser, and needs the user's say.**
- The app reads `registry.json` and shows a marketplace view: search, filter by contribution point and session type, screenshots, and what the module `requires`.
- Install downloads the bundle, checks its hash against the registry, stores it in browser storage next to the race library, and registers its manifest. It works offline from then on.
- Installed modules appear in the "add panel" menu (and in map layers, tower columns and so on, per H3.2) exactly like built-in ones.
- Updates are offered, not forced. A layout pins `moduleVersion`, so an update never silently changes a saved layout.
- Our own modules (today's 7 components) are listed in the same marketplace and come preinstalled. If the built-ins can be expressed as marketplace entries, the API is good enough.

**H3.15: Shared layouts can ask for modules, but never install them by themselves.** This refines H3.7.
- A layout lists the modules and versions it uses. Opening one with missing modules shows "This layout uses X and Y from the marketplace. Install?"
- Only modules in the registry can be offered this way. A layout can never point at an arbitrary URL; that stays behind developer mode (P2).
- Declining still opens the layout, with placeholders where the missing panels would be.

**H3.16: A kill switch lives in the registry.** A version can be marked revoked in `registry.json`. The app checks the registry on start (when online) and disables revoked versions, telling the user why.

**H3.17: Writing a module should take one command and no F1 data setup.**
- A template (`bun create f1-module`) with a dev server, types for the module API, and a bundled fixture session, so authors don't need an OpenF1 account or a downloaded race.
- The app's developer mode loads a module straight from `localhost` for live reloading.
- The same CI checks run locally (`bun run check`), so authors know before opening a PR.

## Where the wants collide

- **Credentials and third-party code on the same website.** H2.5's isolated worker must exist before P2.
- **Browser-only and 700 MB normalize.** Phones may not be able to download races (H2.8).
- **Browser-only and share links.** The recipient waits about 2 minutes on first open (H1.4).
- **Fast data sharing with iframes.** `SharedArrayBuffer` needs COOP/COEP headers, which can block cross-origin media such as team radio. Use transferables until it's truly needed.
- **The free-tier live blackout.** The library must detect it, pause, and explain why.
- **Open submissions and in-page code.** Until P3, a malicious module that slips past review runs in the same page as everything else. H2.5 keeps credentials out of its reach, but it could still mess with the UI. Review, hash pinning and the kill switch are the defence until sandboxing lands.
- **A marketplace and a static site with no backend.** No install counts, ratings or reviews without a server. GitHub stars or reactions on the module's folder could stand in.
- **Marketplace and API stability.** Once other people's modules depend on `core/api`, breaking it breaks them. The API needs semver from the first public module, and the registry hides modules that need a newer or older API than the app has.

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
- **S2: dogfooding the module API.** Build `core/api` plus dockview, and rebuild TrackMap, TimingTower and Timeline on it. Open two TrackMaps plus a popout. Add one contribution-point feature: a pit-rejoin ghost (signal, map layer and tower column). Benchmark it. Checks H3.1 to H3.6.
- **S3: live in the browser.** Token and MQTT inside a worker, plus a simulate mode that replays cached raw data inside the worker. Checks H2.4 and H2.5.
- **S4: streaming normalize** for phone memory. Checks H2.8.
- **S5: marketplace end to end.** Move one built-in module (e.g. the timing tower) into `modules/`, have CI build it and emit `registry.json`, then uninstall and reinstall it from the in-app marketplace, and open a shared layout that asks for it. Then have someone outside the project write and submit a small module using only the template. Checks H3.12 to H3.17. Depends on S2.
- **Not code: email OpenF1** about logging in with your own key in the browser, and about the non-commercial scope.

## Open questions

1. ~~Are third-party modules a day-one goal or a later phase?~~ They're a goal (the marketplace), so the module API has to be public, versioned and strict from S2 onward. Still open: do we open submissions at launch, or after the built-ins have proved the API?
2. Marketplace in this repo or a separate `f1-modules` repo? Separate keeps app PRs and module PRs apart, but CI and API types then have to be shared across repos.
3. Who reviews submissions, and what's the quality bar for listing (does it just have to be safe, or also useful and polished)?
4. Are phones first-class or desktop-first?
5. Could this ever be commercial? The OpenF1 licence is non-commercial, and paid marketplace modules would run into it too.
6. Should we contact OpenF1 before building?
7. Do we keep the Bun server as an optional companion, or retire it?
