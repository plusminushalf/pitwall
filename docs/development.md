# Development

How Pitwall works and how to run every part of it. For what Pitwall is, see the [README](../README.md). The credential vault has its own docs: [vault/README.md](../vault/README.md).

## Commands

```sh
bun install
bun run dev                  # http://localhost:5173
bun run build                # static site in dist/ (~0.5 MB): serve it at a domain's root, index.html for unknown paths
bunx serve -s dist           # or `bun run preview`, or any static server with a single-page-app fallback
bun run deploy               # build + upload to pitwall.plusminushalf.com (Cloudflare; CI does it on every push to main)
```

## The app

- **Home** (the landing page; **← Races** in a session's header or the browser's Back returns to it) shows the latest race, the session you watched last, your library and every season's calendar: one click watches a session, resuming where you left it; a race plays by itself (once the spoiler question is answered). A session that isn't in the browser yet downloads as it plays (below), and stays. A race stores ~12 MB of raw responses plus ~5 MB processed. One download runs at a time, also across tabs (Web Lock); watching a race puts its download first (one under way makes room, and resumes after it); cancel any time, and a reload or a later Watch only fetches what's missing.
- **Watching while it downloads** (`src/ingest/stream.ts`, `scripts/lib/slices.ts`): a race's telemetry downloads in time slices of every car (`car_data` / `location` with `date>=` / `date<`, 30 minutes each), in the order it's watched: the session files a replay needs (laps, race control, positions, intervals, stints), a 5-minute slice at the playhead, the rest of the session files, then slice after slice from wherever the replay is (a jump ahead gets its own short slice next). The worker normalizes what it has into a provisional replay (`normalize()`'s `partial` option: lap repairs, the outline, pit timing and retirements only from telemetry that's in, nothing driven across a gap) and sends the page each span's telemetry once, as typed arrays, and the meta when it changes (`src/data/session.ts` `streamSession` / `mergeTelemetry`). Playback runs up to what's in and waits there (the widgets dim, "Loading this part of the race…" with how much of that part is in: `JobTracker` follows each slice from request to response, and one on its way counts by the time it should take, `sliceSeconds`; past twice that it says OpenF1 is slow, and when the free tier's minute of requests is used up, when the next one starts); the timeline shows what's downloaded. When the download is done the stored replay takes over where it is: it's what a download would have stored, byte for byte (a race's slices are split back into each driver's records). On the free tier (no login) a race opens ~5 s after Watch and is all in after ~25 s (60 s with the last few requests, past the minute's 24). Free practice streams like a race (its pit stops come before the first slice: its laps are prepared with them). Qualifying downloads in slices too, but opens once it's all in (~20 s: its lap comparison needs every lap).
- **Rate limits:** the free tier's 30 requests a minute (3/s) per IP: a download starts 24 a minute, 0.5 s apart (`scripts/lib/openf1Http.ts` `FREE_PACE`), leaving room for the page's own (the calendar). The slices ahead leave 2 of each minute's for a jump (one short slice at the playhead, fetched at once). Workers pace around this browser's requests of the last minute (kept in localStorage), so a reload mid-download doesn't draw 429s.
- **Addresses** (`src/url.ts`): Home is `/`, a session `/session/<key>?t=<s>&drivers=…&focus=…`, live mode `/live`. Links to a race the recipient doesn't have offer "Watch now", which plays it from `t` as it downloads. Reloading a session whose download is under way carries on watching it. Links from before paths (`/?session=<key>…`) still open, and are upgraded in place.
- **Analytics:** the hosted site loads Cloudflare Web Analytics (`src/analytics.ts`), only in builds with `VITE_CF_BEACON_TOKEN` (`bun run deploy` sets it). It counts page loads and pushes to the address (Home, a session, live, Back / Forward), not the in-place updates that follow the replay's clock.
- **Free-tier lockout:** OpenF1 blocks free users from 30 min before to 30 min after live sessions. Downloads then wait and start by themselves.
- **Storage:** everything lives in the browser's origin-private file system (`src/storage/`, behind a `SessionStore` interface): raw OpenF1 responses (`raw/<key>/`, for resuming and re-processing; telemetry as slices named by their span, `location_<from>_<to>` in Unix seconds, from 5 minutes before the replay window to 5 after; sessions downloaded before slices, one file per driver) and the processed replay format (`sessions/<key>/`). The first download asks for persistent storage; Home shows usage and whether it's persistent. Each session records the processing format version (`scripts/lib/formatVersion.ts`, one per session type, so a change to practice's output doesn't ask for every race to be updated); after an app update that changes it, "Update" re-processes from the stored raw data without the network.
- **How:** a worker (`src/ingest/worker.ts`) runs the same pipeline as the CLI (`scripts/lib/ingestCore.ts`, pure `normalize.ts` / `quali.ts`) and writes byte-identical output. It needs a secure context (https or localhost).
- Ingest repairs known OpenF1 glitches: lap-line crossings OpenF1 missed (found in the location trace, laps/pits/stints renumbered), mis-dated lap starts and duplicate pit records, 2026 race-control wording (`VSC DEPLOYED`, `RED FLAG - RACE SUSPENDED`), and location-feed gaps (cars dead-reckoned along the track outline from their speed trace; e.g. 2026 Monaco, whose feed stops 6 minutes in). Early-2023 races have no pit-stop records on OpenF1 (tyre stints are there).

