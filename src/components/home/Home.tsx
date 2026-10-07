// The landing page, the front of the replay instrument (same look as the replay screen). Above it, while calls are
// open, the way to Called It (CallBanner). The header says what the
// moment is: the next session's countdown, or a session live now. Under it a live row, only while live mode can
// actually follow a session (the page's one white button then). Then the jump field, which finds any session by
// Grand Prix, year and type, over Continue (what's in this browser, the latest race first when it's newer than what
// was last watched) and, as tabs, the season's circuits (each opening the circuit's page) or the season sheet.
// Opening a session from here is a new history entry (useReplay's openSession).

import { useEffect, useMemo, useState } from "react";
import { LIVE_TYPES } from "../../../scripts/lib/season";
import { isLive, nextSession, nextWeekend, type CatalogRow } from "../../ingest/catalog";
import { currentYear, FIRST_YEAR, useLibrary } from "../../library";
import { liveVia } from "../../live/client";
import { accountNeed } from "../../live/vault";
import { usePhone } from "../../hooks/usePhone";
import { useReplay } from "../../store";
import { CallBanner } from "../CallBanner";
import { accountStatus, LiveDot } from "../LiveControl";
import { Logo } from "../Logo";
import { useVault } from "../vault/useVault";
import { VaultIndicators } from "../vault/VaultStatus";
import { Attribution, FOCUS, LABEL, PRIMARY, SECONDARY, sessionTime, shortGp, size, useDownloadBlock, useNow, waitText } from "./common";
import { Continue } from "./Continue";
import { Jump } from "./Jump";
import { Season } from "./Season";
import { Circuits } from "./Circuits";
import { Settings } from "./Settings";
import { ForecastBrief } from "../circuit/Forecast";

/** Why downloads wait (unless the live row already says), and another tab downloading. */
function Banners({ liveRow }: { liveRow: boolean }) {
  const until = useDownloadBlock();
  const otherTab = useLibrary((s) => s.otherTab);
  const wait = until != null && !liveRow;
  if (!wait && !otherTab) return null;
  return (
    <div className="border-t border-zinc-800 bg-amber-500/10">
      <div className="mx-auto max-w-6xl space-y-1 px-4 py-2 text-xs leading-relaxed text-amber-200 md:px-6">
        {wait && <p className="max-w-[75ch]">{waitText(until)}</p>}
        {otherTab && <p className="max-w-[75ch]">Another tab of this app is downloading. Downloads here start when it's done (one at a time keeps within OpenF1's rate limit).</p>}
      </div>
    </div>
  );
}

type Years = ReturnType<typeof useLibrary.getState>["years"];

/** The season's latest race that has happened (last season's, before this one's first). */
function latestRace(years: Years, now: number): CatalogRow | null {
  const last = (y: number) => years[y]?.catalog?.rows.filter((r) => r.sessionName === "Race" && !r.cancelled && Date.parse(r.dateEnd) < now).at(-1) ?? null;
  if (!years[currentYear()]?.catalog) return null;
  return last(currentYear()) ?? last(currentYear() - 1);
}

/** A filled status badge, as the replay screen's flag status (GREEN FLAG). */
const LIVE_BADGE = "shrink-0 rounded bg-red-600 px-1.5 py-px text-[11px] font-bold uppercase tracking-wider text-white";

