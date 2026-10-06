// Home's season sheet (from OpenF1): one row per race weekend, newest first, with the next weekend on top. Each
// session has its column (FP1 · FP2 · FP3 · SQ · Sprint · Quali · Race, so a season lines up), and each cell is that
// session's own action in its state: watch (downloading it as it plays when it isn't here), resume, its download,
// update, retry. On a phone the sheet is a stack instead: one card per weekend with its sessions as a wrapping row of
// chips, nothing scrolling sideways.

import { useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { isFollowedLive } from "../../../scripts/lib/season";
import { isLive, type CatalogRow } from "../../ingest/catalog";
import { liveVia } from "../../live/client";
import { usePhone } from "../../hooks/usePhone";
import { useReplay } from "../../store";
import { loadLearned } from "../../ingest/runner";
import { rowState, useLibrary, YEARS, type RaceFilter, type RowState } from "../../library";
import { LiveDot } from "../LiveControl";
import { resumeClocks } from "./resume";
import { approx, clockTime, dateRange, dayTime, DANGER, day, FOCUS, Glyph, LABEL, SECONDARY, sessionTime, shortGp, size, storedBytes, useDownloadBlock, useNow, waitText } from "./common";

const FILTERS: { id: RaceFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "Race", label: "Races" },
  { id: "Qualifying", label: "Qualifying" },
  { id: "Practice", label: "Practice" },
];

interface Column {
  id: string;
  label: string;
  title: string;
  match: (r: CatalogRow) => boolean;
}

const SQ: Column = { id: "sq", label: "SQ", title: "Sprint qualifying (Sprint Shootout in 2023)", match: (r) => r.sessionType === "Qualifying" && r.sessionName !== "Qualifying" };
const SPRINT: Column = { id: "sprint", label: "Sprint", title: "Sprint", match: (r) => r.sessionName === "Sprint" };
const QUALI: Column = { id: "quali", label: "Quali", title: "Qualifying", match: (r) => r.sessionName === "Qualifying" };
const RACE: Column = { id: "race", label: "Race", title: "Race", match: (r) => r.sessionName === "Race" };
const fp = (n: number): Column => ({ id: `fp${n}`, label: `FP${n}`, title: `Free practice ${n}`, match: (r) => r.sessionName === `Practice ${n}` });
const [FP1, FP2, FP3] = [fp(1), fp(2), fp(3)];
const COLUMNS: Record<RaceFilter, Column[]> = {
  all: [FP1, FP2, FP3, SQ, SPRINT, QUALI, RACE],
  Race: [SPRINT, RACE],
  Qualifying: [SQ, QUALI],
  Practice: [FP1, FP2, FP3],
};

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

const fullName = (r: CatalogRow) => `${r.year} ${r.meetingName} ${r.sessionName}`;

// ---------------------------------------------------------------- cells

const CELL_BASE = `relative flex items-center gap-1.5 overflow-hidden whitespace-nowrap rounded-md text-xs tabular-nums transition-colors ${FOCUS}`;
/** A sheet's cell: a fixed-height box filling its column (taller on touch screens, for the finger). */
const CELL = `${CELL_BASE} h-8 w-full px-2 pointer-coarse:h-11`;
/** A phone's chip: sized to its words, a hairline round it so the quiet states still read as buttons, 44 px tall. */
const CHIP = `${CELL_BASE} h-11 border border-zinc-800 px-3`;
/** Words shown on hover or focus only (a sheet of the same word says nothing); touch has neither, so there they stay. */
const REVEAL = "opacity-0 transition-opacity group-hover/cell:opacity-100 group-focus-visible/cell:opacity-100 pointer-coarse:opacity-100";

/** A fill behind the cell's label: download progress, or how much of a partial download is stored. */
const Fill = ({ frac, className }: { frac: number; className: string }) => (
  <span className={`absolute inset-0 origin-left transition-transform duration-700 ease-out ${className}`} style={{ transform: `scaleX(${Math.min(1, Math.max(0, frac))})` }} aria-hidden />
);

const Label = ({ children }: { children: ReactNode }) => <span className="relative flex min-w-0 items-center gap-1.5">{children}</span>;

