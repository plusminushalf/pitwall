// The landing page, built around one job, watching the latest race. It leads (with the page's one filled button),
// unless a race weekend is close (HERO_WINDOW_MS): then that weekend leads, with its countdown and a way into live
// mode, and the latest race follows as a card. Then the next weekend as a line of information (when it isn't
// leading), the library in this browser and every season's calendar to download from. Opening a session from here
// is a new history entry (useReplay's openSession).

import { useEffect, useMemo, useState } from "react";
import { LIVE_TYPES } from "../../../scripts/lib/season";
import { heroWeekend, isLive, nextSession, nextWeekend, type CatalogRow } from "../../ingest/catalog";
import { currentYear, FIRST_YEAR, liveWindowOf, rowState, useLibrary, type RowState } from "../../library";
import { LIVE_RELAY } from "../../live/client";
import { raceClock } from "../../lib/format";
import { useReplay, watchHistory } from "../../store";
import { LiveControl, LiveDot } from "../LiveControl";
import { Action, approx, Attribution, clockTime, estimateText, LABEL, left, mb, relativeDay, RowDetails, sessionDot, size, useNow, useRowState } from "./common";
import { Calendar, Chip, resumeClocks } from "./Calendar";
import { Library } from "./Library";
import { VaultStatus } from "../vault/VaultStatus";

const when = (iso: string) => new Date(iso).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "long", year: "numeric" });

function Banners() {
  const years = useLibrary((s) => s.years);
  const blocked = useLibrary((s) => s.blocked);
  const otherTab = useLibrary((s) => s.otherTab);
  const now = useNow(15_000);
  const w = liveWindowOf({ years, blocked }, now);
  if (!w && !otherTab) return null;
  return (
    <div className="border-b border-zinc-800 bg-amber-500/10">
      <div className="mx-auto max-w-7xl space-y-1 px-6 py-2 text-[11px] leading-relaxed text-amber-200">
        {w && (
          <p>
            <span className="font-semibold">Live session: {w.label}.</span> OpenF1 blocks free downloads from 30 minutes before a session until 30 minutes after it,
            so downloads wait until about {clockTime(w.until)} and then start by themselves.
          </p>
        )}
        {otherTab && <p>Another tab of this app is downloading. Downloads here start when it's done (one at a time keeps within OpenF1's rate limit).</p>}
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

/** "Sun 4 Oct, 09:00" (local time). */
const sessionTime = (iso: string) => new Date(iso).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
/** "Sun 4 Oct". */
const shortDay = (iso: string) => new Date(iso).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });

/** "in 8 min", "in 5 h 12 min", else calendar days: "tomorrow", "in 3 days" (as in the calendar). */
function countdown(iso: string, now: number) {
  const min = Math.max(1, Math.round((Date.parse(iso) - now) / 60_000));
  if (min < 60) return `in ${min} min`;
  if (min < 12 * 60) return `in ${Math.floor(min / 60)} h ${min % 60} min`;
  return relativeDay(iso, now);
}

/**
 * The weekend to come, as one line of information: which session is next and when (named, so a countdown to
 * qualifying can't read as one to the race), and the race's day.
 */
