# F1 Race Replay

Replay any past F1 race (2023+) from [OpenF1](https://openf1.org) data: car positions (~4 Hz), telemetry, timing, pit stops, tyres, race control, weather and team radio on one timeline.

## Data

```sh
bun install
bun run races 2026          # list race/sprint sessions and their keys
bun run ingest 11377        # download + process one race (~2.5 min, free tier)
bun run ingest:season 2026  # every completed race + sprint not ingested yet, one after another
bun run ingest:season 2026 --force   # re-process all of them (from cache where available)
```

- `ingest:season` skips cancelled, not-yet-run and already-ingested sessions, keeps going past failures, prints a summary table at the end (flagging lap-count mismatches from ingest's sanity check), and stops if free disk space drops below 1.5 GB.
- Ingest repairs known OpenF1 glitches and lists them under `repairs:` in its summary: lap-line crossings OpenF1 missed (found in the location trace, laps/pits/stints renumbered), mis-dated lap starts and duplicate pit records, 2026 race-control wording (`VSC DEPLOYED`, `RED FLAG - RACE SUSPENDED`), and location-feed gaps (cars dead-reckoned along the track outline from their speed trace; e.g. 2026 Monaco, whose feed stops 6 minutes in).
- Raw OpenF1 responses are cached gzip-compressed in `data/raw/<key>/*.json.gz` (gitignored; ~15 MB per race instead of ~220 MB of JSON), so re-running ingest is instant and needs no network. Legacy uncompressed `*.json` cache files are still read.
- Processed output goes to `public/sessions/<key>/` (listed in `public/sessions/index.json`, sorted by date): `meta.json` (timing, events, track outline) and `drivers/<number>.json` (columnar location + car telemetry). The format is typed in `src/types.ts`; all times are ms since `meta.t0`.
- OpenF1's free tier is blocked from 30 min before to 30 min after live sessions, so ingest outside race weekends' session times. With sponsor credentials in `.env` (see Live mode) ingest works any time and runs at the faster sponsor rate limit.
- The raw → processed logic lives in `scripts/lib/normalize.ts` (pure, no I/O), shared by ingest and the live relay.

## Qualifying

Qualifying, sprint qualifying and sprint shootout sessions open in a lap comparison view: a timing board (Q1/Q2/Q3 times, per-segment standings with gaps, deleted laps and the knock-out lines) and a compare mode for up to 4 drivers, each on any of their laps (default: their fastest; or every driver's best Q1/Q2/Q3 lap). Speed, delta, throttle, brake and gear share one distance axis with a synced cursor (drag or scroll to zoom); the track map shows who is fastest in each mini-sector and plays the chosen laps as ghosts, starting together at the line.

```sh
bun run races 2026 --quali            # also list qualifying sessions
bun run ingest 11373                  # 2026 Baku qualifying (same raw cache files as a race)
bun run ingest:season 2026 --quali    # races, sprints and qualifying sessions
bun run check:quali                   # sanity-check every ingested qualifying session
```

- `scripts/lib/quali.ts` runs on top of `normalize()`: segments from race control (`SESSION STARTED`/`FINISHED` per qualifying phase), laps attributed to the segment they started in, deleted lap times (race control's `... DELETED` messages, matched by lap time or incident time), the classification (who went out in which segment) and one track-status flag per segment. Pit-out laps get no lap time (OpenF1 times them from the previous pit-lane crossing, garage time included).
- Lap starts are chained through the official lap times within each run (OpenF1's `date_start` jitters by up to ~1 s; the anchor is the median of the laps' starts and their GPS line crossings).
- Every full timed lap gets a trace in `laps/<number>.json` (`LapTrace` in `src/types.ts`): the car samples from line to line with a distance each. Distance is the integrated speed trace, pinned at the line and the two sector boundaries (exact from the official sector times) and scaled to fit in between; stuck car-data samples (every channel repeating for over a second while moving) are dropped and their gap filled from the sector length. GPS positions projected onto the track outline agree with it to ~5 m RMS.
- In the app, the compared drivers are the normal driver selection (`?drivers=` in the URL, Esc clears it) and the ghosts follow the normal play controls (P / hold space).

## Live mode

Follow a race or sprint while it happens, in the same app: a small relay (`server/live.ts`) turns OpenF1's live feed into the replay format and streams it to the browser over a WebSocket (`/live`, proxied by the Vite dev server; protocol in `src/live/protocol.ts`).

```sh
cp .env.example .env        # then fill in OPENF1_USERNAME / OPENF1_PASSWORD
bun run live                # relay on :8787, next to `bun run dev`
curl localhost:8787/live/health
```

- **Credentials.** Live data needs an OpenF1 sponsor account (€9.90/month at [openf1.org](https://openf1.org)): put its username and password in `.env` (gitignored; Bun loads it automatically). The relay exchanges them for a one-hour token, refreshes it before it expires, and never sends credentials or tokens to the browser. Without credentials the relay still runs and reports `state: "error"` with the reason.
- **What it does.** It checks OpenF1 for the current session every minute. From 15 min before a race or sprint until 30 min after its scheduled end (longer if it overruns) it backfills the session over REST, then follows it over MQTT (`wss://mqtt.openf1.org:8084/mqtt`), reconnecting with fresh tokens and re-fetching anything missed. Otherwise it reports `idle` with the next race or sprint.
- **What the app gets.** A snapshot on connect, the whole session meta every ~2 s and new car samples every ~0.5 s. Until the race ends some things are estimates: lights out (until lap 1 starts; `meta.lightsOutEstimated`) and the race distance (`meta.totalLapsEstimated`: 305 km, sprints 100 km, Monaco 260 km over the lap length). Before the first clean lap the track map comes from the circuit's MultiViewer trace.
- **Env.** `OPENF1_USERNAME`, `OPENF1_PASSWORD`, `LIVE_PORT` (8787; Vite's proxy reads it too).

**Simulated live session** (no account needed): replays a cached race through the same pipeline, time-shifted to now, as the MQTT feed would deliver it (laps appear as they start and fill in sector by sector, results after the flag).

```sh
bun run live:sim                                                     # 2026 Baku, from 60 s before lights out
LIVE_SIMULATE=11299 LIVE_SIMULATE_SPEED=10 LIVE_SIMULATE_START=1800 bun server/live.ts   # Monaco, 10x, from 30 min in
```

`LIVE_SIMULATE` is a session key with a raw cache (`bun run ingest <key>` first), `LIVE_SIMULATE_SPEED` a speed factor (1), `LIVE_SIMULATE_START` the start in seconds from lights out (-60). The relay reports `ended` when the data runs out.

**From live to replay.** When a live session ends (or you stop the relay with Ctrl-C during one), the relay writes everything it received to `data/raw/<key>/` in ingest's cache format, so `bun run ingest <key>` turns it into a replay right away, offline. To pick up later corrections from OpenF1 (e.g. final results, stewards' decisions), delete `data/raw/<key>/` and ingest again.