/**
 * A session's own action in its current state. Stored sessions are filled cells; the rest are quiet. `compact`: the
 * narrow cells of a sheet with every session, where a resume point is just its clock after the play mark. `chip`: a
 * phone's chip, which has no column header over it, so it carries the session's label (FP1, Quali, Race) itself.
 */
function Cell({
  row,
  state,
  resume,
  now,
  waitUntil,
  compact,
  chip,
}: {
  row: CatalogRow;
  state: RowState;
  resume: string | null;
  now: number;
  waitUntil: number | null;
  compact: boolean;
  chip?: string;
}) {
  const resumeLabel = resume ? (compact ? resume : `Resume ${resume}`) : "Watch";
  const stream = useLibrary((s) => s.stream);
  const reprocess = useLibrary((s) => s.reprocess);
  const watchNow = useLibrary((s) => s.watchNow);
  const name = fullName(row);
  const when = day(row.dateStart);
  const base = chip ? CHIP : CELL;
  const tag = chip ? <span className="font-semibold text-zinc-300">{chip}</span> : null;

  if (waitUntil != null && (state.kind === "available" || state.kind === "partial")) {
    return (
      <button
        onClick={() => stream(row)}
        className={`group/cell ${base} text-amber-300 hover:bg-zinc-800`}
        aria-label={`Watch ${name} (downloads wait until about ${clockTime(waitUntil)})`}
        title={waitText(waitUntil)}
      >
        {/* Quiet like a Watch cell (the live row says when downloads resume); the time on hover or focus. */}
        <Label>
          {tag}
          <Glyph name="wait" />
          <span className={REVEAL}>{clockTime(waitUntil)}</span>
        </Label>
      </button>
    );
  }

  switch (state.kind) {
    case "upcoming":
      if (isLive(row, now)) {
        // Live mode follows it (when this site can follow anything live): the cell takes you there.
        const followed = liveVia() != null && isFollowedLive({ session_type: row.sessionType, session_name: row.sessionName });
        return followed ? (
          <button
            onClick={(e) => {
              e.currentTarget.blur();
              useReplay.getState().enterLive();
            }}
            className={`${base} font-semibold text-red-400 hover:bg-zinc-800 hover:text-red-300`}
            aria-label={`Follow ${name} live`}
            title={`${row.sessionName} is live: follow it in live mode (downloadable about 30 minutes after it ends)`}
          >
            {tag}
            <LiveDot pulse={false} />
            Live
          </button>
        ) : (
          <span className={`${base} font-semibold text-red-400`} title={`${row.sessionName} is live: it can be downloaded about 30 minutes after it ends`}>
            {tag}
            <LiveDot pulse={false} />
            Live
          </span>
        );
      }
      return (
        <span className={`${base} text-zinc-400`} title={`${row.sessionName}: ${sessionTime(row.dateStart)}`}>
          {tag ?? <span className="sr-only">{row.sessionName}: </span>}
          {dayTime(row.dateStart)}
        </span>
      );
    case "cancelled":
      return (
        <span className={`${base} text-zinc-400`} title={`${row.sessionName}: cancelled`}>
          {tag}
          <span className="line-through">Cancelled</span>
        </span>
      );
    case "ready":
      return (
        <button
          onClick={() => watchNow(row.sessionKey)}
          className={`${base} bg-zinc-800 font-semibold text-zinc-50 hover:bg-zinc-700`}
          aria-label={resume ? `Resume ${name} at ${resume}` : `Watch ${name} (stored)`}
          title={`${resume ? `Resume at ${resume}` : "Watch"} · ${when} · stored, ${size(state.entry.processedBytes + state.entry.rawBytes)}`}
        >
          <Label>
            {tag}
            <Glyph name="play" />
            {resumeLabel}
          </Label>
        </button>
      );
    case "stale":
      return (
        <button
          onClick={() => reprocess(state.entry)}
          className={`${base} bg-zinc-800 font-semibold text-amber-300 hover:bg-zinc-700`}
          aria-label={`Update ${name} (re-processed from the stored data, no download)`}
          title="Processed by an older version of the app: update it from the stored OpenF1 data (no download)"
        >
          <Label>
            {tag}
            <Glyph name="retry" />
            Update
          </Label>
        </button>
      );
    case "partial":
      return (
        <button
          onClick={() => stream(row)}
          className={`${base} text-zinc-100 hover:bg-zinc-800`}
          aria-label={resume ? `Resume ${name} at ${resume}` : `Watch ${name}`}
          title={`Watch · part stored, the rest comes as you watch (${approx(state.estimate.seconds)} left)`}
        >
          <Fill frac={state.cache.cachedFiles / Math.max(1, state.cache.expectedFiles)} className="bg-zinc-800" />
          <Label>
            {tag}
            <Glyph name="play" />
            {resumeLabel}
          </Label>
        </button>
      );
    case "available":
      return (
        <button
          onClick={() => stream(row)}
          className={`group/cell ${base} text-zinc-400 hover:bg-zinc-800 hover:text-zinc-50 focus-visible:text-zinc-50`}
          aria-label={`Watch ${name}`}
          title={`Watch · ${when} · plays in seconds, downloads as you watch (${approx(state.estimate.seconds)}, ~${Math.round(state.estimate.mb)} MB)`}
        >
          {/* At rest just the play mark: a sheet of the same word says nothing. What changed (stored, a resume point,
              a download) carries the ink. */}
          <Label>
            {tag}
            <Glyph name="playOutline" />
            {/* A chip's label and play mark already say it. */}
            {!chip && <span className={REVEAL}>Watch</span>}
          </Label>
        </button>
      );
    case "remote": {
      const p = state.job.progress;
      return (
        <button disabled className={`${base} cursor-default text-zinc-300`} aria-label={`${name} is downloading in another tab`} title="Downloading in another tab">
          {p && <Fill frac={p.progress} className="bg-zinc-800" />}
          <Label>
            {tag}
            {p ? `${Math.round(p.progress * 100)}%` : "Other tab"}
          </Label>
        </button>
      );
    }
    case "job": {
      const { job } = state;
      if (job.phase === "failed") {
        return (
          <button
            onClick={() => stream(row)}
            className={`${base} text-red-400 hover:bg-zinc-800 hover:text-red-300`}
            aria-label={`Retry ${name}`}
            title={`Failed: ${job.error ?? "download failed"} · watch it (the download carries on from what's stored)`}
          >
            <Label>
              {tag}
              <Glyph name="retry" />
              Retry
            </Label>
          </button>
        );
      }
      const waiting = job.phase === "queued" || job.phase === "paused";
      const pct = job.progress ? Math.round(job.progress.progress * 100) : 0;
      return (
        <button
          onClick={() => (job.info.mode === "download" ? stream(row) : watchNow(row.sessionKey))}
          className={`${base} hover:bg-zinc-800 ${waiting ? "text-amber-300" : "text-zinc-50"}`}
          aria-label={`Watch ${name} (${waiting ? (job.phase === "paused" ? "waiting" : "queued") : `${pct}% downloaded`})`}
          title={waiting ? `${job.phase === "paused" ? "Waiting" : "Queued"} · click to watch it now` : "Downloading · click to watch it while it downloads"}
        >
          {!waiting && <Fill frac={pct / 100} className={`bg-zinc-700 ${job.progress?.phase === "processing" ? "animate-pulse" : ""}`} />}
          <Label>
            {tag}
            <Glyph name={waiting ? "wait" : "play"} />
            {waiting ? (job.phase === "paused" ? "Waiting" : "Queued") : `${pct}%`}
          </Label>
        </button>
      );
    }
  }
}

