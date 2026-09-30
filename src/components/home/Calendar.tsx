// Home's season calendar (from OpenF1): one row per race weekend, each session a chip that is its own action
// (download, progress / cancel, watch, resume, update, retry).

import { useMemo, useState, type ReactNode } from "react";
import type { CatalogRow } from "../../ingest/catalog";
import { loadLearned } from "../../ingest/runner";
import { rowState, useLibrary, YEARS, type RaceFilter, type RowState } from "../../library";
import { raceClock } from "../../lib/format";
import { watchHistory } from "../../store";
import { approx, clockTime, day, SECONDARY, size, useNow } from "./common";

const FILTERS: { id: RaceFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "Race", label: "Races" },
  { id: "Qualifying", label: "Qualifying" },
];

interface Meeting {
  key: number;
  name: string;
  round: number | null;
  circuit: string;
  country: string;
  rows: CatalogRow[];
  /** Every session of the weekend was cancelled (before filtering). */
  cancelled: boolean;
}

/** Rows (in date order) grouped by meeting; meetings left without rows by the filter are dropped. */
function byMeeting(rows: CatalogRow[], filter: RaceFilter): Meeting[] {
  const meetings = new Map<number, Meeting>();
  for (const r of rows) {
    let m = meetings.get(r.meetingKey);
    if (!m) meetings.set(r.meetingKey, (m = { key: r.meetingKey, name: r.meetingName, round: r.round, circuit: r.circuit, country: r.country, rows: [], cancelled: true }));
    m.round ??= r.round;
    m.cancelled &&= r.cancelled;
    if (filter === "all" || r.sessionType === filter) m.rows.push(r);
  }
  return [...meetings.values()].filter((m) => m.rows.length);
}

/** "28 Feb – 2 Mar", "7–9 Mar". */
function dateRange(from: string, to: string) {
  const a = new Date(from);
  const b = new Date(to);
  const month = (d: Date) => d.toLocaleDateString(undefined, { month: "short" });
  if (a.toDateString() === b.toDateString()) return `${a.getDate()} ${month(a)}`;
  return a.getMonth() === b.getMonth() ? `${a.getDate()}–${b.getDate()} ${month(b)}` : `${a.getDate()} ${month(a)} – ${b.getDate()} ${month(b)}`;
}

const shortGp = (name: string) => name.replace(/ Grand Prix$/, " GP");

/** SQ / Sprint / Q / Race. */
const shortName = (r: CatalogRow) =>
  r.sessionType === "Qualifying" ? (r.sessionName === "Qualifying" ? "Q" : "SQ") : r.sessionName === "Race" ? "Race" : r.sessionName;

const fullName = (r: CatalogRow) => `${r.meetingName} ${r.sessionName}`;
const estimateText = (e: { seconds: number; mb: number }) => `${approx(e.seconds)}, ${e.mb < 10 ? e.mb.toFixed(1) : Math.round(e.mb)} MB`;

// ---------------------------------------------------------------- chips

const ICONS = {
  down: "M8 2.5v8M4.5 7 8 10.5 11.5 7M3 13.5h10",
  play: "M5 3v10l8-5z",
  x: "M4 4l8 8M12 4l-8 8",
  wait: "M8 4.5V8l2.5 1.5M14 8A6 6 0 1 1 2 8a6 6 0 0 1 12 0",
  retry: "M13 8a5 5 0 1 1-1.5-3.6M13 2.5v2.5h-2.5",
  trash: "M2.5 4h11M6 4V2.5h4V4M4 4l.7 9.5h6.6L12 4",
};

