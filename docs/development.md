# Development

How Pitwall works and how to run every part of it. For what Pitwall is, see the [README](../README.md). The credential vault has its own docs: [vault/README.md](../vault/README.md).

## Commands

```sh
bun install
bun run dev                  # http://localhost:5173
bun run build                # static site in dist/ (~0.5 MB): serve it from any static host
bunx serve dist              # or `bun run preview`, or any plain static server
bun run deploy               # build + upload to pitwall.plusminushalf.com (Cloudflare; CI does it on every push to main)
```

## The app

- **Home** (the landing page; **← Races** in a session's header or the browser's Back returns to it) shows the latest race, the session you watched last, your library and every season's calendar: one click downloads a session or watches a downloaded one, which resumes where you left it. A download takes ~2.5 min for a race on OpenF1's free tier (one request every 2.2 s, no login) and stores ~13 MB of raw responses plus ~5 MB processed. One download runs at a time, also across tabs (Web Lock); cancel any time, and a reload or a later Resume only fetches what's missing.
- **Links** (`?session=<key>&t=<s>&drivers=…`) to a race the recipient doesn't have offer "Download this race" and open at `t` when it's ready.
- **Free-tier lockout:** OpenF1 blocks free users from 30 min before to 30 min after live sessions. Downloads then wait and start by themselves.
- **Storage:** everything lives in the browser's origin-private file system (`src/storage/`, behind a `SessionStore` interface): raw OpenF1 responses (`raw/<key>/`, for resuming and re-processing) and the processed replay format (`sessions/<key>/`). The first download asks for persistent storage; Home shows usage and whether it's persistent. Each session records the processing format version (`scripts/lib/formatVersion.ts`); after an app update that changes it, "Update" re-processes from the stored raw data without the network.
- **How:** a worker (`src/ingest/worker.ts`) runs the same pipeline as the CLI (`scripts/lib/ingestCore.ts`, pure `normalize.ts` / `quali.ts`) and writes byte-identical output. It needs a secure context (https or localhost).
- Ingest repairs known OpenF1 glitches: lap-line crossings OpenF1 missed (found in the location trace, laps/pits/stints renumbered), mis-dated lap starts and duplicate pit records, 2026 race-control wording (`VSC DEPLOYED`, `RED FLAG - RACE SUSPENDED`), and location-feed gaps (cars dead-reckoned along the track outline from their speed trace; e.g. 2026 Monaco, whose feed stops 6 minutes in). Early-2023 races have no pit-stop records on OpenF1 (tyre stints are there).

## CLI (optional, for development)

The same ingest runs on the command line, into `data/` (gitignored): the tests read `data/sessions/11377`, and the live simulator replays `data/raw/<key>`. The app itself never reads it.

```sh
bun run races 2026          # list race/sprint sessions and their keys (--quali: qualifying too)
bun run ingest 11377        # download + process one session into data/sessions/11377
bun run ingest:season 2026  # every completed race + sprint not ingested yet (--force, --quali)
bun test                    # data-dependent tests skip without data/sessions/11377
```

- Raw responses are cached gzip-compressed in `data/raw/<key>/*.json.gz` (~15 MB per race instead of ~220 MB of JSON), so re-running ingest needs no network. Output goes to `data/sessions/<key>/` (listed in `data/sessions/index.json`): `meta.json` (timing, events, track outline) and `drivers/<number>.json` (columnar location + car telemetry). The format is typed in `src/types.ts`; all times are ms since `meta.t0`.
- With sponsor credentials in `.env` (see Live mode) the CLI works during live windows and at the faster sponsor rate limit.

## Qualifying