function NextUp({ rows, now }: { rows: CatalogRow[]; now: number }) {
  const first = rows[0];
  const race = rows.find((r) => r.sessionName === "Race") ?? rows.at(-1)!;
  // The session under way, or the next to start.
  const next = rows.find((r) => Date.parse(r.dateEnd) > now) ?? race;
  const live = Date.parse(next.dateStart) <= now;
  const started = Date.parse(first.dateStart) <= now;
  const place = [first.circuit, first.country].filter(Boolean).join(" · ");
  return (
    <section
      aria-label="Next race weekend"
      className="flex flex-wrap items-baseline gap-x-3 gap-y-1 rounded-lg border border-zinc-800/70 px-4 py-2.5 text-sm"
    >
      <span className={`flex shrink-0 items-center gap-1.5 self-center ${LABEL}`}>
        <span className={`h-1.5 w-1.5 rounded-full ${live ? "bg-red-500" : "bg-zinc-600"}`} />
        {started ? "This weekend" : "Next"}
        {first.round != null ? ` · R${first.round}` : ""}
      </span>
      <span className="font-semibold text-zinc-200">{first.meetingName}</span>
      {place && <span className="text-xs text-zinc-500">{place}</span>}
      <span className="text-zinc-400">
        <span className={live ? "font-semibold text-red-400" : "text-zinc-300"} title={`${next.sessionName}: ${sessionTime(next.dateStart)}`}>
          {next.sessionName} {live ? "live now" : countdown(next.dateStart, now)}
        </span>
        {next !== race && (
          <>
            {" "}
            <span className="text-zinc-600">·</span> <span title={`Race: ${sessionTime(race.dateStart)}`}>Race {shortDay(race.dateStart)}</span>
          </>
        )}
        {next === race && !live && <span className="text-zinc-500"> · {sessionTime(race.dateStart)}</span>}
      </span>
      <span className="ml-auto text-[11px] text-zinc-600">Each session can be downloaded about 30 minutes after it ends</span>
    </section>
  );
}

/** Big buttons: `filled` for the page's one filled button (whatever can be done right now), else outlined. */
const heroButton = (filled: boolean, small = false) =>
  `inline-flex items-center gap-2 whitespace-nowrap rounded-md font-bold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-300 disabled:opacity-50 ${
    small ? "px-4 py-2 text-sm" : "px-6 py-3 text-base"
  } ${filled ? "bg-zinc-100 text-zinc-900 hover:bg-white" : "border border-zinc-700 text-zinc-200 hover:border-zinc-500 hover:text-white"}`;

/** The latest race's one action: Download, Watch, or its download under way. */
function HeroAction({ row, state, resumeAt, filled, small }: { row: CatalogRow; state: RowState; resumeAt: string | null; filled: boolean; small: boolean }) {
  const download = useLibrary((s) => s.download);
  const reprocess = useLibrary((s) => s.reprocess);
  const cancel = useLibrary((s) => s.cancel);
  const watchNow = useLibrary((s) => s.watchNow);
  // Left for Home: Watch picks it up where it was.
  const loaded = useReplay((s) => s.mode === "replay" && s.session?.meta.sessionKey === row.sessionKey);
  const key = row.sessionKey;
  const status = (text: string) => <span className="whitespace-nowrap text-sm tabular-nums text-zinc-300">{text}</span>;
  const HERO_PRIMARY = heroButton(filled, small);
  const HERO_SECONDARY = heroButton(false, small);

  switch (state.kind) {
    case "ready":
      return (
        <button onClick={() => watchNow(key)} className={HERO_PRIMARY}>
          {loaded ? "Continue watching" : resumeAt ? `Continue from ${resumeAt}` : "Watch the race"}
        </button>
      );
    case "available":
      return (
        <button onClick={() => download(row)} className={HERO_PRIMARY} title={`Download from OpenF1 into this browser (${estimateText(state.estimate)})`}>
          Download the race
        </button>
      );
    case "partial":
      return (
        <button onClick={() => download(row)} className={HERO_PRIMARY} title="Continue from the files already downloaded">
          Resume download
        </button>
      );
    case "stale":
      return (
        <button
          onClick={() => reprocess(state.entry)}
          className={HERO_PRIMARY}
          title="Processed by an older version of the app: re-process it from the stored OpenF1 data (no download)"
        >
          Update to watch
        </button>
      );
    case "remote":
      return status(state.job.progress ? `Downloading in another tab · ${Math.round(state.job.progress.progress * 100)}%` : "Downloading in another tab");
    case "job": {
      const { job } = state;
      if (job.phase === "failed") {
        return (
          <button onClick={() => download(row)} className={HERO_PRIMARY} title={state.cache ? "Continue from the files already downloaded" : "Try again"}>
            Retry download
          </button>
        );
      }
      const p = job.progress;
      const text =
        job.phase === "queued" ? "Queued" : job.phase === "paused" ? "Waiting" : p ? `${Math.round(p.progress * 100)}% · ${left(p.etaSeconds)}` : job.info.mode === "reprocess" ? "Updating…" : "Starting…";
      return (
        <div className="flex items-center gap-4">
          {status(text)}
          <button onClick={() => cancel(key)} className={HERO_SECONDARY} title="Stop; what's downloaded so far is kept">
            Cancel
          </button>
        </div>
      );
    }
    default:
      return status(state.kind === "upcoming" ? "Not run yet" : "Cancelled");
  }
}

