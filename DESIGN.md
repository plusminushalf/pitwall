---
name: Pitwall
description: Replay any F1 session since 2023 in the browser; a near-black timing instrument of hairline-divided panels.
colors:
  pit-black: "#09090b"
  raised-panel: "#18181b"
  hairline: "#27272a"
  control-hover: "#3f3f46"
  hairline-strong: "#71717b"
  secondary-text: "#9f9fa9"
  tertiary-ink: "#d4d4d8"
  body-ink: "#e4e4e7"
  primary-ink: "#f4f4f5"
  headline-white: "#fafafa"
  pure-white: "#ffffff"
  live-red: "#e7000b"
  danger-hover-red: "#fb2c36"
  signal-red: "#ff6467"
  fastest-fuchsia: "#ed6bff"
  personal-best-emerald: "#00d492"
  caution-amber: "#ffd230"
  caution-wash-text: "#fee685"
typography:
  headline:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, \"Segoe UI\", sans-serif"
    fontSize: "1.5rem"
    fontWeight: 700
    lineHeight: "2rem"
    letterSpacing: "-0.025em"
  stat:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, \"Segoe UI\", sans-serif"
    fontSize: "1.25rem"
    fontWeight: 900
    lineHeight: "1.75rem"
    letterSpacing: "-0.025em"
    fontFeature: "\"tnum\""
  input:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, \"Segoe UI\", sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: "1.5rem"
  title:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, \"Segoe UI\", sans-serif"
    fontSize: "0.875rem"
    fontWeight: 600
    lineHeight: "1.25rem"
  body:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, \"Segoe UI\", sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: "1.25rem"
    fontFeature: "\"tnum\""
  body-small:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, \"Segoe UI\", sans-serif"
    fontSize: "0.75rem"
    fontWeight: 400
    lineHeight: "1rem"
    fontFeature: "\"tnum\""
  label:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, \"Segoe UI\", sans-serif"
    fontSize: "11px"
    fontWeight: 600
    lineHeight: "1rem"
    letterSpacing: "0.05em"
rounded:
  sm: "2px"
  base: "4px"
  md: "6px"
  lg: "8px"
  full: "9999px"
spacing:
  hair: "2px"
  xs: "4px"
  sm: "8px"
  row-x: "12px"
  md: "16px"
  gutter: "24px"
  section: "40px"
  section-lg: "48px"
  header-height: "52px"
  row-min-height: "44px"
  page-max: "72rem"
components:
  button-primary:
    backgroundColor: "{colors.primary-ink}"
    textColor: "{colors.pit-black}"
    typography: "{typography.body-small}"
    rounded: "{rounded.md}"
    padding: "4px 10px"
  button-primary-hover:
    backgroundColor: "{colors.pure-white}"
    textColor: "{colors.pit-black}"
  button-secondary:
    backgroundColor: "{colors.hairline}"
    textColor: "{colors.primary-ink}"
    typography: "{typography.body-small}"
    rounded: "{rounded.md}"
    padding: "4px 10px"
  button-secondary-hover:
    backgroundColor: "{colors.control-hover}"
    textColor: "{colors.pure-white}"
  button-danger:
    backgroundColor: "{colors.live-red}"
    textColor: "{colors.pure-white}"
    typography: "{typography.body-small}"
    rounded: "{rounded.md}"
    padding: "4px 10px"
  button-danger-hover:
    backgroundColor: "{colors.danger-hover-red}"
    textColor: "{colors.pure-white}"
  button-icon:
    textColor: "{colors.secondary-text}"
    rounded: "{rounded.md}"
    size: "28px"
  jump-field:
    backgroundColor: "{colors.raised-panel}"
    textColor: "{colors.headline-white}"
    typography: "{typography.input}"
    rounded: "{rounded.md}"
    height: "48px"
    padding: "0 96px 0 44px"
  timing-row:
    backgroundColor: "{colors.pit-black}"
    textColor: "{colors.body-ink}"
    typography: "{typography.body}"
    padding: "6px 12px"
    height: "44px"
  timing-row-hover:
    backgroundColor: "{colors.raised-panel}"
  column-header:
    textColor: "{colors.secondary-text}"
    typography: "{typography.label}"
    padding: "0 12px 8px"
  badge-live:
    backgroundColor: "{colors.live-red}"
    textColor: "{colors.pure-white}"
    typography: "{typography.label}"
    rounded: "{rounded.base}"
    padding: "1px 6px"
  badge-neutral:
    backgroundColor: "{colors.hairline}"
    textColor: "{colors.body-ink}"
    typography: "{typography.label}"
    rounded: "{rounded.base}"
    padding: "1px 6px"
  segmented:
    backgroundColor: "{colors.raised-panel}"
    rounded: "{rounded.md}"
    padding: "2px"
  segmented-option:
    textColor: "{colors.tertiary-ink}"
    typography: "{typography.body-small}"
    rounded: "{rounded.base}"
    padding: "4px 10px"
  segmented-option-selected:
    backgroundColor: "{colors.control-hover}"
    textColor: "{colors.headline-white}"
  season-cell-stored:
    backgroundColor: "{colors.hairline}"
    textColor: "{colors.headline-white}"
    typography: "{typography.body-small}"
    rounded: "{rounded.md}"
    height: "32px"
    padding: "0 8px"
  season-cell-available:
    textColor: "{colors.tertiary-ink}"
    typography: "{typography.body-small}"
    rounded: "{rounded.md}"
    height: "32px"
    padding: "0 8px"
  popover:
    backgroundColor: "{colors.raised-panel}"
    textColor: "{colors.body-ink}"
    rounded: "{rounded.lg}"
    padding: "16px"
    width: "320px"
  kbd:
    backgroundColor: "{colors.hairline}"
    textColor: "{colors.body-ink}"
    rounded: "{rounded.base}"
    padding: "2px 6px"
