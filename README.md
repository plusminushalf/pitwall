<h1>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="public/pitwall-logo.svg" />
    <img src="public/pitwall-logo-on-light.svg" alt="Pitwall" height="56" />
  </picture>
</h1>

Replay or follow a live F1 race on a polished timing screen made of widgets you arrange. Each widget is a different kind of analysis. Built on [OpenF1](https://openf1.org) data. Runs in your browser.

**Try it: [pitwall.plusminushalf.com](https://pitwall.plusminushalf.com)**. Replays need nothing. Live needs your own [OpenF1 account](#your-own-openf1-account-optional).

![A race replay on the default layout: timing tower, track map, race feed, gaps to the leader, stint pace, battles and pit stops](docs/screenshots/race.png)

## What it does

- **Replays.** Every race, sprint, qualifying and free practice session since 2023. A race starts about 5 seconds after you pick it. It downloads into your browser as you watch, so next time it opens at once.
- **One timeline** for timing, gaps, tyres, pit stops, race control, weather and team radio. Pause, scrub, or play at up to 64×.
- **Dashboards.** Overview, Strategy and Telemetry come built in, and any of them shows any race. Edit one or make your own: move, resize, add or remove widgets, and it's saved.
- **Circuit history.** Two widgets (picker tab "Circuit") show the earlier races at the circuit you're watching: when the safety car came out each year, and every car's tyre strategy, from a few small OpenF1 reads per race kept in your browser. The "Circuit history" dashboard puts them beside the timing; each circuit's page shows them too. Results stay hidden until you ask (or turn spoilers off).
- **Circuits.** Each circuit has a page with every session there since 2023 and its history: lap records, past winners and pole sitters, who wins there (from [F1DB](https://github.com/f1db/f1db), CC BY 4.0). Home leads with the season's circuits (the season sheet, by round, is the other tab); a session's circuit and the search open them too.
- **Race analysis.** Gaps to the leader or the car ahead, lap by lap. Lap times per stint, with each stint's trend in seconds per lap. Battles: cars within a second for laps on end, and who passed whom. Pit stops, and whether each undercut worked. Click a lap, a battle or a stop to watch it.
- **No spoilers.** The timeline shows only what you've watched. Safety cars, retirements, penalties and the finish stay hidden until you get there.
- **Qualifying** has its own screen. Compare up to 4 laps: speed, delta, throttle, brake and gear. See who is fastest in each mini-sector. Replay the laps as ghosts.
- **Free practice** has the timing screen by best lap, with the clock counting down. Deleted lap times are struck through. Long runs ranks every race simulation (5+ laps on a set) by compound, with its average and how much slower it gets per lap. Fastest laps compares up to 4 laps as qualifying does, each with its tyre and its age.
- **Live.** Follow a race, sprint, qualifying or practice session as it happens. Live qualifying uses the race screen for now. It needs an OpenF1 account, connected in Settings.
- **Phones** get the same widgets in one scrolling column, with the timeline pinned at the bottom. Editing dashboards is for desktops.

| Qualifying | Edit the layout |
| --- | --- |
| ![Qualifying: three drivers' best laps compared](docs/screenshots/qualifying.png) | ![Edit mode with the widget picker open](docs/screenshots/layout.png) |

## Your own OpenF1 account (optional)

Replays need no account. On OpenF1's free tier, a race is fully downloaded in about a minute, and qualifying opens in about 20 seconds. An account makes downloads faster. They also keep working during live sessions, when OpenF1 blocks the free tier. And it's what live mode needs: your browser follows the session with your account.

1. Sponsor OpenF1 at [openf1.org](https://openf1.org) (€9.90/month). You get an OpenF1 login: an email and a password.
2. In Pitwall, open **Settings** (top right of the home page). Click **Connect** under "OpenF1 account".
3. Sign in in the popup. Stay connected on this device, or lock it behind a passkey.

Pitwall's code never sees your password. A small vault on a separate site (`pitwall-auth.garvit.in`) holds it and talks to OpenF1. Pitwall only gets the data. Details: [vault/README.md](vault/README.md).

During a live session OpenF1 refuses requests from browsers. So while one is on, the vault sends the requests made with your OpenF1 token through a small pass-through on its own site (`pitwall-auth.garvit.in/openf1/`), which forwards them to OpenF1. Your token passes through it and isn't stored or logged. Your password only ever goes from your browser to OpenF1.

The sponsor tier is a personal subscription. Use your own account. Don't share it.

## Run it locally

```sh
bun install
bun run dev      # http://localhost:5173
bun run build    # static site in dist/
```

In dev, live comes from a small relay next to the dev server, with your OpenF1 login in `.env`. It's for your own use. Don't host it for others.

```sh
cp .env.example .env   # then fill in OPENF1_USERNAME and OPENF1_PASSWORD
bun run live
```

To try live as the hosted site does it, through your account in Settings, run the dev server with `VITE_LIVE_RELAY=0` and the vault next to it (`bun run vault`).

CLI ingest, the live simulator and how it all works: [docs/development.md](docs/development.md).

## Write a widget

A widget is a folder in [`src/widgets/`](src/widgets). Its `index.tsx` default-exports `defineWidget({ ... })`. It reads the race through widget-kit's hooks. The hooks return data only up to the replay's current time, so a widget can't spoil a race by accident. The one opt-out is `useWholeSession()`.

A whole widget:

```tsx
// src/widgets/fastest-lap/index.tsx
import { defineWidget, lapTime, Stat, useFastestLap } from "widget-kit";

function FastestLap() {
  const lap = useFastestLap(); // the fastest lap so far, never one still to come
  return (
    <Stat label="Fastest lap" className="h-full justify-center px-3">
      <span className="text-sm tabular-nums">{lap ? `${lapTime(lap.duration)} by #${lap.driver}` : "None yet"}</span>
    </Stat>
  );
}

export default defineWidget({
  id: "fastest-lap", // kebab-case, the same as the folder
  name: "Fastest lap",
  description: "The fastest lap so far, and who set it.", // shown in the widget picker
  version: "1.0.0",
  height: 48, // px
  width: { min: 8, default: 10, max: 25 }, // percent of the grid's width
  sessions: ["race"], // races and sprints
  settings: {},
  Component: FastestLap,
});
```

1. Make a folder in `src/widgets/` with an `index.tsx` like the one above.
2. Pick your hooks. They're all listed in [`src/widgetkit/index.ts`](src/widgetkit/index.ts). Import them from `"widget-kit"`.
3. Register the widget in [`src/grid/builtins.ts`](src/grid/builtins.ts): import it and add it to the `ALL` list. It then shows up under **Edit** → **+ Add widget**.
4. Run `bun run lint` and `bun test src/widgets`. The lint checks that a widget imports only React, `widget-kit` and files in its own folder.
5. Open a PR.

[`weather`](src/widgets/weather/index.tsx) is the smallest real widget. `gap-chart`, `stint-pace`, `battles` and `pit-strategy` are bigger. Each keeps its logic in a separate file, with tests next to it.

To match the app's look, use widget-kit's UI pieces: `Label`, `Stat`, `Icon`, `DriverTag` and `TyreBadge`. See [DESIGN.md](DESIGN.md).

### What a widget can read

- **Timing:** `useRunningOrder`, `usePositions`, `useDriver` (position, gaps, tyres, lap, status), `useFastestLap`, `useBestSectors`.
- **Laps and strategy:** `useLaps` (sector times, mini-sectors, speed traps), `useStints`, `usePitStops` (pit lane and stationary time). `useAllLaps`, `useAllStints` and `useAllPitStops` cover the whole field.
- **Telemetry:** `useCar` (speed, gear, RPM, throttle, brake, DRS), `useCarHistory` (recent samples), `useFrame` (car positions every animation frame, for canvas drawing), `useLapTrace` (one completed lap as a distance-aligned trace, with `useLapGeometry` for the lap length, sector boundaries and corners; `deltaSeries`, `miniSectors` and friends read them).
- **The race:** `useTrackStatus`, `useNeutralPeriods` (SC, VSC and red flag periods), `useSectorFlags`, `useWeather`, `useFeed` (race control, overtakes, pit stops, team radio).
- **Session:** `useDrivers` (names, teams, colours), `useTrack` (outline, pit lane, corners, sectors), `useSessionInfo`.
- **Playback and the widget:** `useTime`, `usePlayback`, `useSelection`, `useSettings`, `useWidgetSize`.

## Request a widget

Not up for writing one? Missing some data? [Open an issue](https://github.com/plusminushalf/pitwall/issues/new?labels=enhancement). Say what you want to see and why.

## Not a distribution of OpenF1 data

Pitwall ships code, not data. Your browser downloads each race from OpenF1. It's processed and stored in your browser only. No server of ours hosts, bundles or stores F1 data. This repo contains none. One thing passes through: during live sessions, requests made with your OpenF1 account go through the vault's pass-through (see above), which hands each answer to your browser and keeps nothing.

OpenF1 data is licensed [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/). Non-commercial use only.

Pitwall is an unofficial fan project. It is not associated with the Formula 1 companies or with OpenF1. F1, FORMULA ONE, FORMULA 1, FIA FORMULA ONE WORLD CHAMPIONSHIP, GRAND PRIX and related marks are trade marks of Formula One Licensing B.V.

## Analytics

The hosted site counts visits with [Cloudflare Web Analytics](https://www.cloudflare.com/web-analytics/): which pages are viewed (Home or a session), plus country, browser and referrer. On Called It it also counts a call being locked (which driver), shared and copied, as page views of paths of their own. It also sends [PostHog](https://posthog.com) (EU cloud) the same page views, clicks, errors, and what's used: widgets added, sessions opened and downloaded, screenshots, calls. PostHog keeps a random visitor ID in the browser's local storage so a return visit counts as the same visitor. No cookies, no accounts, no names or emails. Builds you run yourself have none.

## License

Code: [GNU AGPL v3.0](LICENSE) (`AGPL-3.0-only`), © 2026 plusminushalf. Use it, change it, share it. If you distribute a modified version, or run one that others use over a network, publish its source under the same license.

The license covers the code only. Race data falls under OpenF1's license above.