// ---------------------------------------------------------------- rows

/** One line of errors or waiting notices for a weekend, or null. `wrap`: on a phone, as many lines as it takes (no hover for the rest). */
function Notice({ meeting, states, now, wrap = false }: { meeting: Meeting; states: RowState[]; now: number; wrap?: boolean }) {
  const otherTab = useLibrary((s) => s.otherTab);
  const notes: { text: string; tone: string }[] = [];
  meeting.rows.forEach((r, i) => {
    const s = states[i];
    if (s.kind !== "job") return;
    const { job } = s;
    const who = r.sessionName;
    if (job.phase === "failed") notes.push({ text: `${who}: ${job.error ?? "download failed"}`, tone: "text-red-400" });
    else if (job.phase === "paused") {
      const wait = job.resumeAt != null ? Math.max(0, job.resumeAt - now) : null;
      const at = wait == null ? "" : wait > 90_000 ? ` Starts by itself at ${clockTime(job.resumeAt!)}.` : ` Starts by itself in ${Math.ceil(wait / 1000)}s.`;
      notes.push({ text: `${who}: ${job.notice ?? "Paused"}${at}`, tone: "text-amber-300" });
    } else if (job.phase === "queued" && otherTab) notes.push({ text: `${who}: another tab is downloading; this starts when it's done.`, tone: "text-zinc-300" });
    else if (job.progress?.notice) notes.push({ text: `${who}: ${job.progress.notice}`, tone: "text-amber-300" });
  });
  if (!notes.length) return null;
  return (
    <p className={wrap ? "pb-1 pt-2 text-xs" : "truncate pb-2 pl-11 text-xs"} title={wrap ? undefined : notes.map((n) => n.text).join("\n")}>
      {notes.map((n, i) => (
        <span key={i} className={n.tone}>
          {i > 0 && <span className="text-zinc-500"> · </span>}
          {n.text}
        </span>
      ))}
    </p>
  );
}

