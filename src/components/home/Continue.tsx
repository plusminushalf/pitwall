// Home's Continue list: the sessions in this browser (downloaded, downloading or part-downloaded) and the latest race
// when it isn't one of them. Downloads under way first, then the freshest: when each was last watched, or for one
// never watched, when it ran. Five rows, then all of them on request. Under it: whether the browser may clear them.

import { useEffect, useMemo, useState } from "react";
import type { CatalogRow } from "../../ingest/catalog";
import { loadLearned } from "../../ingest/runner";
import { isActive, rowForKey, rowState, useLibrary } from "../../library";
import { watchHistory } from "../../store";
import { FOCUS, Glyph, useDownloadBlock, useNow } from "./common";
import { resumeClocks } from "./resume";
import { RowHeader, RowTable, SessionRow } from "./SessionRow";

const SHOWN = 5;

/** Whether the browser may clear what's stored; `Keep them` asks for persistent storage. */
function StorageNote() {
  const usage = useLibrary((s) => s.usage);
  const stored = useLibrary((s) => Object.keys(s.entries).length + Object.keys(s.partial).length);
  const refreshUsage = useLibrary((s) => s.refreshUsage);
  const [asking, setAsking] = useState(false);
  const persist = async () => {
    setAsking(true);
    await navigator.storage?.persist?.().catch(() => false);
    await refreshUsage();
    setAsking(false);
  };
  if (!stored) return null;
  if (usage?.persisted === true) {
    return (
      <p className="flex items-center gap-1.5 text-xs text-zinc-400">
        <Glyph name="check" className="h-3 w-3 text-emerald-400" />
        Kept: the browser won't clear stored sessions to free up space.
      </p>
    );
  }
  if (usage?.persisted !== false) return null;
  return (
    <p className="flex flex-wrap items-center gap-x-2 text-xs text-zinc-400">
      The browser may clear stored sessions when disk space runs low.
      <button
        onClick={() => void persist()}
        disabled={asking}
        className={`rounded-sm font-semibold text-zinc-100 underline decoration-zinc-500 underline-offset-2 hover:decoration-zinc-200 pointer-coarse:min-h-11 ${FOCUS}`}
      >
        Keep them
      </button>
    </p>
  );
}

export function Continue({ featured, lead }: { featured: CatalogRow | null; lead: boolean }) {
  const ready = useLibrary((s) => s.ready);
  const entries = useLibrary((s) => s.entries);
  const partial = useLibrary((s) => s.partial);
  const jobs = useLibrary((s) => s.jobs);
  const remote = useLibrary((s) => s.remote);
  const years = useLibrary((s) => s.years);
  const now = useNow(2000);
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-read whenever the downloads change
  const learned = useMemo(() => loadLearned(), [jobs]);
  // Read once per visit to Home (it's written while watching).
  const [watched] = useState(watchHistory);
  const [resume] = useState(resumeClocks);
  const [all, setAll] = useState(false);
  const waitUntil = useDownloadBlock();

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
    const found = [...keys].map((key) => rowForKey(key, { years, entries, partial, jobs })).filter((r): r is CatalogRow => r != null);
    if (featured && !keys.has(featured.sessionKey)) found.push(featured);
    const busy = (r: CatalogRow) => (jobs[r.sessionKey] && isActive(jobs[r.sessionKey].phase) ? 1 : 0);
    const fresh = (r: CatalogRow) => watched[r.sessionKey]?.at ?? Date.parse(r.dateEnd);
    return found.sort((a, b) => busy(b) - busy(a) || fresh(b) - fresh(a));
  }, [entries, partial, jobs, remote, years, now, watched, featured]);

  // Each stored session's season (from this browser's copy when it has one), so every row carries its round.
  const storedYears = useMemo(() => [...new Set(Object.values(entries).map((e) => e.year))].sort().join(","), [entries]);
  useEffect(() => {
    const s = useLibrary.getState();
    for (const y of storedYears ? storedYears.split(",").map(Number) : []) if (!s.years[y]?.catalog) void s.loadYear(y);
  }, [storedYears]);

  const shown = all ? rows : rows.slice(0, SHOWN);

  return (
    <section data-shot="" aria-labelledby="continue-title" className="mt-10">
      <h2 id="continue-title" className="mb-3 text-2xl font-bold tracking-tight text-zinc-50">
        Continue
      </h2>
      {!ready ? (
        <p className="text-sm text-zinc-400">Reading the sessions stored in this browser…</p>
      ) : rows.length ? (
        <>
          <RowTable>
            <RowHeader />
            <ul aria-labelledby="continue-title">
              {shown.map((r, i) => (
                <SessionRow
                  key={r.sessionKey}
                  row={r}
                  state={rowState(r, { jobs, remote, entries, partial }, now, learned)}
                  resume={resume[r.sessionKey] ?? null}
                  lead={lead && i === 0}
                  waitUntil={waitUntil}
                />
              ))}
            </ul>
          </RowTable>
          <div className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-2 px-3">
            <StorageNote />
            <span className="flex-1" />
            {rows.length > SHOWN && (
              <button onClick={() => setAll(!all)} className={`rounded-sm text-xs font-semibold text-zinc-200 hover:text-white pointer-coarse:min-h-11 ${FOCUS}`} aria-expanded={all}>
                {all ? "Show fewer" : `Show all ${rows.length}`}
              </button>
            )}
          </div>
        </>
      ) : (
        <p className="border-y border-zinc-800 px-3 py-4 text-sm text-zinc-300">
          Nothing in this browser yet. Pick a session in the season below: it plays in a few seconds and downloads as you watch, to replay any time, even
          offline.
        </p>
      )}
    </section>
  );
}
