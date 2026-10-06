// One session as a timing row, as on the replay screen's timing tower: season and round, Grand Prix, session, day,
// what's stored or downloading, its size, and its actions. Home's Continue list and the jump results use it; the
// season sheet has rows per weekend instead.

import type { ReactNode } from "react";
import { isLive, type CatalogRow } from "../../ingest/catalog";
import { isActive, useLibrary, type RowState } from "../../library";
import { useReplay } from "../../store";
import { approx, clockTime, DANGER, day, Glyph, LABEL, left, mb, openAction, PRIMARY, RowDetails, SECONDARY, shortGp, size, storedBytes, TrashButton, useNow, waitText } from "./common";

/**
 * Every row's columns, the column headers' too, by the width the list has (a container query, so a narrow window
 * drops Size and Status, then Date, then Season and Session, and the action always fits): Season · Grand Prix ·
 * Session · Date · Status · Size · actions. Narrowest (a phone), the actions take only the width they need, so the
 * Grand Prix keeps what's left, and the status and size go under the name.
 */
export const ROW_GRID =
  "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 @[40rem]:grid-cols-[4.75rem_minmax(0,1fr)_8.5rem_12.5rem] @[52rem]:grid-cols-[4.75rem_minmax(0,1fr)_8.5rem_6.5rem_12.5rem] @[66rem]:grid-cols-[4.75rem_minmax(0,1fr)_8.5rem_6.5rem_minmax(0,10rem)_4.5rem_12.5rem]";
/** Columns that only show once the list is this wide. */
const AT_40 = "hidden @[40rem]:block";
const AT_52 = "hidden @[52rem]:block";
const AT_66 = "hidden @[66rem]:block";
/** Buttons: taller for a finger (BUTTON's py-1 is for the mouse), the same on a desktop. */
const TOUCH = "pointer-coarse:min-h-11 pointer-coarse:px-3.5";

/**
 * What's stored, downloading or wrong, in a few words (the size has its own column). `waitUntil`: OpenF1 blocks this
 * browser's downloads until then, so what isn't stored waits.
 */
function status(row: CatalogRow, state: RowState, waitUntil: number | null, now: number): { text: string; tone?: string; title?: string } {
  if (waitUntil != null && (state.kind === "available" || state.kind === "partial")) {
    return { text: `Waits until ${clockTime(waitUntil)}`, tone: "text-amber-300", title: waitText(waitUntil) };
  }
  if (state.kind === "upcoming" && isLive(row, now)) return { text: "Live", tone: "font-semibold text-red-400", title: "Live now: it can be downloaded about 30 minutes after it ends" };
  switch (state.kind) {
    case "ready":
      return { text: "Stored", title: "In this browser: plays offline" };
    case "stale":
      return { text: "Needs an update", tone: "text-amber-300", title: "Processed by an older version of the app: Update re-processes it from the stored OpenF1 data (no download)" };
    case "available":
      return { text: "Plays in seconds", title: `Downloads into this browser as you watch (${approx(state.estimate.seconds)} for all of it)` };
    case "partial":
      return { text: `Part stored · ${approx(state.estimate.seconds)} left`, title: "The rest downloads as you watch" };
    case "remote": {
      const p = state.job.progress;
      return { text: p ? `${Math.round(p.progress * 100)}% · other tab` : "In another tab", title: "Downloading in another tab" };
    }
    case "job": {
      const { job } = state;
      if (job.phase === "failed") return { text: "Download failed", tone: "text-red-400", title: job.error ?? undefined };
      if (job.phase === "queued") return { text: "Queued" };
      if (job.phase === "paused") return { text: "Waiting", tone: "text-amber-300", title: job.notice ?? undefined };
      const p = job.progress;
      return { text: p ? `${Math.round(p.progress * 100)}% · ${left(p.etaSeconds)}` : job.info.mode === "reprocess" ? "Updating…" : "Starting…" };
    }
    case "upcoming":
      return { text: "Not run yet" };
    case "cancelled":
      return { text: "Cancelled" };
  }
}

/** The size column: what's stored, or about what the download is. */
function sizeText(state: RowState): string | null {
  const stored = storedBytes(state);
  if (stored != null) return size(stored);
  if (state.kind === "available") return `~${mb(state.estimate.mb * 1e6)} MB`;
  if (state.kind === "job" && state.job.progress && state.job.progress.totalBytes > 0) return `~${mb(state.job.progress.totalBytes)} MB`;
  return null;
}

/** The session's one action, named for what it does: Resume 48:52, Watch, Update, Retry. */
export function actionLabel(state: RowState, resume: string | null, loaded: boolean): string {
  if (state.kind === "stale") return "Update";
  if (state.kind === "job" && state.job.phase === "failed") return "Retry";
  if (resume) return `Resume ${resume}`;
  return loaded ? "Resume" : "Watch";
}

