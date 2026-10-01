---
version: 1
slug: "src-components-home-home-tsx"
primary_target: "src/components/home/Home.tsx"
related_targets: ["src/components/home/Calendar.tsx","src/components/home/Library.tsx","src/components/home/common.tsx"]
---

# Home screen

Scope: the home screen (src/components/home/*): header, live row, jump field, Continue, season sheet, footer. Settings panel and vault indicators keep their behaviour. Visitor mode: Operate.

Audience and job: the data-curious fan and the live follower (PRODUCT.md), desktop Chromium. They come to resume a session, start the newest one, or jump to any session since 2023. Typical library: 10–30 stored sessions; they move around the current and last season.

Constraints: strict no spoilers (no results, positions, incidents, or session length: no watched-% bars). Live mode is local-only today (LIVE_RELAY), so the live row appears only when it can act. Season catalogs for search load lazily (2 OpenF1 requests per uncached season). One filled button per page. Every current capability stays: watch while downloading, cancel, retry, update, delete with inline confirm, open when ready, live-window and other-tab banners.

Memorable moment: press /, type "monza 24 q", Enter, and the session plays.

## Direction contract

THESIS: Home is the front page of the replay instrument: a keyboard-first jump field over timing rows. It refuses the dashboard of cards with a hero countdown that the category, and this page before it, defaults to.

OWN-WORLD: The replay screen's world. zinc-950 ground, panels divided by zinc-800 hairlines, no rounded cards. Rows set like timing-tower rows: tabular figures, bold short names, 11px uppercase column headers in zinc-400. Grey controls (zinc-800 fill) and one white button. Red only for live and delete; fuchsia only for fastest. No session-type colours.

STORY: The visitor sees the moment in the header (next session's countdown, or LIVE), resumes the session they were in with the one white button, or types to find any session, and starts it in one key.

FIRST VIEWPORT: 52px header (logo left, moment centre, storage and Settings right). Full-width jump field under it. Continue: up to five rows, the first with the white Resume/Watch button. The season sheet's header and first rows (year toggle, filter, columns SQ · Sprint · Quali · Race) start above the fold at 1280×800.

FORM: Jump bar, position 6 of 7 on the ranked list; surface seed key 292774f1. Signature interaction: the jump field (/ to focus, results as timing rows, ↑↓ to move, Enter plays, Esc clears). Motion: none decorative; row highlight and download fills only.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