/**
 * The sheet's columns, by the width it has (a container query): round and Grand Prix, circuit, dates, one per
 * session (`--cells` of them), delete. Narrower, it drops the circuit, then the dates; narrower still it scrolls
 * sideways with the round and Grand Prix pinned. Every session at once (seven) takes narrower cells, so the circuit
 * and dates come in later: the breakpoints are where each column fits (with the row's padding).
 */
interface Sheet {
  grid: string;
  circuit: string;
  dates: string;
  /** Below this the sheet scrolls sideways. */
  min: string;
  scroll: string;
  compact: boolean;
}
const SHEET: Sheet = {
  grid: "grid items-center gap-x-2 grid-cols-[minmax(10rem,1fr)_repeat(var(--cells),8.25rem)_2rem] @[56rem]:grid-cols-[minmax(10rem,1fr)_7rem_repeat(var(--cells),8.25rem)_2rem] @[66rem]:grid-cols-[minmax(0,13rem)_minmax(0,1fr)_7rem_repeat(var(--cells),8.25rem)_2rem]",
  circuit: "hidden @[66rem]:block",
  dates: "hidden @[56rem]:block",
  min: "min-w-[48rem]",
  scroll: "overflow-x-auto @[48rem]:overflow-visible",
  compact: false,
};
const WIDE_SHEET: Sheet = {
  grid: "grid items-center gap-x-2 grid-cols-[minmax(10rem,1fr)_repeat(var(--cells),6.25rem)_2rem] @[68.75rem]:grid-cols-[minmax(10rem,1fr)_7rem_repeat(var(--cells),6.25rem)_2rem] @[80rem]:grid-cols-[minmax(0,13rem)_minmax(0,1fr)_7rem_repeat(var(--cells),6.25rem)_2rem]",
  circuit: "hidden @[80rem]:block",
  dates: "hidden @[68.75rem]:block",
  min: "min-w-[61.5rem]",
  scroll: "overflow-x-auto @[61.5rem]:overflow-visible",
  compact: true,
};
const sheetOf = (columns: Column[]) => (columns.length > 4 ? WIDE_SHEET : SHEET);
const cellsOf = (columns: Column[]) => ({ "--cells": columns.length }) as CSSProperties;
/** The round and Grand Prix's "Next" mark. */
const NEXT_BADGE = "shrink-0 rounded bg-zinc-800 px-1.5 py-px text-[11px] font-semibold uppercase tracking-wider text-zinc-200";

/** Round and Grand Prix: pinned when the sheet scrolls sideways (its ground follows the row's). */
const PINNED = "sticky left-0 z-[1] flex min-w-0 items-center gap-2 bg-zinc-950 group-hover:bg-zinc-900";