/** What the replay costs or where it was left: size and time to download, or what's stored. */
function replayFact(state: RowState, resumeAt: string | null): string | null {
  switch (state.kind) {
    case "ready":
      return `${resumeAt ? `Paused at ${resumeAt} · ` : ""}in this browser · ${size(state.entry.processedBytes + state.entry.rawBytes)}`;
    case "stale":
      return `Needs an update (no download) · ${size(state.entry.processedBytes + state.entry.rawBytes)}`;
    case "available":
      return `~${mb(state.estimate.mb * 1e6)} MB · ${approx(state.estimate.seconds)} to download`;
    case "partial":
      return `${state.cache.cachedFiles}/${state.cache.expectedFiles} files stored · ${approx(state.estimate.seconds)} left`;
    case "job":
      return state.job.phase === "failed" ? "Download failed" : "Downloading into this browser";
    case "remote":
      return "Downloading in another tab";
    default:
      return null;
  }
}

/**
 * The latest race, to download or watch, and the rest of its weekend: the page's focus (`lead`), or a card under a
 * race weekend that's under way or close. `filled`: its button is the page's one filled button.
 */
function LatestRace({
  row,
  resumeAt,
  weekend,
  rounds,
  lead,
  filled,
}: {
  row: CatalogRow;
  resumeAt: string | null;
  weekend: CatalogRow[];
  rounds: number | null;
  lead: boolean;
  filled: boolean;
}) {
  const state = useRowState(row);
  const jobs = useLibrary((s) => s.jobs);
  const remote = useLibrary((s) => s.remote);
  const entries = useLibrary((s) => s.entries);
  const partial = useLibrary((s) => s.partial);
  const now = useNow(2000);
  // Read once per visit to Home (it's written while watching).
  const [resume] = useState(resumeClocks);
  const others = weekend.filter((r) => r.sessionKey !== row.sessionKey && !r.cancelled && Date.parse(r.dateEnd) < now);
  const fact = state && replayFact(state, resumeAt);
  const place = [row.circuit, row.country, when(row.dateStart)].filter(Boolean).join(" · ");
  const chips = others.map((r) => (
    <Chip key={r.sessionKey} row={r} state={rowState(r, { jobs, remote, entries, partial }, now)} resume={resume[r.sessionKey] ?? null} label={r.sessionName} />
  ));
  const progress = state && (state.kind === "job" || state.kind === "remote") && <RowDetails state={state} />;

  if (!lead) {
    return (
      <section aria-labelledby="latest-title" className="rounded-lg border border-zinc-800 bg-zinc-900/40">
        <div className="flex flex-wrap items-center gap-x-8 gap-y-3 px-5 py-4">
          <div className="min-w-0 flex-1 basis-72">
            <p className={`flex items-center gap-1.5 ${LABEL}`}>
              <span className={`h-1.5 w-1.5 rounded-full ${sessionDot(row)}`} />
              Latest race{row.round != null ? ` · Round ${row.round}` : ""} · {row.year}
            </p>
            <h2 id="latest-title" className="mt-1 truncate text-xl font-black tracking-tight text-zinc-100">
              {row.meetingName}
            </h2>
            <p className="truncate text-xs text-zinc-500">{place}</p>
          </div>
          {chips.length > 0 && <div className="flex flex-wrap items-center gap-1.5">{chips}</div>}
          {state && (
            <div className="flex flex-col items-start gap-1 sm:items-end">
              <HeroAction row={row} state={state} resumeAt={resumeAt} filled={filled} small />
              {fact && <span className="text-[11px] tabular-nums text-zinc-500">{fact}</span>}
            </div>
          )}
        </div>
        {progress && <div className="px-5 pb-4">{progress}</div>}
      </section>
    );
  }

  return (
    <section aria-labelledby="latest-title" className="rounded-xl border border-zinc-800 bg-zinc-900/60">
      <div className="grid gap-x-10 gap-y-6 p-6 md:p-10 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
        <div className="min-w-0">
          <p className={`flex items-center gap-1.5 ${LABEL}`}>
            <span className={`h-1.5 w-1.5 rounded-full ${sessionDot(row)}`} />
            Latest race · {row.year}
          </p>
          <h2 id="latest-title" className="mt-3 text-4xl font-black leading-none tracking-tight text-zinc-50 md:text-6xl">
            {row.meetingName}
          </h2>
          <p className="mt-4 text-base text-zinc-400">{place}</p>
        </div>
        {state && (
          <div className="flex flex-col items-start gap-2 lg:items-end">
            <HeroAction row={row} state={state} resumeAt={resumeAt} filled={filled} small={false} />
            {fact && <span className="text-xs tabular-nums text-zinc-500">{fact}</span>}
          </div>
        )}
      </div>
      {progress && <div className="-mt-2 px-6 pb-6 md:px-10">{progress}</div>}
      <dl className="flex flex-wrap items-center gap-x-10 gap-y-4 border-t border-zinc-800 px-6 py-4 md:px-10">
        {row.round != null && (
          <div>
            <dt className={LABEL}>Round</dt>
            <dd className="mt-0.5 text-sm tabular-nums text-zinc-200">
              {row.round}
              {rounds ? <span className="text-zinc-500"> of {rounds}</span> : null}
            </dd>
          </div>
        )}
        <div>
          <dt className={LABEL}>Lights out</dt>
          <dd className="mt-0.5 text-sm tabular-nums text-zinc-200">{sessionTime(row.dateStart)}</dd>
        </div>
        {chips.length > 0 && (
          <div className="ml-auto">
            <dt className={LABEL}>Also this weekend</dt>
            <dd className="mt-1 flex flex-wrap items-center gap-1.5">{chips}</dd>
          </div>
        )}
      </dl>
    </section>
  );
}

