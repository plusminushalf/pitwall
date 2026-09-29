// A shared link (?session=<key>&t=…) to a session that isn't in this browser's library yet: offer to
// download it, show the progress, and open it at the linked moment when it's ready (library.ts).

import { useEffect, type ReactNode } from "react";
import { useLibrary } from "../library";
import { raceClock } from "../lib/format";
import { Action, approx, Attribution, JobProgress, SECONDARY, useRowState } from "./RacePicker";

const when = (iso: string) => new Date(iso).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "long", year: "numeric" });

export function DownloadPrompt({ sessionKey }: { sessionKey: number }) {
  const lookup = useLibrary((s) => s.lookups[sessionKey]);
  const link = useLibrary((s) => s.link);
  const openPicker = useLibrary((s) => s.openPicker);
  const row = lookup?.row ?? null;
  const state = useRowState(row);

  useEffect(() => {
    void useLibrary.getState().lookup(sessionKey);
  }, [sessionKey]);

  const t = link?.key === sessionKey ? link.opts.t : undefined;
  let body: ReactNode;
  if (!row) {
    body = lookup?.error ? (
      <p className="text-sm text-red-400">{lookup.error}</p>
    ) : (
      <p className="text-sm text-zinc-400">Looking up session {sessionKey} on OpenF1…</p>
    );
  } else {
    const intro =
      state?.kind === "stale"
        ? "This session is in your library, but was processed by an older version of the app. Updating it takes a few seconds and needs no download."
        : state?.kind === "upcoming"
          ? "This session hasn't happened yet. Come back once it's over."
          : state?.kind === "cancelled"
            ? "This session was cancelled."
            : state?.kind === "available" || state?.kind === "partial"
              ? `It isn't in your library yet. It downloads from OpenF1 straight into this browser (${approx(state.estimate.seconds)}, ~${Math.round(state.estimate.mb)} MB), then opens${t != null ? " at the linked moment" : ""}.`
              : null;
    body = (
      <>
        <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Shared race</p>
        <h1 className="mt-1 text-lg font-black tracking-tight text-zinc-100">
          {row.year} {row.meetingName} · {row.sessionName}
        </h1>
        <p className="text-xs text-zinc-500">
          {row.circuit}
          {row.country ? ` · ${row.country}` : ""} · {when(row.dateStart)}
          {t != null ? ` · link at ${raceClock(t)} into the session` : ""}
        </p>
        {intro && <p className="mt-3 text-sm leading-relaxed text-zinc-300">{intro}</p>}
        {state && (
          <div className="mt-4">
            <div className="flex flex-wrap items-center gap-2">
              {state.kind === "available" ? (
                <button onClick={() => useLibrary.getState().download(row, { watch: link?.opts ?? {} })} className="rounded bg-zinc-100 px-3 py-1.5 text-sm font-semibold text-zinc-900 hover:bg-white">
                  Download this race
                </button>
              ) : (
                <Action row={row} state={state} current={false} compact />
              )}
            </div>
            {state.kind === "job" && state.job.phase === "failed" && <p className="mt-2 text-xs text-red-400">{state.job.error}</p>}
            {state.kind === "job" && <JobProgress job={state.job} />}
            {state.kind === "remote" && <JobProgress remote={state.job} />}
          </div>
        )}
      </>
    );
  }

  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 px-4">
      <div className="w-full max-w-lg rounded-lg border border-zinc-800 bg-zinc-900 p-5 shadow-2xl">
        {body}
        <div className="mt-5 flex items-center gap-3 border-t border-zinc-800 pt-3">
          <button onClick={() => openPicker()} className={SECONDARY}>
            Browse races
          </button>
          <span className="flex-1" />
        </div>
      </div>
      <Attribution className="max-w-lg text-center" />
    </div>
  );
}
