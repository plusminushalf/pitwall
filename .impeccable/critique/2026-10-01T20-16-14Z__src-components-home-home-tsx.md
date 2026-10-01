---
target: home screen
total_score: 26
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 5
target_identity: "file:/Users/garvitkhatri/dev/pitwall/src/components/home/Home.tsx"
target_fingerprint: "sha256:9264ded527f0842c40b47beff9ddf69db9692e7380924e47426a7837b8b16bc2"
target_path: /Users/garvitkhatri/dev/pitwall/src/components/home/Home.tsx
timestamp: 2026-10-01T20-16-14Z
slug: src-components-home-home-tsx
---
Method: dual-agent (A: design review · B: detector + browser)

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 3 | Download %, ETA, resume points clear; "Your library 5" vs "4 sessions" (Library.tsx:135 vs :77) |
| 2 | Match System / Real World | 3 | "Not persistent / Keep it", "Car telemetry · 14:50–15:0…" are internal language |
| 3 | User Control and Freedom | 3 | Cancel, inline delete confirm, Esc closes Settings |
| 4 | Consistency and Standards | 2 | 4 resume labels, 4 date formats, 3 button systems, focus styles on only some |
| 5 | Error Prevention | 3 | Delete confirm shows size; partial downloads kept |
| 6 | Recognition Rather Than Recall | 3 | Resume points visible; sizes/estimates only in title tooltips (common.tsx:196) |
| 7 | Flexibility and Efficiency | 2 | No shortcuts or search on Home; no Sprint filter |
| 8 | Aesthetic and Minimalist Design | 2 | Same session up to 3x, countdown 2x, ~40 equal-weight outlined chips |
| 9 | Error Recovery | 3 | Downloads resume; season-load error in lead slot has no retry (Home.tsx:531) |
| 10 | Help and Documentation | 2 | Help mostly hover tooltips, unreachable by keyboard |
| **Total** | | **26/40** | **Acceptable** |

## Design Specificity Verdict

LLM: Stock Tailwind dark-dashboard kit (zinc, system-ui at index.css:10, rounded-lg bordered cards, 10px uppercase eyebrow over every block at common.tsx:14, one 60px black title). Pitwall-specific: session chips that fill as they download, race-clock resume points, flag-block logo. Misses timing-sheet density and tabular numerals; violet = qualifying fights F1's purple = fastest.

Deterministic: CLI 0 findings (can't resolve Tailwind contrast). In-browser: 15 findings on 11 elements: low-contrast x8 (3.9–4.1:1 at Home.tsx:407,:426,:430,:245,:252, Library.tsx:26,:32, common.tsx:291), undersized/tiny text x3 (10px labels, 11px status lines), flat-type-hierarchy (16/16/18px). False positives: layout-transition (replay-screen class), cramped-padding (segmented control inset), line-length (footer small print).

## Priority Issues

- [P1] Biggest element can't be acted on: weekend hero leads 72h before every weekend (HERO_WINDOW_MS, catalog.ts:79), 315/800px, no action on hosted site (Home.tsx:326, :433). Fix: lead with continue/latest; next weekend as NextUp strip (Home.tsx:72) with countdown ≤20px; hero only when live is offered; drop SessionLine (Home.tsx:455). Command: /impeccable layout
- [P1] No type system: system-ui only, 9 sizes, 83% of text ≤12px, semibold is the default weight, 900 on Race chips (Calendar.tsx:84), section headings (18px) smaller than card title (20px). Fix: one grotesk with tabular figures, 12/14/16/24/40 scale, 14px body floor, 400/600 + one display weight. Command: /impeccable typeset
- [P1] Same session up to 3x with 4 labels (Continue from / Watch + Paused at / ▶ Race 35:03 / Continue); next weekend in hero and R16. Fix: one resume label; fold Latest race into library top; drop featured session from grid. Command: /impeccable distill
- [P1] Library cards indistinguishable (meeting name only, type in 10px 3.9:1 eyebrow); red means brand, race, next round (Calendar.tsx:357), progress (Library.tsx:53), live, delete. Fix: "Italian GP · Qualifying" titles, neutral progress, red only for live/destructive. Commands: /impeccable clarify, /impeccable quieter
- [P1] Accessibility: 71 text nodes <4.5:1 (zinc-500 3.9–4.1:1, zinc-600 2.5:1); Settings focus not moved (Settings.tsx:63); 2 tab stops per card (Library.tsx:24); role=tab without tabpanel (Calendar.tsx:472); BUTTON lacks focus-visible (common.tsx:10). Command: /impeccable harden

## Persona Red Flags

- Alex: no shortcuts/search on Home; 2024 quali = tab + ~24 rows; no Sprint filter; no weekend download.
- Sam: contrast; ~55 tabs to Settings; Open-when-ready state by ✓/colour only (common.tsx:120); focus reset on return (Home.tsx:487).
- Data-curious fan: calendar starts at 756px; library titles omit session; purple quali.
- Live follower: hero has no action on hosted site; "Live timing isn't available on this site" (Home.tsx:449) is 11px zinc-500.

## Minor Observations

- Spoiler-adjacent: "Paused at 48:52" + progress bar reveals session length.
- 4 date formats (Home.tsx:22, :56, common.tsx:28, Calendar.tsx:43).
- "Paused here" + "6% watched" + "Continue" on one card.
- Internal pipeline copy on downloading card (common.tsx:103).
- "Not persistent · Keep it" doesn't say what's at risk.
- Library trash always visible (4 on first screen) vs hover-only in calendar.
- Upcoming chips look broken.
- Header tagline repeats every visit.
- Data: "Bahrain Grand Prix · Kuala Lumpur · Malaysia" next to "Bahrain GP — cancelled".

## Questions to Consider

- What if the season calendar were the home screen, with Continue as its top row?
- What earns 60px: a countdown you can't act on, or the race you're halfway through?
- If calendar chips show stored/paused state, does the library need its own section?