// ---------------------------------------------------------------- the weekend under way or close

/**
 * Live mode can be opened this long before a race or sprint starts: it waits (showing the relay's "Next live")
 * and follows the session by itself once the relay streams it, from 15 minutes before the start.
 */
const LIVE_WAIT_MS = 60 * 60_000;

/** What the live relay offers for a weekend right now: follow its session under way, or wait for the next one. */
type LiveAction = { kind: "watch" | "wait"; row: CatalogRow } | null;

function liveAction(weekend: CatalogRow[], now: number): LiveAction {
  // A static build has no relay (the header's Live control is hidden too).
  if (!LIVE_RELAY) return null;
  const next = nextSession(weekend, now);
  if (!next || !LIVE_TYPES.includes(next.sessionType)) return null;
  if (isLive(next, now)) return { kind: "watch", row: next };
  return Date.parse(next.dateStart) - now <= LIVE_WAIT_MS ? { kind: "wait", row: next } : null;
}

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

/** "3–4 Oct" for a weekend. */
function weekendDates(rows: CatalogRow[]) {
  const a = new Date(rows[0].dateStart);
  const b = new Date(rows.at(-1)!.dateStart);
  const month = (d: Date) => d.toLocaleDateString(undefined, { month: "short" });
  if (a.toDateString() === b.toDateString()) return `${a.getDate()} ${month(a)}`;
  return a.getMonth() === b.getMonth() ? `${a.getDate()}–${b.getDate()} ${month(b)}` : `${a.getDate()} ${month(a)} – ${b.getDate()} ${month(b)}`;
}