Qualifying, sprint qualifying and sprint shootout sessions open in a lap comparison view: a timing board (Q1/Q2/Q3 times, per-segment standings with gaps, deleted laps and the knock-out lines) and a compare mode for up to 4 drivers, each on any of their laps (default: their fastest; or every driver's best Q1/Q2/Q3 lap). Speed, delta, throttle, brake and gear share one distance axis with a synced cursor (drag or scroll to zoom); the track map shows who is fastest in each mini-sector and plays the chosen laps as ghosts, starting together at the line.

```sh
bun run check:quali                   # CLI: sanity-check every qualifying session in data/sessions
```

- `scripts/lib/quali.ts` runs on top of `normalize()`: segments from race control (`SESSION STARTED`/`FINISHED` per qualifying phase), laps attributed to the segment they started in, deleted lap times (race control's `... DELETED` messages, matched by lap time or incident time), the classification (who went out in which segment) and one track-status flag per segment. Pit-out laps get no lap time (OpenF1 times them from the previous pit-lane crossing, garage time included).
- Lap starts are chained through the official lap times within each run (OpenF1's `date_start` jitters by up to ~1 s; the anchor is the median of the laps' starts and their GPS line crossings).
- Every full timed lap gets a trace in `laps/<number>.json` (`LapTrace` in `src/types.ts`): the car samples from line to line with a distance each. Distance is the integrated speed trace, pinned at the line and the two sector boundaries (exact from the official sector times) and scaled to fit in between; stuck car-data samples (every channel repeating for over a second while moving) are dropped and their gap filled from the sector length. GPS positions projected onto the track outline agree with it to ~5 m RMS.
- In the app, the compared drivers are the normal driver selection (`?drivers=` in the URL, Esc clears it) and the ghosts follow the normal play controls (P / hold space).

## Live mode (dev only for now)

Follow a race or sprint while it happens, in the same app: a small relay (`server/live.ts`) turns OpenF1's live feed into the replay format and streams it to the browser over a WebSocket (`/live`, proxied by the Vite dev server; protocol in `src/live/protocol.ts`). A static build has no relay, so it hides live mode; moving live into the browser is spike S3.

```sh
cp .env.example .env        # then fill in OPENF1_USERNAME / OPENF1_PASSWORD
bun run live                # relay on :8787, next to `bun run dev`
curl 127.0.0.1:8787/live/health
```

- **Credentials.** Live data needs an OpenF1 sponsor account (€9.90/month at [openf1.org](https://openf1.org)): put its username and password in `.env` (gitignored; Bun loads it automatically). The relay exchanges them for a one-hour token, refreshes it before it expires, and never sends credentials or tokens to the browser. Without credentials the relay still runs and reports `state: "error"` with the reason.
- **What it does.** It checks OpenF1 for the current session every minute. From 15 min before a race or sprint until 30 min after its scheduled end (longer if it overruns) it backfills the session over REST, then follows it over MQTT (`wss://mqtt.openf1.org:8084/mqtt`), reconnecting with fresh tokens and re-fetching anything missed. Otherwise it reports `idle` with the next race or sprint.
- **What the app gets.** A snapshot on connect, the whole session meta every ~2 s and new car samples every ~0.5 s. Until the race ends some things are estimates: lights out (until lap 1 starts; `meta.lightsOutEstimated`) and the race distance (`meta.totalLapsEstimated`: 305 km, sprints 100 km, Monaco 260 km over the lap length). Before the first clean lap the track map comes from the circuit's MultiViewer trace.
- **Env.** `OPENF1_USERNAME`, `OPENF1_PASSWORD`, `LIVE_PORT` (8787; Vite's proxy reads it too), `LIVE_HOST` (`127.0.0.1`).
- **For your own use only.** The relay listens on `127.0.0.1` and has no auth: it streams *your* sponsor account's feed to *your* browser. Don't expose it or host it for others; OpenF1's sponsor tier is a personal subscription.

**Simulated live session** (no account needed): replays a cached race through the same pipeline, time-shifted to now, as the MQTT feed would deliver it (laps appear as they start and fill in sector by sector, results after the flag).

```sh
bun run live:sim                                                     # 2026 Baku, from 60 s before lights out
LIVE_SIMULATE=11299 LIVE_SIMULATE_SPEED=10 LIVE_SIMULATE_START=1800 bun server/live.ts   # Monaco, 10x, from 30 min in
```

`LIVE_SIMULATE` is a session key with a raw cache (`bun run ingest <key>` first), `LIVE_SIMULATE_SPEED` a speed factor (1), `LIVE_SIMULATE_START` the start in seconds from lights out (-60). The relay reports `ended` when the data runs out.

**From live to replay.** When a live session ends (or you stop the relay with Ctrl-C during one), the relay writes everything it received to `data/raw/<key>/` in ingest's cache format (for `bun run ingest <key>` and the simulator). The app doesn't read `data/`: download the session from the calendar once OpenF1's free tier opens up again, 30 min after it ends.