function WeekendRow({
  meeting,
  states,
  columns,
  resume,
  now,
  waitUntil,
  next = false,
}: {
  meeting: Meeting;
  states: RowState[];
  columns: Column[];
  resume: Resume;
  now: number;
  waitUntil: number | null;
  next?: boolean;
}) {
  const confirm = useLibrary((s) => s.confirmDelete);
  const askDelete = useLibrary((s) => s.askDelete);
  const remove = useLibrary((s) => s.remove);
  // Several sessions stored: pick which one to delete first.
  const [picking, setPicking] = useState(false);
  const first = meeting.rows[0];
  const last = meeting.rows.at(-1)!;
  const deletable = meeting.rows.flatMap((r, i) => (storedBytes(states[i]) != null ? [{ row: r, bytes: storedBytes(states[i])! }] : []));
  const confirming = deletable.find((d) => d.row.sessionKey === confirm);
  const span = { gridColumn: `span ${columns.length + 1} / -1` };
  const sheet = sheetOf(columns);

  let cells: ReactNode;
  if (confirming) {
    cells = (
      <div className="flex items-center justify-end gap-1.5" style={span}>
        <span className="whitespace-nowrap text-xs text-zinc-200">
          Delete {confirming.row.sessionName} ({size(confirming.bytes)})?
        </span>
        <button onClick={() => void remove(confirming.row.sessionKey)} className={DANGER}>
          Delete
        </button>
        <button onClick={() => askDelete(null)} className={SECONDARY}>
          Keep
        </button>
      </div>
    );
  } else if (picking) {
    cells = (
      <div className="flex items-center justify-end gap-1.5" style={span}>
        <span className="text-xs text-zinc-300">Delete which?</span>
        {deletable.map((d) => (
          <button
            key={d.row.sessionKey}
            onClick={() => {
              setPicking(false);
              askDelete(d.row.sessionKey);
            }}
            className={`${SECONDARY} text-red-300`}
            aria-label={`Delete ${fullName(d.row)} (${size(d.bytes)})`}
          >
            {d.row.sessionName}
          </button>
        ))}
        <button onClick={() => setPicking(false)} className={SECONDARY}>
          Keep
        </button>
      </div>
    );
  } else {
    cells = (
      <>
        {columns.map((c) => {
          const i = meeting.rows.findIndex(c.match);
          return (
            <div key={c.id}>
              {i >= 0 && (
                <Cell row={meeting.rows[i]} state={states[i]} resume={resume[meeting.rows[i].sessionKey] ?? null} now={now} waitUntil={waitUntil} compact={sheet.compact} />
              )}
            </div>
          );
        })}
        <div className="flex justify-end">
          {deletable.length > 0 && (
            <button
              onClick={() => (deletable.length === 1 ? askDelete(deletable[0].row.sessionKey) : setPicking(true))}
              className={`flex h-7 w-7 items-center justify-center rounded-md text-zinc-400 opacity-0 hover:bg-zinc-800 hover:text-zinc-100 focus-visible:opacity-100 group-hover:opacity-100 pointer-coarse:h-11 pointer-coarse:w-11 pointer-coarse:opacity-100 ${FOCUS}`}
              aria-label={`Delete ${meeting.name} sessions from this browser`}
              title="Delete from this browser"
            >
              <Glyph name="trash" className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </>
    );
  }

  return (
    <li className="group border-b border-zinc-800/70 px-3 hover:bg-zinc-900">
      <div className={`${sheet.grid} min-h-11 py-1`} style={cellsOf(columns)}>
        <span className={PINNED}>
          <span className="w-9 shrink-0 text-xs font-semibold tabular-nums text-zinc-400">{meeting.round != null ? `R${meeting.round}` : "–"}</span>
          <span className="truncate text-sm font-semibold text-zinc-50">{shortGp(meeting.name)}</span>
          {next && <span className={NEXT_BADGE}>Next</span>}
        </span>
        <span className={`${sheet.circuit} min-w-0 truncate text-xs text-zinc-400`}>
          {meeting.circuit}
          {meeting.country ? ` · ${meeting.country}` : ""}
        </span>
        <span className={`${sheet.dates} text-xs tabular-nums text-zinc-400`}>{dateRange(first.dateStart, last.dateEnd)}</span>
        {cells}
      </div>
      <Notice meeting={meeting} states={states} now={now} />
    </li>
  );
}

/**
 * A weekend on a phone: a card with the round, Grand Prix and dates, the circuit under them, and the sessions as a
 * wrapping row of 44 px chips (each named, as there is no column header), the delete button among them. Deleting
 * asks in place of the chips, as the sheet does in place of its cells.
 */
function PhoneWeekend({
  meeting,
  states,
  columns,
  resume,
  now,
  waitUntil,
  next = false,
}: {
  meeting: Meeting;
  states: RowState[];
  columns: Column[];
  resume: Resume;
  now: number;
  waitUntil: number | null;
  next?: boolean;
}) {
  const confirm = useLibrary((s) => s.confirmDelete);
  const askDelete = useLibrary((s) => s.askDelete);
  const remove = useLibrary((s) => s.remove);
  const [picking, setPicking] = useState(false);
  const first = meeting.rows[0];
  const last = meeting.rows.at(-1)!;
  const deletable = meeting.rows.flatMap((r, i) => (storedBytes(states[i]) != null ? [{ row: r, bytes: storedBytes(states[i])! }] : []));
  const confirming = deletable.find((d) => d.row.sessionKey === confirm);
  const tall = "min-h-11 px-3";

  let chips: ReactNode;
  if (confirming) {
    chips = (
      <>
        <span className="text-xs text-zinc-200">
          Delete {confirming.row.sessionName} ({size(confirming.bytes)})?
        </span>
        <button onClick={() => void remove(confirming.row.sessionKey)} className={`${DANGER} ${tall}`}>
          Delete
        </button>
        <button onClick={() => askDelete(null)} className={`${SECONDARY} ${tall}`}>
          Keep
        </button>
      </>
    );
  } else if (picking) {
    chips = (
      <>
        <span className="text-xs text-zinc-300">Delete which?</span>
        {deletable.map((d) => (
          <button
            key={d.row.sessionKey}
            onClick={() => {
              setPicking(false);
              askDelete(d.row.sessionKey);
            }}
            className={`${SECONDARY} ${tall} text-red-300`}
            aria-label={`Delete ${fullName(d.row)} (${size(d.bytes)})`}
          >
            {d.row.sessionName}
          </button>
        ))}
        <button onClick={() => setPicking(false)} className={`${SECONDARY} ${tall}`}>
          Keep
        </button>
      </>
    );
  } else {
    chips = (
      <>
        {columns.map((c) => {
          const i = meeting.rows.findIndex(c.match);
          return (
            i >= 0 && (
              <Cell key={c.id} row={meeting.rows[i]} state={states[i]} resume={resume[meeting.rows[i].sessionKey] ?? null} now={now} waitUntil={waitUntil} compact={false} chip={c.label} />
            )
          );
        })}
        {deletable.length > 0 && (
          <button
            onClick={() => (deletable.length === 1 ? askDelete(deletable[0].row.sessionKey) : setPicking(true))}
            className={`flex h-11 w-11 items-center justify-center rounded-md text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 ${FOCUS}`}
            aria-label={`Delete ${meeting.name} sessions from this browser`}
            title="Delete from this browser"
          >
            <Glyph name="trash" className="h-3.5 w-3.5" />
          </button>
        )}
      </>
    );
  }

  return (
    <li className="border-b border-zinc-800/70 py-3">
      <div className="flex items-baseline gap-2">
        <span className="shrink-0 text-xs font-semibold tabular-nums text-zinc-400">{meeting.round != null ? `R${meeting.round}` : "–"}</span>
        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-zinc-50">{shortGp(meeting.name)}</span>
        {next && <span className={NEXT_BADGE}>Next</span>}
        <span className="shrink-0 text-xs tabular-nums text-zinc-400">{dateRange(first.dateStart, last.dateEnd)}</span>
      </div>
      {(meeting.circuit || meeting.country) && (
        <p className="mt-0.5 truncate text-xs text-zinc-400">
          {meeting.circuit}
          {meeting.circuit && meeting.country ? " · " : ""}
          {meeting.country}
        </p>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-1.5">{chips}</div>
      <Notice meeting={meeting} states={states} now={now} wrap />
    </li>
  );
}

/** Race clock where each watched race was left, by session key. */
type Resume = Record<number, string>;

type Item = { kind: "weekend" | "next"; meeting: Meeting; states: RowState[] } | { kind: "cancelled"; meetings: Meeting[] };

/** A row of pressed/unpressed buttons (the replay screen's segmented control). */
function Segmented<T extends string | number>({ label, value, options, onChange }: { label: string; value: T; options: { id: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="flex rounded-md bg-zinc-900 p-0.5" role="group" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.id}
          onClick={() => onChange(o.id)}
          aria-pressed={o.id === value}
          className={`rounded px-2.5 py-1 text-xs font-semibold tabular-nums pointer-coarse:min-h-10 pointer-coarse:px-3 ${FOCUS} ${o.id === value ? "bg-zinc-700 text-zinc-50" : "text-zinc-300 hover:text-zinc-50"}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Season() {
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
  const columns = COLUMNS[filter];
  const sheet = sheetOf(columns);
  // Read once per visit to Home (it's written while watching).
  const [resume] = useState(resumeClocks);
  const waitUntil = useDownloadBlock();
  const phone = usePhone();

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
      <div className="border-y border-zinc-800 px-3 py-4 text-sm">
        <p className="text-red-400">{state.error}</p>
        <button onClick={() => void loadYear(year, { force: true })} className={`${SECONDARY} mt-3`}>
          Try again
        </button>
      </div>
    ) : (
      <p className="border-y border-zinc-800 px-3 py-4 text-sm text-zinc-400">Loading the {year} season from OpenF1…</p>
    );
  } else if (!meetings.length) {
    body = <p className="border-y border-zinc-800 px-3 py-4 text-sm text-zinc-400">No sessions listed for {year} yet.</p>;
  } else if (phone) {
    body = (
      <>
        {state.error && <p className="mb-2 text-xs text-amber-300">{state.error} Showing the season saved earlier.</p>}
        <ul aria-label={`${year} season`} className="border-t border-zinc-800">
          {items.map((it, i) =>
            it.kind === "cancelled" ? (
              <li key={`c${i}`} className="border-b border-zinc-800/70 py-3 text-xs text-zinc-400">
                <span className="line-through">{it.meetings.map((m) => shortGp(m.name)).join(" · ")}</span> cancelled
              </li>
            ) : (
              <PhoneWeekend
                key={it.meeting.key}
                meeting={it.meeting}
                states={it.states}
                columns={columns}
                resume={resume}
                now={now}
                waitUntil={waitUntil}
                next={it.kind === "next"}
              />
            ),
          )}
        </ul>
      </>
    );
  } else {
    body = (
      <>
        {state.error && <p className="mb-2 px-3 text-xs text-amber-300">{state.error} Showing the season saved earlier.</p>}
        <div className="@container">
          {/* Sideways scrolling only when the sheet is too narrow; otherwise nothing clips, so the column header can
              stay under the page header while the season scrolls. */}
          <div className={sheet.scroll}>
            <div className={sheet.min}>
              <div
                className={`${LABEL} ${sheet.grid} sticky top-[53px] z-10 whitespace-nowrap border-b border-zinc-800 bg-zinc-950 px-3 pb-2 pt-2`}
                style={cellsOf(columns)}
                aria-hidden
              >
                <span className="sticky left-0 z-[1] flex gap-2 bg-zinc-950">
                  <span className="w-9 shrink-0">Rd</span>
                  Grand Prix
                </span>
                <span className={sheet.circuit}>Circuit</span>
                <span className={sheet.dates}>Dates</span>
                {columns.map((c) => (
                  <span key={c.id} className="px-2" title={c.title}>
                    {c.label}
                  </span>
                ))}
                <span />
              </div>
              <ul aria-label={`${year} season`}>
                {items.map((it, i) =>
                  it.kind === "cancelled" ? (
                    <li key={`c${i}`} className="truncate border-b border-zinc-800/70 py-2 pl-14 pr-3 text-xs text-zinc-400">
                      <span className="line-through">{it.meetings.map((m) => shortGp(m.name)).join(" · ")}</span> cancelled
                    </li>
                  ) : (
                    <WeekendRow
                      key={it.meeting.key}
                      meeting={it.meeting}
                      states={it.states}
                      columns={columns}
                      resume={resume}
                      now={now}
                      waitUntil={waitUntil}
                      next={it.kind === "next"}
                    />
                  ),
                )}
              </ul>
            </div>
          </div>
        </div>
      </>
    );
  }

  return (
    <section aria-labelledby="season-title" className="mt-12">
      <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-2">
        <h2 id="season-title" className="text-2xl font-bold tracking-tight text-zinc-50">
          Season
        </h2>
        <Segmented label="Year" value={year} options={[...YEARS].reverse().map((y) => ({ id: y, label: String(y) }))} onChange={setYear} />
        <span className="flex-1" />
        <Segmented label="Sessions" value={filter} options={FILTERS} onChange={setFilter} />
      </div>
      {body}
    </section>
  );
}