/** "2d 4h", "3h 12m", "12m 05s". */
function countdownShort(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m ${String(s % 60).padStart(2, "0")}s`;
}

// ---------------------------------------------------------------- the moment

/**
 * Live mode can be opened this long before a race, sprint, qualifying or practice starts: it waits (showing "Next live") and
 * follows the session by itself once it streams, from 15 minutes before the start.
 */
const LIVE_WAIT_MS = 60 * 60_000;

/** What live mode offers right now: follow the session under way, or wait for the next one. */
type LiveAction = { kind: "watch" | "wait"; row: CatalogRow } | null;

function liveAction(weekend: CatalogRow[] | null, now: number): LiveAction {
  // Neither a relay nor the vault (a static build without it): no live mode.
  if (!liveVia() || !weekend) return null;
  const next = nextSession(weekend, now);
  if (!next || !LIVE_TYPES.includes(next.sessionType)) return null;
  if (isLive(next, now)) return { kind: "watch", row: next };
  return Date.parse(next.dateStart) - now <= LIVE_WAIT_MS ? { kind: "wait", row: next } : null;
}

/** The header's centre: the next session and its countdown, or the session live now. Seconds tick in the last hour. */
function Moment({ weekend }: { weekend: CatalogRow[] | null }) {
  const coarse = useNow(30_000);
  const upcoming = weekend && nextSession(weekend, coarse);
  const now = useNow(upcoming && Date.parse(upcoming.dateStart) - coarse < 61 * 60_000 ? 1000 : 30_000);
  const next = weekend && nextSession(weekend, now);
  if (!weekend || !next) return null;
  const first = weekend[0];
  const meeting = `${first.round != null ? `R${first.round} ` : ""}${shortGp(first.meetingName)}`;
  const live = isLive(next, now);
  const started = Date.parse(first.dateStart) <= now;

  if (live) {
    const minutes = Math.max(0, Math.floor((now - Date.parse(next.dateStart)) / 60_000));
    return (
      <div className="flex min-w-0 flex-col items-center leading-tight" title={`${next.sessionName}: started ${sessionTime(next.dateStart)}`}>
        <span className={`${LABEL} truncate`}>{meeting}</span>
        <span className="flex items-center gap-1.5 truncate text-sm text-zinc-100">
          <LiveDot pulse={false} />
          {next.sessionName} live for <span className="font-bold tabular-nums text-zinc-50">{minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`}</span>
          {!liveVia() && <span className="text-zinc-300"> · here about 30 min after it ends</span>}
        </span>
      </div>
    );
  }
  return (
    <div className="flex min-w-0 flex-col items-center leading-tight">
      <span className={`${LABEL} truncate`}>
        {started ? "This weekend" : "Next"} · {meeting}
      </span>
      <span className="truncate text-sm tabular-nums text-zinc-100">
        {next.sessionName} in <span className="font-bold text-zinc-50">{countdownShort(Date.parse(next.dateStart) - now)}</span>
        <span className="text-zinc-400"> · {sessionTime(next.dateStart)}</span>
        <ForecastBrief circuitKey={next.circuitKey} start={Date.parse(next.dateStart)} end={Date.parse(next.dateEnd)} now={now} />
      </span>
    </div>
  );
}

/**
 * Live mode's row, only while it can follow (or wait for) a race, sprint, qualifying or practice: the page's white button. Through
 * the vault (no relay) it needs a connected OpenF1 account: until there is one, the row says so and the button gets it.
 */
function LiveRow({ action }: { action: NonNullable<LiveAction> }) {
  const enterLive = useReplay((s) => s.enterLive);
  const now = useNow(1000);
  const until = useDownloadBlock();
  const vault = useVault();
  const { row } = action;
  const watch = action.kind === "watch";
  // (Still loading or checking the login: Watch live, and the live screen says how it goes.)
  const need = liveVia() === "vault" ? accountNeed(vault) : null;
  const account = need && need !== "loading" && need !== "checking" ? accountStatus(need, true) : null;
  return (
    <section data-shot="" aria-label="Live" className="mb-6 flex flex-wrap items-center gap-x-4 gap-y-2 border-y border-zinc-800 px-3 py-3">
      {watch ? (
        <span className={LIVE_BADGE}>Live</span>
      ) : (
        <span className="text-xs font-bold uppercase tracking-wider text-red-400">Starts in {countdownShort(Date.parse(row.dateStart) - now)}</span>
      )}
      <span className="min-w-0">
        <span className="block text-sm font-semibold text-zinc-50">
          {shortGp(row.meetingName)} · {row.sessionName}
        </span>
        <span className="block text-xs leading-relaxed text-zinc-300">
          {watch ? "Timing, track map and the race feed, following it as it happens." : "Live mode waits for the start, then follows it."}
        </span>
        {account && (
          <span className={`block max-w-[75ch] text-xs leading-relaxed ${account.tone === "error" ? "text-red-400" : "text-amber-300"}`} data-testid="live-row-account">
            {account.text}
          </span>
        )}
        {until != null && <span className="block max-w-[75ch] text-xs leading-relaxed text-amber-300">{waitText(until)}</span>}
      </span>
      <span className="flex-1" />
      {account ? (
        // Connect / Unlock / Reconnect open the vault's popup: inside the click.
        account.action && (
          <button
            onClick={(e) => {
              e.currentTarget.blur();
              account.action!.run();
            }}
            className={`${PRIMARY} px-4 py-2 text-sm pointer-coarse:min-h-11`}
          >
            {account.action.label}
          </button>
        )
      ) : (
        <button
          onClick={(e) => {
            e.currentTarget.blur();
            enterLive();
          }}
          className={`${PRIMARY} px-4 py-2 text-sm pointer-coarse:min-h-11`}
        >
          {watch ? "Watch live" : `Watch the ${row.sessionName.toLowerCase()} live`}
        </button>
      )}
    </section>
  );
}

/**
 * The header's right: sessions in this browser and the space they take. On a phone it stays (what's downloaded is
 * what matters offline), as the count alone with the size under it when there is one.
 */
function Stored() {
  const ready = useLibrary((s) => s.ready);
  const count = useLibrary((s) => Object.keys(s.entries).length);
  const usage = useLibrary((s) => s.usage);
  if (!ready) return null;
  return (
    <span className="flex flex-col items-end leading-tight" title="Sessions downloaded into this browser">
      <span className={LABEL}>Stored</span>
      <span className="text-sm tabular-nums text-zinc-100">
        {count}
        {usage?.usage != null && <span className="text-zinc-400"> · {size(usage.usage)}</span>}
      </span>
    </span>
  );
}

