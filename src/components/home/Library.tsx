// Home's "Your library": every session downloaded, downloading or part-downloaded in this browser. Downloads under way
// first, then by when each was last watched (where it was left shown on the card), then the never-watched, newest race first.
// Its header says how much is stored and whether the browser may clear it.

import { useMemo, useState } from "react";
import type { CatalogRow } from "../../ingest/catalog";
import { loadLearned } from "../../ingest/runner";
import { labelOf, rowForKey, rowState, useLibrary, type RowState } from "../../library";
import { raceClock } from "../../lib/format";
import { useReplay, watchHistory, type Watched } from "../../store";
import { Action, CardButton, date, LABEL, RowDetails, sessionDot, size, useNow } from "./common";

function LibraryCard({ row, state, watched }: { row: CatalogRow; state: RowState; watched: Watched | undefined }) {
  const watchNow = useLibrary((s) => s.watchNow);
  const loaded = useReplay((s) => s.mode === "replay" && s.session?.meta.sessionKey === row.sessionKey);
  const ready = state.kind === "ready";

  return (
    <li
      className={`group relative flex flex-col rounded-lg border bg-zinc-900/60 p-4 transition-colors ${
        ready ? "border-zinc-800 hover:border-zinc-600 hover:bg-zinc-900" : "border-zinc-800/70"
      } ${loaded ? "ring-1 ring-zinc-600" : ""}`}
    >
      {ready && <CardButton label={`Watch ${row.year} ${labelOf(row)}`} onClick={() => watchNow(row.sessionKey)} />}
      <div className="pointer-events-none relative min-w-0">
        <p className={`flex items-center gap-1.5 ${LABEL}`}>
          <span className={`h-1.5 w-1.5 rounded-full ${sessionDot(row)}`} />
          {row.year} · {row.sessionName}
          {loaded && <span className="ml-auto normal-case tracking-normal text-zinc-400">Paused here</span>}
        </p>
        <h3 className="mt-1 truncate text-base font-bold text-zinc-100 group-hover:text-white">{row.meetingName}</h3>
        <p className="truncate text-xs text-zinc-500">
          {[row.circuit, row.country, date(row.dateStart)].filter(Boolean).join(" · ")}
        </p>
      </div>
      <div className="relative z-10 mt-auto flex min-h-7 items-center justify-end gap-2 pt-3">
        {ready && (
          <span className="mr-auto text-[11px] tabular-nums text-zinc-500">
            {watched
              ? watched.raceTime != null && watched.raceTime > 0
                ? `Paused at ${raceClock(watched.raceTime)}`
                : `${Math.round(watched.frac * 100)}% watched`
              : size(state.entry.processedBytes + state.entry.rawBytes)}
          </span>
        )}
        <Action row={row} state={state} compact quiet />
      </div>
      <div className="relative z-10">
        <RowDetails state={state} />
      </div>
      {ready && watched && (
        <div className="absolute inset-x-0 bottom-0 h-0.5 overflow-hidden rounded-b-lg bg-zinc-800">
          <div className="h-full bg-red-500" style={{ width: `${Math.round(watched.frac * 100)}%` }} />
        </div>
      )}
    </li>
  );
}

/** Sessions stored, space used and whether the browser may clear it; `Keep it` asks for persistent storage. */
function StorageStatus() {
  const usage = useLibrary((s) => s.usage);
  const count = useLibrary((s) => Object.keys(s.entries).length);
  const refreshUsage = useLibrary((s) => s.refreshUsage);
  const [asking, setAsking] = useState(false);

  const persist = async () => {
    setAsking(true);
    await navigator.storage?.persist?.().catch(() => false);
    await refreshUsage();
    setAsking(false);
  };

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-zinc-400">
      <span className="tabular-nums">
        {count} {count === 1 ? "session" : "sessions"}
        {usage?.usage != null ? ` · ${size(usage.usage)}` : ""}
      </span>
      {usage?.persisted === true && (
        <span className="text-emerald-400/90" title="The browser won't clear this site's data to free up space">
          ✓ Persistent
        </span>
      )}
      {usage?.persisted === false && (
        <span className="flex items-center gap-1.5 text-zinc-500">
          <span title="Browsers can clear a site's storage when disk space runs low, unless it's persistent">Not persistent</span>
          <button onClick={() => void persist()} disabled={asking} className="rounded px-1 text-zinc-300 underline decoration-zinc-600 underline-offset-2 hover:text-white">
            Keep it
          </button>
        </span>
      )}
    </div>
  );
}

export function Library() {
  const ready = useLibrary((s) => s.ready);
  const entries = useLibrary((s) => s.entries);
  const partial = useLibrary((s) => s.partial);
  const jobs = useLibrary((s) => s.jobs);
  const remote = useLibrary((s) => s.remote);
  const years = useLibrary((s) => s.years);
  const now = useNow(5000);
  const learned = useMemo(() => loadLearned(), [jobs]);
  // Read once per visit to Home (it's written while watching).
  const [watched] = useState(watchHistory);

  const rows = useMemo(() => {
    const keys = new Set<number>([
      ...Object.keys(entries).map(Number),
      ...Object.keys(partial).map(Number),
      ...Object.values(jobs)
        .filter((j) => j.phase !== "done" && j.phase !== "cancelled")
        .map((j) => j.info.key),
      ...Object.values(remote)
        .filter((r) => now - r.at < 5000)
        .map((r) => r.key),
    ]);
    return [...keys]
      .map((key) => rowForKey(key, { years, entries, partial, jobs }))
      .filter((r): r is CatalogRow => r != null)
      .sort((a, b) => {
        const busy = (r: CatalogRow) => (entries[r.sessionKey] ? 0 : 1);
        return busy(b) - busy(a) || (watched[b.sessionKey]?.at ?? 0) - (watched[a.sessionKey]?.at ?? 0) || b.dateStart.localeCompare(a.dateStart);
      });
  }, [entries, partial, jobs, remote, years, now, watched]);

  return (
    <section aria-labelledby="library-title">
      <div className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 id="library-title" className="text-lg font-black tracking-tight text-zinc-100">
          Your library
        </h2>
        {rows.length > 0 && <span className="text-xs tabular-nums text-zinc-500">{rows.length}</span>}
        <span className="flex-1" />
        {ready && <StorageStatus />}
      </div>
      {!ready ? (
        <p className="text-sm text-zinc-500">Reading the races stored in this browser…</p>
      ) : rows.length ? (
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {rows.map((r) => (
            <LibraryCard key={r.sessionKey} row={r} state={rowState(r, { jobs, remote, entries, partial }, now, learned)} watched={watched[r.sessionKey]} />
          ))}
        </ul>
      ) : (
        <div className="rounded-lg border border-dashed border-zinc-800 px-6 py-8 text-center">
          <p className="text-sm font-semibold text-zinc-200">Nothing downloaded yet</p>
          <p className="mx-auto mt-1 max-w-md text-xs leading-relaxed text-zinc-400">
            A race plays a few seconds after you pick it and downloads into this browser as you watch, to replay any time, even offline. Start with the latest
            race above, or pick one from the calendar below.
          </p>
        </div>
      )}
    </section>
  );
}
