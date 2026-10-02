<h1>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="public/pitwall-logo.svg" />
    <img src="public/pitwall-logo-on-light.svg" alt="Pitwall" height="56" />
  </picture>
</h1>

Replay or follow a live F1 race on a polished timing screen made of blocks you arrange. Replays cover every race, sprint and qualifying session since 2023. Built on [OpenF1](https://openf1.org) data. Runs entirely in your browser.

Each block reads the race its own way: timing, the track map, telemetry, gaps, stint pace, battles, pit stops and more. Anyone can [write a new one](#write-a-block).

**Try it: [pitwall.plusminushalf.com](https://pitwall.plusminushalf.com)**

![A race replay: timing tower, track map, race feed, gaps to the leader, stint pace, battles and pit stops](docs/screenshots/race.png)

## What it does

- **Plays in seconds.** Pick a race and it starts about 5 seconds later. It downloads into your browser while you watch, so next time it opens instantly, even offline.
- **Tracking.** Every car on the track map, about 4 times a second. Timing, gaps, tyres, pit stops, race control, weather and team radio. All on one timeline. Pause, scrub, or play at up to 64×.
- **Race analysis.** Gaps to the leader or the car ahead, lap by lap. Lap times per stint, with each stint's trend in seconds per lap. Battles: cars within a second for laps on end, and who passed whom. Pit stops, and whether the undercut worked. Click a lap, a battle or a stop to watch it.
- **No spoilers.** Watching a race you missed? The timeline shows only what you've watched: safety cars, retirements, penalties and the finish stay hidden until you get there. Pitwall asks when you open a race, or remembers your answer (Settings, on the home page).
- **Qualifying.** Compare up to 4 laps: speed, delta, throttle, brake and gear. See who is fastest in each mini-sector. Replay the laps as ghosts.
- **Blocks.** The screen is a grid of blocks. Move, resize, add or remove them. Your layout is saved.
- **Live.** Follow a race as it happens. Needs an OpenF1 account. Local only for now, not yet on the hosted site.
- **Bring your own credentials.** Connect your own OpenF1 account. Downloads get faster.

| Qualifying | Edit the layout |
| --- | --- |
| ![Qualifying: three drivers' best laps compared on one distance axis](docs/screenshots/qualifying.png) | ![Edit mode: blocks with move and remove controls, and the block picker](docs/screenshots/layout.png) |

## Faster downloads with your own credentials

On OpenF1's free tier a race plays about 5 seconds after you pick it, and the rest of it is downloaded within about a minute. Qualifying takes about 20 seconds to open. Connect an OpenF1 account and downloads get faster, and they also work during live sessions, when the free tier is blocked.

**TL;DR: getting credentials**

1. Sponsor OpenF1 at [openf1.org](https://openf1.org) (€9.90/month).
2. You get an OpenF1 account: an email and a password.
3. In Pitwall, open **Settings** (top right of the home page) and click **Connect** under "OpenF1 account".
4. Sign in in the popup. Stay connected on this device, or lock it behind a passkey.

Pitwall's code never sees your password. A small vault on a separate site (`pitwall-auth.garvit.in`) holds it and talks to OpenF1. Pitwall only gets the data. Details: [vault/README.md](vault/README.md).

The sponsor tier is a personal subscription. Use your own account. Don't share it.

## Run it locally

```sh
bun install
bun run dev      # http://localhost:5173
bun run build    # static site in dist/
```

CLI ingest, live mode, the simulator and how it all works: [docs/development.md](docs/development.md).

## Write a block

Have an idea for another way to read a race? Write it as a block and open a PR.

A block is a React component plus a `defineBlock()` call with its name, size and settings. It reads the race through block-kit's hooks: timing, positions, telemetry, laps, stints, pit stops, the race feed and more. The hooks return only what has happened so far in the replay, so a block can't spoil a race by accident.

1. Make a folder in [`src/blocks/`](src/blocks) with an `index.tsx` that exports `defineBlock({ ... })`. [`weather`](src/blocks/weather/index.tsx) is a whole block in about 40 lines.
2. Pick your hooks. They're all listed in [`src/blockkit/index.ts`](src/blockkit/index.ts).
3. Add the block to [`src/grid/builtins.ts`](src/grid/builtins.ts). It shows up in the block picker: **Edit layout**, then **+ Add block**.
4. Run `bun run lint` and `bun test src/blocks`. A block may import only React, `block-kit` and its own files.

For bigger examples, see the analysis blocks: `gap-chart`, `stint-pace`, `battles` and `pit-strategy`. Each keeps its logic in a separate file, with tests next to it.

## Request a block

Not up for writing one? Missing some data? [Open an issue](https://github.com/plusminushalf/pitwall/issues/new?labels=enhancement). Say what you want to see and why.

## Not a distribution of OpenF1 data

Pitwall ships code, not data. Your browser downloads each race straight from OpenF1. It's processed and stored in your browser only. No server of ours hosts, bundles or relays F1 data. This repo contains none.

OpenF1 data is licensed [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/). Non-commercial use only.

Pitwall is an unofficial fan project. It is not associated with the Formula 1 companies or with OpenF1. F1, FORMULA ONE, FORMULA 1, FIA FORMULA ONE WORLD CHAMPIONSHIP, GRAND PRIX and related marks are trade marks of Formula One Licensing B.V.

## Analytics

The hosted site counts visits with [Cloudflare Web Analytics](https://www.cloudflare.com/web-analytics/): which pages are viewed (Home, a session, live), plus country, browser and referrer. No cookies. Builds you run yourself have none.

## License

Code: [GNU AGPL v3.0](LICENSE) (`AGPL-3.0-only`), © 2026 plusminushalf. Use it, change it, share it. If you distribute a modified version, or run one that others use over a network, publish its source under the same license.

The license covers the code only. Race data falls under OpenF1's license above.