---

# Design System: Pitwall

## Overview

**Creative North Star: "The Timing Screen"**

Pitwall looks like the timing screens on a real pit wall: a near-black page, panels split by thin hairlines, and dense rows of tabular figures. Nothing is decorative. The replay screen set this look first, a grid of widgets between a 52px top bar and a timeline. The home screen deliberately uses the same look: its sessions are laid out as timing rows, its column headers match the timing tower's, and its one white button plays the same role as the replay screen's white play button. There is one system across both screens. Home is the front page of the same instrument.

The page is dense but readable. Rows are 44px high and use 14px type for names and 12px for figures. Columns are capped by small uppercase labels. Hierarchy comes from contrast, weight and position, never from colour or containers. Everything is drawn in zinc greys. A short list of signal colours carries meaning, and only that meaning: red for live and delete, fuchsia for fastest, emerald for personal best and confirmed, amber for waiting or needs-attention. Team colours appear only as data, as the driver stripe in the timing tower and the driver panel, and as driver tags in the feed. Country flags are data in the same way: a small 3:2 flag (`src/components/Flag.tsx`, SVG so it draws the same on every OS) beside a circuit's name, on home's circuit board and the circuit page's title. The interface never borrows either for chrome.

Motion only shows state. Rows highlight, download fills grow, tower rows slide when positions change, and the light on a battle going on now beats while the replay plays. Nothing animates for its own sake.

**Key Characteristics:**
- Near-black ground (pit-black) with hairline dividers (hairline) instead of cards.
- Timing rows: tabular figures, short bold names, 11px uppercase column labels.
- Grey controls, one white button per screen, signal colours that each mean one thing.
- Flat surfaces; only floating popovers get a shadow.
- Keyboard first: `/` focuses the jump field, the replay screen has letter shortcuts, and every control shows a visible focus outline.

## Colors

