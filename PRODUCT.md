# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Two primary users, confirmed 2026-10-01:

- **The data-curious fan.** Has usually seen the session already and comes back to dig in: compare qualifying laps, read telemetry, follow strategy, go back through past sessions since 2023. Arrives at the home screen to find a session and open it.
- **The live follower.** Uses Pitwall as a second screen while a session is running, alongside the broadcast.

Not the primary user: the catch-up viewer who only wants to press play on the race they missed. They are still served (spoiler protection, "continue from"), but the home screen is not built around them alone.

Both use it on a desktop or laptop, in Chromium, often on a second monitor next to the TV or stream. Mobile is not a target.

## Product Purpose

Replay any F1 race, sprint or qualifying session since 2023, built on OpenF1 data, entirely in the browser. A session starts playing about 5 seconds after you pick it and downloads into the browser while you watch, so it opens instantly next time, offline too. Live mode follows a session as it happens.

Success: a fan gets from the home screen to the session they want, and from there to the data they came for, with no wait and no spoilers.

## Positioning

- Runs entirely in the user's browser. No server of ours hosts, bundles or relays F1 data. Each browser fetches from OpenF1 with its own rate limit, which is why a central relay (what killed f1-dash) is not needed.
- Bring your own OpenF1 account for faster downloads and live data. The password never reaches Pitwall's code: a separate vault origin (`pitwall-auth.garvit.in`) holds it.
- The replay screen is a grid of blocks the user arranges: timing tower, track map, telemetry, race feed, tyres, weather and more. No other F1 tool combines user-arranged layouts with a synced replay timeline.
- Spoiler protection is a feature: the timeline shows only what you've watched.

## Operating Context

- Home screen: the next race weekend with its session times, the latest session, and the user's library of sessions stored in this browser (with download progress, watch progress and storage size).
- Session screen: block grid between a top bar and a timeline. Pause, scrub, play at up to 64×. Qualifying compares up to 4 laps (speed, delta, throttle, brake, gear, mini-sectors, ghosts).
- Settings live on the home screen: spoiler preference, OpenF1 account (Connect via the vault popup, optional passkey lock).
- Storage is per browser and can be evicted unless the user makes it persistent.

## Capabilities and Constraints

- Sessions: race, sprint, qualifying, 2023 onward.
- Chromium only for now. Firefox and Safari are deferred.
- Desktop and laptop only. Mobile is not designed for.
- Free OpenF1 tier: about 5 s to start a race, about a minute to finish downloading it, about 20 s to open qualifying. Free users may be blocked during live windows.
- Live mode needs an OpenF1 account and is local-only today (`bun run live`). It is not on the hosted site yet.
- Hosted at `pitwall.plusminushalf.com`, a static site on Cloudflare. Analytics: Cloudflare Web Analytics, no cookies.
- Stack: React 19, Tailwind CSS v4, Vite, zustand.

## Brand Commitments

- Name: Pitwall. Logo assets: `public/pitwall-logo.svg` (on dark), `public/pitwall-logo-on-light.svg`, `public/pitwall-mark.svg`, favicons.
- Voice (from the README and in-app copy): plain, short sentences, concrete numbers, no hype.
- Unofficial fan project. Must not imply association with Formula 1 or OpenF1. F1, FORMULA 1, GRAND PRIX and related marks belong to Formula One Licensing B.V.
- Code is AGPL-3.0-only. OpenF1 data is CC BY-NC-SA 4.0, non-commercial.

## Evidence on Hand

- Screenshots: `docs/screenshots/race.png`, `docs/screenshots/qualifying.png`, `docs/screenshots/layout.png`.
- Measured performance figures in `README.md` and `docs/modular-hypotheses.md`.
- No testimonials, user counts, press or case studies exist. Do not invent them.
- Team, driver and circuit imagery is not licensed for use. Do not add it.

## Product Principles

1. **No spoilers anywhere.** No surface (home, library, cards, notifications) reveals results, winners, positions, incidents or other outcome clues unless the user has turned spoiler protection off.
2. **The data is the product.** Get the user to the session and the data they came for fast. Chrome around it should stay out of the way.
3. **Your browser, your data.** Nothing is hosted or relayed by us. Say plainly what lives in this browser and what it costs in storage.
4. **The user arranges the pit wall.** Layout is the user's, and it is kept.
5. **Say it plainly.** Short, concrete copy. Numbers over adjectives.