function RowActions({ row, state, resume, lead, option }: { row: CatalogRow; state: RowState; resume: string | null; lead: boolean; option: boolean }) {
  const confirming = useLibrary((s) => s.confirmDelete === row.sessionKey);
  const askDelete = useLibrary((s) => s.askDelete);
  const remove = useLibrary((s) => s.remove);
  const cancel = useLibrary((s) => s.cancel);
  // Left for Home: Resume picks it up where it was.
  const loaded = useReplay((s) => s.mode === "replay" && (s.session?.meta.sessionKey === row.sessionKey || s.stream?.key === row.sessionKey));
  const open = openAction(row, state);
  const stored = storedBytes(state);
  const name = `${row.year} ${row.meetingName} ${row.sessionName}`;

  if (confirming) {
    return (
      <div className="flex items-center justify-end gap-1.5">
        <span className="whitespace-nowrap text-xs text-zinc-200">Delete{stored ? ` ${size(stored)}` : ""}?</span>
        <button onClick={() => void remove(row.sessionKey)} className={`${DANGER} ${TOUCH}`}>
          Delete
        </button>
        <button onClick={() => askDelete(null)} className={`${SECONDARY} ${TOUCH}`}>
          Keep
        </button>
      </div>
    );
  }
  const label = actionLabel(state, resume, loaded);
  // Reversed, so the session's action comes first to the keyboard while it sits rightmost (Cancel, then Delete, to its left).
  // In a jump result (a listbox option) they're for the mouse: the keyboard opens the option with Enter.
  const tab = option ? -1 : undefined;
  return (
    <div className="flex flex-row-reverse items-center justify-start gap-1.5" aria-hidden={option || undefined}>
      {open && (
        <button tabIndex={tab} onClick={open} className={`${lead ? PRIMARY : SECONDARY} ${TOUCH} inline-flex items-center gap-1.5 tabular-nums`} aria-label={`${label}: ${name}`}>
          <Glyph name={state.kind === "stale" || label === "Retry" ? "retry" : "play"} />
          {label}
        </button>
      )}
      {state.kind === "job" && isActive(state.job.phase) && (
        <button tabIndex={tab} onClick={() => cancel(row.sessionKey)} className={`${SECONDARY} ${TOUCH}`} title="Stop; what's downloaded so far is kept">
          Cancel
        </button>
      )}
      {stored != null && (
        <TrashButton
          tabIndex={tab}
          sessionKey={row.sessionKey}
          title={state.kind === "ready" || state.kind === "stale" ? `Delete ${name} from this browser` : `Discard the partial download of ${name}`}
          className="opacity-0 focus-visible:opacity-100 group-hover:opacity-100 pointer-coarse:opacity-100"
        />
      )}
    </div>
  );
}

/** Session rows' frame: the container their columns are sized by. */
export function RowTable({ children }: { children: ReactNode }) {
  return <div className="@container">{children}</div>;
}

/** The column headers over a list of session rows. */
export function RowHeader() {
  return (
    <div className={`${ROW_GRID} ${LABEL} whitespace-nowrap border-b border-zinc-800 px-3 pb-2`} aria-hidden>
      <span className={AT_40}>Season</span>
      <span>Grand Prix</span>
      <span className={AT_40}>Session</span>
      <span className={AT_52}>Date</span>
      <span className={AT_66}>Status</span>
      <span className={`${AT_66} text-right`}>Size</span>
      <span />
    </div>
  );
}

export function SessionRow({
  row,
  state,
  resume,
  lead = false,
  active = false,
  id,
  role,
  onPointerEnter,
  waitUntil = null,
}: {
  row: CatalogRow;
  state: RowState;
  /** Race clock where it was left. */
  resume: string | null;
  /** Its button is the page's one white button. */
  lead?: boolean;
  /** Picked in the jump results (Enter opens it). */
  active?: boolean;
  id?: string;
  role?: string;
  onPointerEnter?: () => void;
  /** OpenF1 blocks this browser's downloads until then (useDownloadBlock). */
  waitUntil?: number | null;
}) {
  const now = useNow(30_000);
  const st = status(row, state, waitUntil, now);
  const sz = sizeText(state);
  const place = [row.circuit, row.country].filter(Boolean).join(" · ");
  return (
    <li
      id={id}
      role={role}
      aria-selected={role === "option" ? active : undefined}
      onPointerEnter={onPointerEnter}
      className={`group border-b border-zinc-800/70 px-3 ${active ? "bg-zinc-900 ring-1 ring-inset ring-zinc-500" : "hover:bg-zinc-900"}`}
    >
      <div className={`${ROW_GRID} min-h-11 py-1.5 text-sm`}>
        <span className={`${AT_40} text-xs tabular-nums text-zinc-400`}>
          {row.year}
          {row.round != null ? ` · R${row.round}` : ""}
        </span>
        <span className="flex min-w-0 flex-col @[40rem]:flex-row @[40rem]:items-baseline @[40rem]:gap-2">
          <span className="truncate font-semibold text-zinc-50">{shortGp(row.meetingName)}</span>
          {/* Narrowest: the session and season go under the Grand Prix. */}
          <span className="truncate text-xs text-zinc-300 @[40rem]:hidden">
            {row.sessionName} · <span className="tabular-nums">{row.year}{row.round != null ? ` R${row.round}` : ""}</span>
          </span>
          <span className="hidden min-w-0 truncate text-xs text-zinc-400 @[40rem]:inline">{place}</span>
          {/* Narrowest, with no Status or Size column: what's stored, downloading or wrong, and its size, under the name. */}
          <span className={`truncate text-xs tabular-nums @[40rem]:hidden ${st.tone ?? "text-zinc-400"}`}>
            {st.text}
            {sz && <span className="text-zinc-400"> · {sz}</span>}
          </span>
        </span>
        <span className={`${AT_40} truncate text-zinc-200`}>{row.sessionName}</span>
        <span className={`${AT_52} text-xs tabular-nums text-zinc-400`}>{day(row.dateStart)}</span>
        <span className={`${AT_66} truncate text-xs tabular-nums ${st.tone ?? "text-zinc-300"}`} title={st.title}>
          {st.text}
        </span>
        <span className={`${AT_66} text-right text-xs tabular-nums text-zinc-400`}>{sz}</span>
        <RowActions row={row} state={state} resume={resume} lead={lead} option={role === "option"} />
      </div>
      {(state.kind === "job" || state.kind === "remote") && (
        <div className="pb-2 @[40rem]:pl-[5.5rem]">
          <RowDetails state={state} />
        </div>
      )}
    </li>
  );
}