type Browsing = "circuits" | "season";
const BROWSING_KEY = "f1-replay:home-browse";
const readBrowsing = (): Browsing => {
  try {
    return globalThis.localStorage?.getItem(BROWSING_KEY) === "season" ? "season" : "circuits";
  } catch {
    return "circuits";
  }
};

/**
 * Under Continue: the season's circuits (each opening its page, with every session there over the years), or the
 * season sheet (every session of a season by round). Tabs that are the section's title; the choice is kept.
 */
function Browse() {
  const [browsing, setBrowsing] = useState(readBrowsing);
  const choose = (b: Browsing) => {
    setBrowsing(b);
    try {
      globalThis.localStorage?.setItem(BROWSING_KEY, b);
    } catch {
      // Not kept: circuits next time.
    }
  };
  const heading = (
    <h2 className="flex scroll-mt-16 items-baseline gap-4" role="tablist" aria-label="Browse">
      {(
        [
          ["circuits", "Circuits"],
          ["season", "Season"],
        ] as const
      ).map(([id, label]) => (
        <button
          key={id}
          role="tab"
          aria-selected={browsing === id}
          onClick={() => choose(id)}
          className={`rounded-sm text-2xl font-bold tracking-tight ${FOCUS} ${browsing === id ? "text-zinc-50" : "text-zinc-400 hover:text-zinc-200"}`}
        >
          {label}
        </button>
      ))}
    </h2>
  );
  return browsing === "circuits" ? <Circuits heading={heading} /> : <Season heading={heading} />;
}

export function Home() {
  const years = useLibrary((s) => s.years);
  const current = useLibrary((s) => s.years[currentYear()]);
  const now = useNow(30_000);
  const featured = useMemo(() => latestRace(years, now), [years, now]);
  const season = current?.catalog;
  const weekend = useMemo(() => (season ? nextWeekend(season.rows, now) : null), [season, now]);
  const action = liveAction(weekend, now);
  const phone = usePhone();

  useEffect(() => {
    const s = useLibrary.getState();
    void s.loadYear(currentYear());
    void s.loadYear(s.calendarYear);
    void s.refreshUsage();
    // Nobody wants a session's keyboard focus (e.g. the Races button) on Home.
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  }, []);

  // Early in a season, before its first race: last season's final race.
  const noRaceYet = season != null && !featured;
  useEffect(() => {
    if (noRaceYet && currentYear() - 1 >= FIRST_YEAR) void useLibrary.getState().loadYear(currentYear() - 1);
  }, [noRaceYet]);

  return (
    // On a phone the status bar's strip (the safe area) is a solid band above the page, so nothing scrolls under the
    // notch and the sticky header sits just below it. The band is 0 tall everywhere else.
    <div className="flex h-full flex-col">
      <div className="h-[env(safe-area-inset-top)] shrink-0 bg-zinc-950" aria-hidden />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <CallBanner />
        <header className="sticky top-0 z-20 border-b border-zinc-800 bg-zinc-950">
          <div className="mx-auto grid h-[52px] max-w-6xl grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-3 px-4 md:gap-6 md:px-6">
            <h1 className="text-zinc-100">
              <Logo className="h-6 w-auto" />
            </h1>
            {/* Its column stays when a phone moves it below, so the right side stays right. */}
            <div className="flex min-w-0 justify-center">{!phone && <Moment weekend={weekend} />}</div>
            <div className="flex items-center justify-end gap-3 md:gap-4">
              <Stored />
              <VaultIndicators />
              <Settings />
            </div>
          </div>
          <Banners liveRow={action != null} />
        </header>

        <main className="mx-auto max-w-6xl px-4 pb-16 pt-6 md:px-6">
          {/* A phone's header is too narrow for the moment: it leads the page instead. */}
          {phone && (
            <div className="mb-6 flex justify-center empty:hidden">
              <Moment weekend={weekend} />
            </div>
          )}
          {current?.error && !current.catalog && (
            <div className="mb-6 flex flex-wrap items-center gap-3 border-y border-zinc-800 px-3 py-3 text-sm text-red-400">
              {current.error}
              <button onClick={() => void useLibrary.getState().loadYear(currentYear(), { force: true })} className={SECONDARY}>
                Try again
              </button>
            </div>
          )}
          {action && <LiveRow action={action} />}
          <Jump>
            <Continue featured={featured} lead={!action} />
            <Browse />
          </Jump>
        </main>

        <footer className="mx-auto max-w-6xl px-4 md:px-6">
          <div className="border-t border-zinc-800 py-5">
            <Attribution />
          </div>
        </footer>
      </div>
    </div>
  );
}