function Icon({ name }: { name: keyof typeof ICONS }) {
  const solid = name === "play";
  return (
    <svg viewBox="0 0 16 16" className="h-3 w-3 shrink-0" aria-hidden fill={solid ? "currentColor" : "none"} stroke="currentColor" strokeWidth={solid ? 0 : 1.75}>
      <path d={ICONS[name]} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

const CHIP =
  "group/chip relative inline-flex h-7 items-center justify-center gap-1 overflow-hidden whitespace-nowrap rounded-md border px-2 text-xs tabular-nums transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-zinc-300";
const width = (r: CatalogRow) => (r.sessionName === "Race" ? "min-w-[4.75rem] px-3 font-black" : r.sessionName === "Sprint" ? "min-w-[4.25rem] font-semibold" : "min-w-[3rem] font-semibold");

/** A fill behind the chip's label: download progress, or how much of a partial download is stored. */
const Fill = ({ frac, className }: { frac: number; className: string }) => (
  <span className={`absolute inset-y-0 left-0 transition-all duration-700 ${className}`} style={{ width: `${Math.round(frac * 100)}%` }} aria-hidden />
);

/** A session's own action in its current state; `label` replaces the short name (SQ / Q / Race). */
export function Chip({ row, state, resume, label = shortName(row) }: { row: CatalogRow; state: RowState; resume: string | null; label?: string }) {
  const download = useLibrary((s) => s.download);
  const reprocess = useLibrary((s) => s.reprocess);
  const cancel = useLibrary((s) => s.cancel);
  const watchNow = useLibrary((s) => s.watchNow);
  const name = fullName(row);
  const when = day(row.dateStart);
  const cls = `${CHIP} ${width(row)}`;
  const text = (children: ReactNode) => <span className="relative flex items-center gap-1">{children}</span>;

  switch (state.kind) {
    case "upcoming":
      return (
        <span className={`${cls} border-dashed border-zinc-800 text-zinc-600`} title={`${row.sessionName} · ${when}`}>
          {label}
        </span>
      );
    case "cancelled":
      return (
        <span className={`${cls} border-zinc-800/60 text-zinc-600 line-through`} title={`${row.sessionName}: cancelled`}>
          {label}
        </span>
      );
    case "ready":
      return (
        <button
          onClick={() => watchNow(row.sessionKey)}
          className={`${cls} border-zinc-400 text-zinc-100 hover:border-zinc-200 hover:bg-zinc-800 hover:text-white`}
          aria-label={resume ? `Continue ${name} at ${resume}` : `Watch ${name}`}
          title={`${resume ? `Continue at ${resume}` : "Watch"} · ${when} · ${size(state.entry.processedBytes + state.entry.rawBytes)}`}
        >
          {text(
            <>
              <Icon name="play" />
              {label}
              {resume && <span className="font-normal text-zinc-400">{resume}</span>}
            </>,
          )}
        </button>
      );
    case "stale":
      return (
        <button
          onClick={() => reprocess(state.entry)}
          className={`${cls} border-sky-500/50 text-sky-300 hover:border-sky-400 hover:text-sky-200`}
          aria-label={`Update ${name} (re-processed from the stored data, no download)`}
          title="Processed by an older version of the app: update it from the stored OpenF1 data (no download)"
        >
          {text(
            <>
              <Icon name="retry" />
              {label}
            </>,
          )}
        </button>
      );
    case "partial":
      return (
        <button
          onClick={() => download(row)}
          className={`${cls} border-zinc-600 text-zinc-200 hover:border-zinc-400 hover:text-white`}
          aria-label={`Resume downloading ${name} (${approx(state.estimate.seconds)} left)`}
          title={`Resume · ${state.cache.cachedFiles}/${state.cache.expectedFiles} files stored · ${approx(state.estimate.seconds)} left`}
        >
          <Fill frac={state.cache.cachedFiles / Math.max(1, state.cache.expectedFiles)} className="bg-zinc-700/60" />
          {text(
            <>
              <Icon name="down" />
              {label}
            </>,
          )}
        </button>
      );
    case "available":
      return (
        <button
          onClick={() => download(row)}
          className={`${cls} border-zinc-700 text-zinc-300 hover:border-zinc-500 hover:text-white`}
          aria-label={`Download ${name} (${estimateText(state.estimate)})`}
          title={`Download · ${when} · ${estimateText(state.estimate)}`}
        >
          {text(
            <>
              <Icon name="down" />
              {label}
            </>,
          )}
        </button>
      );
    case "remote": {
      const p = state.job.progress;
      return (
        <button disabled className={`${cls} cursor-default border-zinc-700 text-zinc-400`} aria-label={`${name} is downloading in another tab`} title="Downloading in another tab">
          {p && <Fill frac={p.progress} className="bg-zinc-700" />}
          {text(
            <>
              {label}
              {p && <span className="font-normal">{Math.round(p.progress * 100)}%</span>}
            </>,
          )}
        </button>
      );
    }
    case "job": {
      const { job } = state;
      if (job.phase === "failed") {
        return (
          <button
            onClick={() => download(row)}
            className={`${cls} border-red-500/60 text-red-300 hover:border-red-400 hover:text-red-200`}
            aria-label={`Retry downloading ${name}`}
            title={`Failed: ${job.error ?? "download failed"} · click to retry`}
          >
            {text(
              <>
                <Icon name="retry" />
                {label}
              </>,
            )}
          </button>
        );
      }
      const waiting = job.phase === "queued" || job.phase === "paused";
      const pct = job.progress ? Math.round(job.progress.progress * 100) : 0;
      return (
        <button
          onClick={() => cancel(row.sessionKey)}
          className={`${cls} ${waiting ? "border-amber-500/40 text-amber-300" : "border-zinc-500 text-zinc-100"} hover:border-zinc-300`}
          aria-label={waiting ? `Cancel ${job.phase} download of ${name}` : `Cancel downloading ${name} (${pct}%)`}
          title={waiting ? `${job.phase === "paused" ? "Waiting" : "Queued"} · click to cancel` : `${job.progress?.step ?? "Starting"} · click to cancel (what's downloaded is kept)`}
        >
          {!waiting && <Fill frac={pct / 100} className={`bg-zinc-600/70 ${job.progress?.phase === "processing" ? "animate-pulse" : ""}`} />}
          {text(
            <>
              <span className="group-hover/chip:hidden group-focus-visible/chip:hidden">{waiting ? <Icon name="wait" /> : null}</span>
              <span className="hidden group-hover/chip:inline group-focus-visible/chip:inline">
                <Icon name="x" />
              </span>
              {label}
              {!waiting && <span className="font-normal">{pct}%</span>}
            </>,
          )}
        </button>
      );
    }
  }
}

// ---------------------------------------------------------------- rows

/** One line of errors or waiting notices for a weekend, or null. */
function Notice({ meeting, states, now }: { meeting: Meeting; states: RowState[]; now: number }) {
  const otherTab = useLibrary((s) => s.otherTab);
  const notes: { text: string; tone: string }[] = [];
  meeting.rows.forEach((r, i) => {
    const s = states[i];
    if (s.kind !== "job") return;
    const { job } = s;
    const who = shortName(r);
    if (job.phase === "failed") notes.push({ text: `${who}: ${job.error ?? "download failed"}`, tone: "text-red-400" });
    else if (job.phase === "paused") {
      const wait = job.resumeAt != null ? Math.max(0, job.resumeAt - now) : null;
      const at = wait == null ? "" : wait > 90_000 ? ` Starts by itself at ${clockTime(job.resumeAt!)}.` : ` Starts by itself in ${Math.ceil(wait / 1000)}s.`;
      notes.push({ text: `${who}: ${job.notice ?? "Paused"}${at}`, tone: "text-amber-300" });
    } else if (job.phase === "queued" && otherTab) notes.push({ text: `${who}: another tab is downloading; this starts when it's done.`, tone: "text-zinc-400" });
    else if (job.progress?.notice) notes.push({ text: `${who}: ${job.progress.notice}`, tone: "text-amber-300" });
  });
  if (!notes.length) return null;
  return (
    <p className="mt-1 truncate text-[11px]" title={notes.map((n) => n.text).join("\n")}>
      {notes.map((n, i) => (
        <span key={i} className={n.tone}>
          {i > 0 && <span className="text-zinc-600"> · </span>}
          {n.text}
        </span>
      ))}
    </p>
  );
}

/** Stored bytes of a session that can be deleted (downloaded, or partly), else null. */
const storedBytes = (s: RowState) =>
  s.kind === "ready" || s.kind === "stale" ? s.entry.processedBytes + s.entry.rawBytes : s.kind === "partial" ? s.cache.cachedBytes : s.kind === "job" && s.job.phase === "failed" && s.cache ? s.cache.cachedBytes : null;

function WeekendRow({ meeting, states, resume, now, next = false }: { meeting: Meeting; states: RowState[]; resume: Resume; now: number; next?: boolean }) {
  const confirm = useLibrary((s) => s.confirmDelete);
  const askDelete = useLibrary((s) => s.askDelete);
  const remove = useLibrary((s) => s.remove);
  // Several sessions stored: pick which one to delete first.
  const [picking, setPicking] = useState(false);
  const first = meeting.rows[0];
  const last = meeting.rows.at(-1)!;
  const deletable = meeting.rows.flatMap((r, i) => (storedBytes(states[i]) != null ? [{ row: r, bytes: storedBytes(states[i])! }] : []));
  const confirming = deletable.find((d) => d.row.sessionKey === confirm);

  let chips: ReactNode;
  if (confirming) {
    chips = (
      <>
        <span className="whitespace-nowrap text-xs text-zinc-300">
          Delete {confirming.row.sessionName} ({size(confirming.bytes)})?
        </span>
        <button onClick={() => void remove(confirming.row.sessionKey)} className="rounded bg-red-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-red-500">
          Delete
        </button>
        <button onClick={() => askDelete(null)} className={SECONDARY}>
          Keep
        </button>
      </>
    );
  } else if (picking) {
    chips = (
      <>
        <span className="text-xs text-zinc-400">Delete which?</span>
        {deletable.map((d) => (
          <button
            key={d.row.sessionKey}
            onClick={() => {
              setPicking(false);
              askDelete(d.row.sessionKey);
            }}
            className={`${CHIP} ${width(d.row)} border-red-500/40 text-red-300 hover:border-red-400`}
            aria-label={`Delete ${fullName(d.row)} (${size(d.bytes)})`}
          >
            {shortName(d.row)}
          </button>
        ))}
        <button onClick={() => setPicking(false)} className={SECONDARY}>
          Keep
        </button>
      </>
    );
  } else {
    chips = (
      <>
        {deletable.length > 0 && (
          <button
            onClick={() => (deletable.length === 1 ? askDelete(deletable[0].row.sessionKey) : setPicking(true))}
            className="flex h-7 w-7 items-center justify-center rounded text-zinc-500 opacity-0 hover:bg-zinc-800 hover:text-zinc-100 focus-visible:outline-2 focus-visible:outline-zinc-300 group-focus-within:opacity-100 group-hover:opacity-100"
            aria-label={`Delete ${meeting.name} sessions from this browser`}
            title="Delete from this browser"
          >
            <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
              <path d={`${ICONS.trash}M6.8 6.5v4.5M9.2 6.5v4.5`} strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        )}
        {meeting.rows.map((r, i) => (
          <Chip key={r.sessionKey} row={r} state={states[i]} resume={resume[r.sessionKey] ?? null} />
        ))}
      </>
    );
  }

  return (
    <li className="group px-4 py-2 hover:bg-zinc-900/60">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
        <div className="flex min-w-0 flex-1 basis-80 items-baseline gap-3">
          <span
            className={`w-7 shrink-0 text-[11px] font-semibold tabular-nums ${next ? "text-red-400" : "text-zinc-500"}`}
            title={next ? "Next race weekend" : undefined}
          >
            {meeting.round != null ? `R${meeting.round}` : "–"}
            {next && <span className="sr-only"> (next)</span>}
          </span>
          <span className="shrink-0 text-sm font-semibold text-zinc-100">{meeting.name}</span>
          <span className="min-w-0 truncate text-xs text-zinc-500">
            {meeting.circuit}
            {meeting.country ? ` · ${meeting.country}` : ""}
          </span>
          <span className="ml-auto shrink-0 pl-2 text-xs tabular-nums text-zinc-500">{dateRange(first.dateStart, last.dateEnd)}</span>
        </div>
        <div className="ml-auto flex flex-wrap items-center justify-end gap-1.5">{chips}</div>
      </div>
      <Notice meeting={meeting} states={states} now={now} />
    </li>
  );
}

/** Race clock where each watched race was left, by session key. */
type Resume = Record<number, string>;

export function resumeClocks(): Resume {
  const out: Resume = {};
  for (const [key, w] of Object.entries(watchHistory())) if (w.raceTime != null && w.raceTime > 0) out[Number(key)] = raceClock(w.raceTime);
  return out;
}

type Item = { kind: "weekend" | "next"; meeting: Meeting; states: RowState[] } | { kind: "cancelled"; meetings: Meeting[] };

const tabClass = (on: boolean) =>
  `rounded px-2.5 py-1 text-xs font-semibold tabular-nums ${on ? "bg-zinc-800 text-zinc-50" : "text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"}`;

export function Calendar() {
  const year = useLibrary((s) => s.calendarYear);
  const setYear = useLibrary((s) => s.setCalendarYear);
  const state = useLibrary((s) => s.years[s.calendarYear]);
  const filter = useLibrary((s) => s.filter);
  const setFilter = useLibrary((s) => s.setFilter);
  const loadYear = useLibrary((s) => s.loadYear);
  const jobs = useLibrary((s) => s.jobs);
  const remote = useLibrary((s) => s.remote);
  const entries = useLibrary((s) => s.entries);
  const partial = useLibrary((s) => s.partial);
  const now = useNow(2000);
  const rows = state?.catalog?.rows;
  const meetings = useMemo(() => byMeeting(rows ?? [], filter), [rows, filter]);
  const learned = useMemo(() => loadLearned(), [jobs]);
  const types = new Set(rows?.map((r) => r.sessionType));
  // Read once per visit to Home (it's written while watching).
  const [resume] = useState(resumeClocks);

  // Newest first; of the future, only the next weekend (unless one is under way). Runs of cancelled ones collapse into one line.
  const shown: { m: Meeting; states: RowState[] | null }[] = [];
  let next: { m: Meeting; states: RowState[] } | null = null;
  for (const m of meetings) {
    const states = m.cancelled ? null : m.rows.map((r) => rowState(r, { jobs, remote, entries, partial }, now, learned));
    if (!states || states.every((s) => s.kind === "cancelled")) {
      shown.push({ m, states: null });
      continue;
    }
    if (states.every((s) => s.kind === "upcoming" || s.kind === "cancelled")) {
      if (!shown.some((x) => x.states?.some((s) => s.kind === "upcoming"))) next = { m, states };
      break;
    }
    shown.push({ m, states });
  }
  const items: Item[] = next ? [{ kind: "next", meeting: next.m, states: next.states }] : [];
  for (const { m, states } of shown.reverse()) {
    const prev = items.at(-1);
    if (states) items.push({ kind: "weekend", meeting: m, states });
    else if (prev?.kind === "cancelled") prev.meetings.push(m);
    else items.push({ kind: "cancelled", meetings: [m] });
  }

  let body;
  if (!rows) {
    body = state?.error ? (
      <div className="text-sm">
        <p className="text-red-400">{state.error}</p>
        <button onClick={() => void loadYear(year, { force: true })} className={`${SECONDARY} mt-3`}>
          Try again
        </button>
      </div>
    ) : (
      <p className="text-sm text-zinc-500">Loading the {year} calendar from OpenF1…</p>
    );
  } else if (!meetings.length) {
    body = <p className="text-sm text-zinc-500">No sessions listed for {year} yet.</p>;
  } else {
    body = (
      <>
        {state.error && <p className="mb-3 text-[11px] text-amber-300">{state.error} Showing the calendar saved earlier.</p>}
        <ul className="divide-y divide-zinc-800/70 overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900/30">
          {items.map((it, i) =>
            it.kind === "cancelled" ? (
              <li key={`c${i}`} className="truncate px-4 py-1.5 text-xs text-zinc-600">
                <span className="line-through">{it.meetings.map((m) => shortGp(m.name)).join(" · ")}</span> — cancelled
              </li>
            ) : (
              <WeekendRow key={it.meeting.key} meeting={it.meeting} states={it.states} resume={resume} now={now} next={it.kind === "next"} />
            ),
          )}
        </ul>
      </>
    );
  }

  return (
    <section aria-labelledby="calendar-title">
      <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-2">
        <h2 id="calendar-title" className="text-lg font-black tracking-tight text-zinc-100">
          Season calendar
        </h2>
        <div className="flex items-center gap-1" role="tablist" aria-label="Season">
          {[...YEARS].reverse().map((y) => (
            <button key={y} role="tab" onClick={() => setYear(y)} aria-selected={y === year} className={tabClass(y === year)}>
              {y}
            </button>
          ))}
        </div>
        <span className="flex-1" />
        {types.size > 1 && (
          <div className="flex items-center gap-1 rounded-md border border-zinc-800 p-0.5">
            {FILTERS.map((f) => (
              <button
                key={f.id}
                onClick={() => setFilter(f.id)}
                aria-pressed={f.id === filter}
                className={`rounded px-2 py-0.5 text-[11px] font-semibold ${f.id === filter ? "bg-zinc-700 text-zinc-100" : "text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"}`}
              >
                {f.label}
              </button>
            ))}
          </div>
        )}
      </div>
      {body}
    </section>
  );
}