/** One session of the weekend: when, and live now / a countdown / what can be done with it once it's over (outlined). */
function SessionLine({ row, now, next }: { row: CatalogRow; now: number; next: boolean }) {
  const state = useRowState(row);
  const start = Date.parse(row.dateStart);
  const live = isLive(row, now);
  return (
    <li className="py-2">
      <div className="flex min-h-7 flex-wrap items-center gap-x-3 gap-y-1 text-sm">
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${sessionDot(row)}`} />
        <span className={`w-40 shrink-0 ${next ? "font-semibold text-zinc-100" : "text-zinc-300"}`}>{row.sessionName}</span>
        <span className="min-w-0 flex-1 truncate text-xs tabular-nums text-zinc-500">{sessionTime(row.dateStart)}</span>
        {row.cancelled ? (
          <span className="text-xs text-zinc-600 line-through">Cancelled</span>
        ) : live ? (
          <span className="flex items-center gap-1.5 text-xs font-semibold text-red-400">
            <LiveDot pulse={false} />
            Live now
          </span>
        ) : start > now ? (
          <span className="text-xs tabular-nums text-zinc-500">in {countdownShort(start - now)}</span>
        ) : (
          state && (
            <span className="flex items-center gap-2">
              <Action row={row} state={state} compact quiet />
            </span>
          )
        )}
      </div>
      {state && start <= now && !live && <RowDetails state={state} />}
    </li>
  );
}

/**
 * A race weekend under way or close, leading the page: its session live now (with Watch live when the relay
 * follows it), or a countdown to its next session, and every session with its time.
 */
function WeekendHero({ rows, action }: { rows: CatalogRow[]; action: LiveAction }) {
  const enterLive = useReplay((s) => s.enterLive);
  const coarse = useNow(30_000);
  const upcoming = nextSession(rows, coarse);
  // Seconds tick in the last hour.
  const now = useNow(upcoming && Date.parse(upcoming.dateStart) - coarse < 61 * 60_000 ? 1000 : 30_000);
  const first = rows[0];
  const next = nextSession(rows, now) ?? upcoming;
  const live = next != null && isLive(next, now);
  const started = Date.parse(first.dateStart) <= now;
  const place = [first.circuit, first.country, weekendDates(rows)].filter(Boolean).join(" · ");
  const later = "can be downloaded about 30 minutes after it ends";

  return (
    <section aria-labelledby="weekend-title" className="rounded-xl border border-zinc-800 bg-zinc-900/60">
      <div className="grid gap-x-10 gap-y-6 p-6 md:p-10 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
        <div className="min-w-0">
          <p className={`flex items-center gap-1.5 ${LABEL}`}>
            <span className={`h-1.5 w-1.5 rounded-full ${live ? "bg-red-500" : "bg-zinc-500"}`} />
            {started ? "This weekend" : "Next race"}
            {first.round != null ? ` · Round ${first.round}` : ""} · {first.year}
          </p>
          <h2 id="weekend-title" className="mt-3 text-4xl font-black leading-none tracking-tight text-zinc-50 md:text-6xl">
            {first.meetingName}
          </h2>
          <p className="mt-4 text-base text-zinc-400">{place}</p>
        </div>
        {next && (
          <div className="flex max-w-sm flex-col items-start gap-3 lg:items-end lg:text-right">
            {live ? (
              <span className="flex items-center gap-2 rounded-md bg-red-600 px-3 py-1.5 text-sm font-black uppercase tracking-wider text-white">
                <LiveDot />
                Live · {next.sessionName}
              </span>
            ) : (
              <div>
                <p className={LABEL}>{next.sessionName}</p>
                <p className="mt-1 text-4xl font-black tabular-nums tracking-tight text-zinc-50" aria-live="off">
                  in {countdownShort(Date.parse(next.dateStart) - now)}
                </p>
                <p className="mt-1 text-xs tabular-nums text-zinc-500">{sessionTime(next.dateStart)}</p>
              </div>
            )}
            {action && (
              <button
                onClick={(e) => {
                  e.currentTarget.blur();
                  enterLive();
                }}
                className={heroButton(true)}
                title={action.kind === "watch" ? `Follow the ${action.row.sessionName.toLowerCase()} live` : "Opens live mode now; it starts following the session when it goes live"}
              >
                <span className="h-2 w-2 rounded-full bg-red-600" />
                {action.kind === "watch" ? "Watch live" : `Watch the ${action.row.sessionName.toLowerCase()} live`}
              </button>
            )}
            {action?.kind === "wait" && <p className="text-[11px] text-zinc-500">Live mode waits for the start, then follows it.</p>}
            {live && !action && (
              <p className="text-[11px] text-zinc-500">
                {LIVE_RELAY ? `Live timing follows races and sprints; ${next.sessionName.toLowerCase()}` : `Live timing isn't available on this site; ${next.sessionName.toLowerCase()}`} {later}.
              </p>
            )}
          </div>
        )}
      </div>
      <ul className="divide-y divide-zinc-800/60 border-t border-zinc-800 px-6 py-2 md:px-10">
        {rows.map((r) => (
          <SessionLine key={r.sessionKey} row={r} now={now} next={r === next} />
        ))}
      </ul>
    </section>
  );
}