The palette is greyscale (Tailwind v4's zinc, which leans slightly violet and is the canonical source via `--color-zinc-*`) plus a few signal colours that each have exactly one meaning.

### Primary
- **Pit Wall White** (primary-ink): the fill of the one primary button and the colour of normal foreground text. Its hover is pure-white. Being the only bright filled area on the page is what makes it primary.

### Secondary
- **Live Red** (live-red): fill of the LIVE badge and the destructive Delete button. Signal Red (signal-red) is the text form, used for live labels, "Starts in", errors and failed downloads. The replay timeline's live edge and the live dot use red-500 (danger-hover-red).

### Tertiary
- **Fastest Fuchsia** (fastest-fuchsia): the overall fastest lap or sector, and nothing else. Its absence from home is correct; home shows no results.
- **Personal-Best Emerald** (personal-best-emerald): a driver's own best lap or sector, positions gained, the playing state of the play button, the light on a battle going on at the playhead (Battles, with a faint 5% wash on its row), and the "Kept" check on home.
- **Caution Amber** (caution-amber): waiting, paused, queued and needs-an-update states. Banners use an amber-500 wash at 10% under caution-wash-text.

### Neutral
- **Pit Black** (pit-black): the page ground everywhere, including the sticky header and the timeline bar.
- **Raised Panel** (raised-panel): row hover, the jump field, segmented-control tracks, popovers.
- **Hairline** (hairline): every divider and border, plus the fill of secondary buttons, stored season cells and neutral badges. Row dividers inside a list use it at 70% opacity.
- **Control Hover** (control-hover): secondary-button hover, the selected segment, the jump field's border on hover, kbd borders.
- **Hairline Strong** (hairline-strong): the jump field's border on focus, link underline decoration, and decorative " · " separators. Never use it for text people need to read.
- **Secondary Text** (secondary-text): column labels, places, dates, sizes, captions and helper text. This is the floor for any meaningful text on pit-black, at about 7:1.
- **Tertiary Ink / Body Ink** (tertiary-ink, body-ink): status text, session names, quiet cells, and the download progress fill (tertiary-ink).
- **Headline White** (headline-white): Grand Prix names, section headings, the countdown figure.

### Named Rules
**The One White Button Rule.** Each screen has at most one filled pale button: whatever can be done right now. On home that is the first Continue row's Resume or Watch, or Watch live while the live row shows. On replay it is the play button. Every other button is grey (button-secondary).

**The One Meaning Rule.** Red means live or destroy. Fuchsia means fastest overall. Emerald means personal best or done, and on the replay screen, playing: the play button and what is going on at the playhead. Amber means waiting or attention. Never use these colours for decoration, and never colour by session type.

**The Readable Grey Rule.** Text someone has to read is never darker than secondary-text (zinc-400) on pit-black. zinc-500 and darker are only for borders and separators.

## Typography

**Display Font:** none. The system has no display face.
**Body Font:** the platform sans (`ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif`), antialiased.
**Label/Mono Font:** the same family. Figures use tabular numerals (`tnum`), not a monospace font.

**Character:** One utilitarian sans in a few weights. Tabular figures do the work of a monospace, so times, sizes and gaps line up down a column.

**Open decision (recorded, not decided):** whether to replace the platform sans with a sourced face app-wide. The finish review flagged that system-ui renders differently per OS and gives Pitwall no typographic identity of its own. Any replacement must keep tabular figures, hold up at 11px uppercase, and apply to the replay screen and home together. Until then, the platform stack above is the system.

### Hierarchy
- **Headline** (700, 24px, 32px line, -0.025em): section titles on home ("Continue", "Season"). Plain words, no label above them.
- **Stat** (900, 20px, tabular): the replay header's big readouts (LAP 25/51, race clock).
- **Input** (400, 16px): the jump field.
- **Title** (600, 14px): Grand Prix names in rows, the live row's session, names in the replay header. Driver codes in the tower use 700 with wide tracking.
- **Body** (400, 14px, tabular): row cells, header values (countdown, stored count), empty-state copy. Prose is capped at 75ch.
- **Body Small** (400–600, 12px, tabular): season/round, dates, status, size, buttons, helper and banner text.
- **Label** (600, 11px, 0.05em tracking, uppercase, secondary-text): column headers, header stat labels ("NEXT · R16 BAHRAIN GP", "STORED"), badges, settings group names.
- **Mark** (10px and under): what sits inside a cell and isn't read on its own: position-change arrows, units (km/h), the DRS and gear chips, tyre letters, the timeline's lap ticks and event markers. Never for a label, a badge or a sentence.

### Named Rules
**The Tabular Rule.** Every number that can change or sits in a column (times, sizes, rounds, percentages, countdowns) uses tabular figures.

**The Label-Over-Value Rule.** Uppercase labels sit only over a value or at the top of a column, like the header's RACE / LOCAL / STORED stacks. They never sit above a headline as a kicker or eyebrow.

## Layout

There are two spatial modes with one shared header. The replay screen runs edge to edge: a 52px top bar (16px side padding, three columns with the centre auto-sized), a widget grid the user arranges, and a timeline bar at the bottom. Home is a centred column, 72rem max width with 24px gutters, under a sticky 52px header that uses the same three-column grid (logo / the moment / storage and Settings). On home the centre column keeps its slot below 768px even when its content is hidden, so the right side stays on the right.

Home's vertical rhythm: 24px from the header to the jump field (48px tall), 40px to Continue, 48px to Season, 64px of bottom padding, then a footer above a hairline. Rows use 12px side padding and a 44px minimum height. Section headings sit 12px above their column headers.

Row columns respond to the row's container width, not the viewport (container queries at 40rem, 52rem and 66rem; the season sheet also uses 64rem). A narrow list drops Size and Status first, then Date, then Season and Session, and the action column (12.5rem) always fits. The season sheet scrolls sideways below 45rem, with the round and Grand Prix pinned.

On a phone (under 768px, `usePhone()`) the replay screen keeps its shape and loses its grid: a two-row header (the way around, then the race's state), one column of the same widgets that scrolls between them, and the timeline pinned at the bottom with the scrub bar across the top of it and the transport under. Qualifying is tabbed (Board / Charts / Map). Layout editing, the keyboard help, weather and the local clock are desktop-only. Touch targets are 44px: a control drawn smaller gets an invisible ring (`touch-hit`), nothing changes on screen. Anything hover reveals, a tap reveals too.

## Elevation & Depth

The system is flat. Depth comes from tone (pit-black, then raised-panel, then hairline) and from hairline borders, not shadows. Panels, rows, the header and the timeline all sit on the same plane. Shadows appear only on things floating above the page: popovers, menus and tooltips.

### Shadow Vocabulary
- **Popover** (`box-shadow: 0 25px 50px -12px rgb(0 0 0 / 0.25)`, Tailwind shadow-2xl): the Settings panel.
- **Menu** (`box-shadow: 0 20px 25px -5px rgb(0 0 0 / 0.1), 0 8px 10px -6px rgb(0 0 0 / 0.1)`, shadow-xl): the replay help popover and widget picker.
- **Tooltip** (shadow-lg): the timeline's hover tip.

### Named Rules
**The Hairline Rule.** Separate content with a 1px hairline. Never use a filled card, a raised tile, or a soft panel with a shadow.

## Shapes

Radius belongs to controls, never to content regions. Buttons, cells, the jump field, segmented tracks and icon buttons use gently rounded 6px corners (md). Badges, kbd keys and segment options use 4px (base). Inline text links get a 2px corner (sm) so their focus outline isn't square. Floating popovers use 8px (lg). Progress tracks, the live dot, toggles and the play button are fully round. Lists, panels, the header and the grid are square-edged and bounded only by hairlines. Icons are 16-unit SVG paths with a 1.5 stroke; the play triangle is solid. The replay screen and widgets draw them with widget-kit's `Icon` (`src/widgetkit/ui/Icon.tsx`), whose play and check match home's.

## Components

### Buttons
Small grey buttons that read as tools, with one white exception per screen.
- **Shape:** gently rounded (6px), 12px semibold text, 4px × 10px padding, no wrapping.
- **Primary:** primary-ink fill with pit-black text; hover pure-white. Limited to one per screen.
- **Secondary:** hairline fill with primary-ink text; hover control-hover with white text. Used for Cancel, Keep, Try again, Settings, Edit layout.
- **Danger:** live-red fill with white text; hover danger-hover-red. Only appears inside an inline delete confirmation ("Delete 17 MB? Delete / Keep").
- **Icon:** a 28px square, secondary-text glyph, raised on hover to hairline fill and primary-ink. The trash button stays hidden until the row is hovered or focused.
- **Focus:** a 2px zinc-300 outline offset by 2px on every interactive element (`src/index.css` gives it to every control; rows that fill a scrolling list inset it 2px so it isn't clipped). Colour transitions are 150ms. Disabled buttons drop to 50% opacity.

### Chips
- **Badges:** 11px uppercase label type on a 4px-radius fill. LIVE is live-red with white text. NEXT is a neutral hairline badge. The replay header's flag status (GREEN FLAG and others) is the same filled badge in the flag's colour.
- **Segmented control:** a raised-panel track (2px padding, 6px radius) holding 12px semibold options. The selected option is control-hover with headline-white text; the others are tertiary-ink. Used for home's year toggle and race filter, and the replay's playback speed (the play button stays the one white button).

### Widget kit
Widgets get the system from widget-kit (`src/widgetkit/ui/`), not their own copies: `Label` and `LABEL_CLASS` (the label type), `Stat` (a label over its value), `Icon`, `DriverTag` (a driver's acronym badge on the team colour) and `TyreBadge`. Third-party widgets use the same pieces, so they look like they belong.

### Circuit widgets
Safety cars and Strategies draw earlier races at the circuit with the replay's own vocabulary. Neutral laps use the flag colours of the header's status badge: amber for a safety car, lighter amber hatched for a VSC (so it isn't colour alone), red for a red flag. Tyres use the compound colours and letters, and drivers are tagged on their team colour. Earlier races are history, not spoilers: they show without a Show button. While races load, the widget keeps its header and lays out its rows from the calendar (years are known before the data is), with pulsing grey placeholders shaped like the bars that fill in race by race (no pulse under reduced motion), and the header says "Loading 2 of 3". A race that didn't load says why in signal-red in its own row ("Couldn't reach OpenF1. Check the connection."), and the header offers Try again.

### Cards / Containers
None. The system has no cards. Lists sit inside a hairline frame: a column-header row with a hairline under it, then rows divided by hairline at 70% opacity. Empty and error states are a single bordered strip (hairline above and below, 12px × 16px padding).

**Circuit board** (home's Circuits tab): the one two-dimensional list. Square cells on pit-black, framed and divided by 1px hairlines like the replay screen's widget grid (three columns on a desktop, two from 420px, one below), never separate rounded cards. A cell leads with its round as a figure (stat weight, tabular), then the flag and circuit name (15px semibold), the Grand Prix and dates (body-small), and the counts (secondary-text). Order follows what the visitor came for: the next weekend first (raised-panel fill, neutral NEXT badge, or LIVE), then the weekends raced this season newest first, the cancelled ones struck through, then "Later this season" in calendar order and "Earlier seasons", each under a label. Weekends still to come step back to secondary-text with their flag faded; raced ones stay bright because they can be watched.

### Inputs / Fields
- **Jump field:** 48px tall, raised-panel fill, hairline border, 6px radius, 16px headline-white text, secondary-text placeholder, a search glyph inset 16px from the left, and a `/` kbd hint on the right that becomes "Esc clear" while typing. Hover border is control-hover; focus border is hairline-strong plus the focus outline.
- **Replay settings inputs:** hairline fill, 4px radius, 12px text.

### Navigation
The header carries the navigation. On home that is the logo, the moment (label over countdown, or the LIVE badge over the session name), the stored count and size, the vault indicators and the Settings button. On replay it is a secondary "Races" back button, the session picker, stat stacks and layout controls. Settings opens a 320px popover.

### Timing Row (signature)
The shared unit of both screens: one line per driver or session, aligned to column headers. On home a session row reads Season · R, Grand Prix (headline-white semibold) with place in secondary-text, Session, Date, Status (tinted only by its signal colour), Size, and right-aligned actions. Hover is raised-panel. The keyboard-picked jump result uses hairline at 60% opacity. Download progress is a 4px round track (hairline) with a tertiary-ink fill that grows over 700ms ease-out.

### Season Cell (signature)
Each session in the season sheet is its own action, 32px tall with a 6px radius. Stored sessions are filled (hairline fill, headline-white, solid play glyph). Available sessions are quiet (tertiary-ink, outline play glyph, hover raised). Downloads and part-stored sessions show their fraction as a fill growing behind the label. Upcoming sessions show their day and time in secondary-text, and a live session shows red "Live".

## Do's and Don'ts

### Do:
- **Do** put the page on pit-black (#09090b) and divide it with 1px hairline (#27272a) borders.
- **Do** keep one filled primary-ink button per screen. Make every other control grey (button-secondary).
- **Do** set column headers and stat labels at 11px, 600 weight, uppercase, 0.05em tracking, in secondary-text (#9f9fa9).
- **Do** use tabular figures for every time, size, round and percentage.
- **Do** let row columns respond to their container (container queries), so the action column always fits.
- **Do** give every interactive element the 2px zinc-300 focus outline with a 2px offset.
- **Do** keep motion tied to state: row highlight, progress fills (700ms ease-out), tower reordering (500ms ease-out), a live battle's light (a 2s ring, only while playing, every light on the same beat, none under reduced motion).

### Don't:
- **Don't** wrap content in rounded cards or shadowed tiles. Radius is for controls; shadows are for floating popovers only.
- **Don't** use red, fuchsia, emerald or amber for anything except their single meanings, and don't colour sessions by type.
- **Don't** use zinc-500 or darker for text someone has to read on pit-black.
- **Don't** put an uppercase label above a section headline as a kicker or eyebrow.
- **Don't** use team, driver or circuit imagery. Team colour appears only as data (the tower stripe, feed driver tags).
- **Don't** use Unicode characters or emoji as icons. Draw icons as 16-unit SVG paths.