## CLI (optional, for development)

The same ingest runs on the command line, into `data/` (gitignored): the tests read `data/sessions/11377`, and the live simulator replays `data/raw/<key>`. The app itself never reads it.

```sh
bun run races 2026          # list race/sprint sessions and their keys (--quali: qualifying too, --practice: free practice)
bun run ingest 11377        # download + process one session into data/sessions/11377
bun run ingest:season 2026  # every completed race + sprint not ingested yet (--force, --quali, --practice)
bun test                    # data-dependent tests skip without data/sessions/11377
```

- Raw responses are cached gzip-compressed in `data/raw/<key>/*.json.gz` (~12 MB per race instead of ~150 MB of JSON), so re-running ingest needs no network. Telemetry comes in time slices like in the browser; a cache with per-driver files (from before slices, or the live relay's) is read as it is. Output goes to `data/sessions/<key>/` (listed in `data/sessions/index.json`): `meta.json` (timing, events, track outline) and `drivers/<number>.json` (columnar location + car telemetry). The format is typed in `src/types.ts`; all times are ms since `meta.t0`.
- With sponsor credentials in `.env` (see Live mode) the CLI works during live windows and at the faster sponsor rate limit.

## Qualifying

Qualifying, sprint qualifying and sprint shootout sessions open in a lap comparison view: a timing board (Q1/Q2/Q3 times, per-segment standings with gaps, deleted laps and the knock-out lines) and a compare mode for up to 4 drivers, each on any of their laps (default: their fastest; or every driver's best Q1/Q2/Q3 lap). Speed, delta, throttle, brake and gear share one distance axis with a synced cursor (drag or scroll to zoom); the track map shows who is fastest in each mini-sector and plays the chosen laps as ghosts, starting together at the line.

```sh
bun run check:quali                   # CLI: sanity-check every qualifying session in data/sessions
```

- `scripts/lib/quali.ts` runs on top of `normalize()`: segments from race control (`SESSION STARTED`/`FINISHED` per qualifying phase), laps attributed to the segment they started in, deleted lap times (race control's `... DELETED` messages, matched by lap time or incident time), the classification (who went out in which segment) and one track-status flag per segment. Pit-out laps get no lap time (OpenF1 times them from the previous pit-lane crossing, garage time included).
- Lap starts are chained through the official lap times within each run (OpenF1's `date_start` jitters by up to ~1 s; the anchor is the median of the laps' starts and their GPS line crossings).
- Every full timed lap gets a trace in `laps/<number>.json` (`LapTrace` in `src/types.ts`; `scripts/lib/lapTraces.ts`, shared with free practice): the car samples from line to line with a distance each. Distance is the integrated speed trace, pinned at the line and the two sector boundaries (exact from the official sector times) and scaled to fit in between; stuck car-data samples (every channel repeating for over a second while moving) are dropped and their gap filled from the sector length. GPS positions projected onto the track outline agree with it to ~5 m RMS.
- In the app, the compared drivers are the normal driver selection (`?drivers=` in the URL, Esc clears it) and the ghosts follow the normal play controls (P / hold space).

## Free practice

Free practice (FP1-FP3; not pre-season testing, which OpenF1 also types "Practice") opens in the widget grid, live too, with a layout of its own (`f1-replay:layout:practice`; the gap chart, pit strategy and battles widgets are race-only, long runs is practice-only). The default (`PRACTICE_LAYOUT` in `src/grid/defaultLayout.ts`) is the race screen with the map's column split: the map on top, 360 px tall, and long runs and stint pace side by side under it, filling the column. The top bar counts the session clock down to the scheduled end (it keeps running under a red flag), and the timeline is in minutes from the green light. The timing tower is the timing screen: by best lap, gaps to the fastest (or the car ahead) by best lap also while a car is in the garage, laps run instead of pit stops, deleted lap times struck through. `[` / `]` step through the laps of the driver the driver widgets show.

Practice answers two questions: who's faster where on a single lap (the quali simulations), and who's quicker over a long run (the race simulations).

- **Long runs** (`src/widgets/long-runs/`, the detection in `runs.ts`): in each stint (a run from the garage on one set) the laps between the out-lap and the in-lap, leaving out laps touched by a safety car, VSC or red flag and slow laps (over 107% of the stint's typical lap: the median of its laps within 110% of its fastest). One or two slow laps in a row (traffic) don't end a run if there are 2+ laps at pace either side, so a quali simulation's push / cool-down laps never make one; a push lap tacked on (under 97.5% of the run's median) isn't counted. 5+ laps (a setting) are a long run: its tyre age at the start, laps, average, and trend in s/lap (least squares against tyre age; fuel burning off is in it too, and fuel loads aren't known). Ranked by average within each compound, spoiler-free; a click seeks to the run's first lap and focuses its driver (with drivers selected, adds them), so stint pace shows it.
- **Fastest laps** (`?view=laps` in the URL; the "Replay / Fastest laps" switch in the top bar): the qualifying compare view (`src/components/quali/`, `src/data/compare.ts` for what differs per session type) on a finished practice session's laps. The board is the classification by best lap that counts (gap, tyre, laps run, deleted lap times); the default is the session's two fastest laps; any traced lap can be picked per driver, grouped by run on a set, each with the set's age, and every compared lap shows its tyre. Only once the session is downloaded: live and while it streams, there's only the replay. In both screens space / P play (the replay, or the ghost laps); the arrows, `[` / `]`, `−` / `+` and 1-7 are the replay's or the comparison's own, never both (the replay's clock stays put behind the comparison).
- Lap traces (ingest only, `buildPracticeTraces` in `scripts/lib/practice.ts`): every timed lap within 107% of the driver's best (push laps and runs at race pace, not cool-down laps; out- and in-laps have no time), measured on the laps within 107% of the session's fastest. Lap starts are chained through the lap times for the traces only, so `meta.laps` stays what the stream and the live relay have. `meta.practice` gets `lapLength`, `sectorDistances` and `traced`. 2026 Melbourne FP2: 225 of 379 timed laps, 0.71 MB gzipped (the session is 3.35 MB in all); 2023 Las Vegas FP2 (90 minutes): 347 laps, 1.24 MB.

- `scripts/lib/practice.ts`, inside `normalize()` (so ingest, the stream and the live relay agree): the session runs from the green light (race control's first `SESSION STARTED`; t0 a minute before) to the chequered flag, three minutes after it as for races. `positions` and `intervals` are worked out from the laps (OpenF1 has no intervals outside races): best lap so far, a lap counting from its end until race control deletes it (`Lap.deleted`, the parser shared with qualifying: `scripts/lib/deletedLaps.ts`). `meta.practice.scheduledEnd` is the session clock's end.
- OpenF1 times the laps either side of a garage visit from pit-lane crossings, garage time included (2026 Melbourne FP2: a 15:52 in-lap), so out-laps and the in-laps before them get no lap time, and an in-lap ends at the pit entry. After the flag only the cool-down lap is kept (OpenF1 counts the pit-lane crossing to the garage as one more). The pit lane is drawn from a pass through it, not a garage visit. Results have no finish (cars drive back to the garage).
- `bun run ingest <key>` checks the timing screen at the flag against the official classification (2026 Melbourne FP2, 2025 Silverstone FP1, 2024 Monaco FP1 with its red flag, 2023 Las Vegas FP2 at 90 minutes: identical).

## Live mode

Follow a race, sprint, qualifying or free practice session while it happens, in the same app. OpenF1's live feed is turned into the replay format by one piece of code, `src/live/` (`store.ts`: the session state; `hub.ts`: what is sent and when; `openf1.ts`: finding the session, the REST backfill, when it's over), which runs in one of two places:

- **In the browser, through the vault** (the hosted site, and any build without a relay). A worker (`src/live/worker.ts`, `vaultEngine.ts`) runs it, fed by the credential vault with the user's own OpenF1 account: the vault's live stream (one MQTT connection per browser, shared by its tabs, with its own reconnects and gap-fills) and its REST for the backfill. The page relays between the two (`src/live/vault.ts`) and starts the worker only while the account is connected. Without one, the live screen and Home's live row ask for it (Settings → Connect). During a session OpenF1 refuses browsers' CORS preflight, so the vault's REST with the token then goes through its pass-through (`vault/proxy.ts`, a Cloudflare Worker on the vault's site); the stream needs none. Signed in, the calendar, link lookups and downloads go through the vault too, so they work during sessions.
- **In a small relay** (`server/live.ts`) next to the dev server, with the OpenF1 login in `.env`. It streams the same messages to the browser over a WebSocket (`/relay`, proxied by the Vite dev server; protocol in `src/live/protocol.ts`).

The relay is used when the build has one: the dev server, or a build with `VITE_LIVE_RELAY=1`. `VITE_LIVE_RELAY=0` turns it off in dev, so live goes through the vault as on the hosted site. Otherwise the vault, unless `VITE_VAULT_ORIGIN=off`.

The relay:

```sh
cp .env.example .env        # then fill in OPENF1_USERNAME / OPENF1_PASSWORD
bun run live                # relay on :8787, next to `bun run dev`
curl 127.0.0.1:8787/relay/health
```

- **Credentials.** Live data needs an OpenF1 sponsor account (€9.90/month at [openf1.org](https://openf1.org)): put its username and password in `.env` (gitignored; Bun loads it automatically). The relay exchanges them for a one-hour token, refreshes it before it expires, and never sends credentials or tokens to the browser. Without credentials the relay still runs and reports `state: "error"` with the reason.
- **What it does.** It checks OpenF1 for the current session every minute. From 15 min before a race, sprint, qualifying or free practice until 30 min after its scheduled end (longer if it overruns) it backfills the session over REST, then follows it over MQTT (`wss://mqtt.openf1.org:8084/mqtt`), reconnecting with fresh tokens and re-fetching anything missed. Otherwise it reports `idle` with the next one.
- **What the app gets** (either way). A snapshot on connect, the whole session meta every ~2 s and new car samples every ~0.5 s. Until the race ends some things are estimates: lights out (until lap 1 starts; `meta.lightsOutEstimated`) and the race distance (`meta.totalLapsEstimated`: 305 km, sprints 100 km, Monaco 260 km over the lap length). Before the first clean lap the track map comes from the circuit's MultiViewer trace.
- **Env.** `OPENF1_USERNAME`, `OPENF1_PASSWORD`, `LIVE_PORT` (8787; Vite's proxy reads it too), `LIVE_HOST` (`127.0.0.1`).
- **For your own use only.** The relay listens on `127.0.0.1` and has no auth: it streams *your* sponsor account's feed to *your* browser. Don't expose it or host it for others; OpenF1's sponsor tier is a personal subscription.

**Through the vault, by hand**: `bun run vault`, then `VITE_LIVE_RELAY=0 bun run dev`, open `http://127.0.0.1:5173/live` and Connect. Outside a live session there's nothing to follow; the vault's simulate mode replays a cached session as live instead (`VAULT_SIMULATE=11377 bun run vault`, any email and password in the popup; see vault/README.md). `bun run live:check` does all of it in a browser (about 6 minutes; `vault/livecheck.ts`): no account, Connect, the session filling in, a second tab, the account going and coming back, leaving live.

**Simulated live session through the relay** (no account needed): replays a cached race through the same pipeline, time-shifted to now, as the MQTT feed would deliver it (laps appear as they start and fill in sector by sector, results after the flag).

```sh
bun run live:sim                                                     # 2026 Baku, from 60 s before lights out
LIVE_SIMULATE=11299 LIVE_SIMULATE_SPEED=10 LIVE_SIMULATE_START=1800 bun server/live.ts   # Monaco, 10x, from 30 min in
```

`LIVE_SIMULATE` is a session key with a raw cache (`bun run ingest <key>` first), `LIVE_SIMULATE_SPEED` a speed factor (1), `LIVE_SIMULATE_START` the start in seconds from lights out (practice: the green light; -60). The relay reports `ended` when the data runs out.

**From live to replay.** When a live session ends (or you stop the relay with Ctrl-C during one), the relay writes everything it received to `data/raw/<key>/` in ingest's cache format (for `bun run ingest <key>` and the simulator). The app doesn't read `data/`: download the session from the calendar once OpenF1's free tier opens up again, 30 min after it ends.