export function Home() {
  const years = useLibrary((s) => s.years);
  const current = useLibrary((s) => s.years[currentYear()]);
  const now = useNow(30_000);
  const featured = useMemo(() => latestRace(years, now), [years, now]);
  const season = years[currentYear()]?.catalog;
  const next = useMemo(() => (season ? nextWeekend(season.rows, now) : null), [season, now]);
  // A weekend under way or close leads instead of the latest race.
  const leading = useMemo(() => (season ? heroWeekend(season, now) : null), [season, now]);
  const action = leading ? liveAction(leading, now) : null;
  // Read once per visit to Home (it's written while watching).
  const [watched] = useState(watchHistory);
  const resume = featured && watched[featured.sessionKey];
  const featuredRows = featured ? years[featured.year]?.catalog?.rows : undefined;
  const weekend = useMemo(() => (featured ? (featuredRows ?? []).filter((r) => r.meetingKey === featured.meetingKey) : []), [featured, featuredRows]);
  const rounds = useMemo(() => Math.max(0, ...(featuredRows ?? []).map((r) => r.round ?? 0)) || null, [featuredRows]);

  useEffect(() => {
    const s = useLibrary.getState();
    void s.loadYear(currentYear());
    void s.loadYear(s.calendarYear);
    void s.refreshUsage();
    // Nobody wants a session's keyboard focus (e.g. the Races button) on Home.
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    window.scrollTo(0, 0);
  }, []);

  // Early in a season, before its first race: last season's final race.
  const noRaceYet = current?.catalog != null && !featured;
  useEffect(() => {
    if (noRaceYet && currentYear() - 1 >= FIRST_YEAR) void useLibrary.getState().loadYear(currentYear() - 1);
  }, [noRaceYet]);

  return (
    <div className="h-full overflow-y-auto">
      <header className="sticky top-0 z-20 border-b border-zinc-800 bg-zinc-950/90 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-7xl items-center gap-4 px-6">
          <h1 className="text-lg font-black tracking-tight text-zinc-100">F1 Race Replay</h1>
          <span className="hidden text-xs text-zinc-500 md:inline">Every race, sprint and qualifying since {FIRST_YEAR}, replayed from OpenF1 data</span>
          <span className="flex-1" />
          <VaultStatus />
          <LiveControl />
        </div>
        <Banners />
      </header>

      <main className="mx-auto max-w-7xl space-y-10 px-6 py-6">
        {featured || next ? (
          <div className="space-y-3">
            {leading && <WeekendHero rows={leading} action={action} />}
            {featured && (
              <LatestRace
                row={featured}
                resumeAt={resume && resume.raceTime != null && resume.raceTime > 0 ? raceClock(resume.raceTime) : null}
                weekend={weekend}
                rounds={rounds}
                lead={!leading}
                // Live mode's button is the filled one while it's on offer.
                filled={!action}
              />
            )}
            {next && !leading && <NextUp rows={next} now={now} />}
          </div>
        ) : (
          <section className="flex min-h-40 items-center rounded-xl border border-zinc-800 bg-zinc-900/40 p-6 text-sm text-zinc-500">
            {current?.error && !current.catalog ? current.error : `Loading the ${currentYear()} season from OpenF1…`}
          </section>
        )}
        <Library />
        <Calendar />
      </main>

      <footer className="mx-auto max-w-7xl border-t border-zinc-800 px-6 py-4">
        <Attribution />
      </footer>
    </div>
  );
}
