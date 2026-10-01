// Home's jump field: type "monza 24 q" and the sessions that match replace what's below it (Continue and the season),
// as timing rows. "/" focuses it, ↑/↓ pick a row, Enter opens it, Esc clears. The first time it's used it loads every
// season's calendar (cached in this browser; two OpenF1 requests for each season not seen yet).

import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { loadLearned } from "../../ingest/runner";
import { rowState, useLibrary, YEARS } from "../../library";
import { FOCUS, Glyph, openAction, useNow } from "./common";
import { resumeClocks } from "./resume";
import { searchSessions } from "./search";
import { RowHeader, RowTable, SessionRow } from "./SessionRow";

const typing = (t: EventTarget | null) => t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement || (t instanceof HTMLElement && t.isContentEditable);

export function Jump({ children }: { children: ReactNode }) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const years = useLibrary((s) => s.years);
  const jobs = useLibrary((s) => s.jobs);
  const remote = useLibrary((s) => s.remote);
  const entries = useLibrary((s) => s.entries);
  const partial = useLibrary((s) => s.partial);
  const now = useNow(2000);
  const learned = useMemo(() => loadLearned(), [jobs]);
  const [resume] = useState(resumeClocks);
  const searching = query.trim() !== "";

  // "/" anywhere on Home (not while typing elsewhere) goes to the field.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey || typing(e.target)) return;
      e.preventDefault();
      input.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const loadAll = () => {
    const s = useLibrary.getState();
    for (const y of YEARS) if (!s.years[y]?.catalog && !s.years[y]?.loading) void s.loadYear(y);
  };

  const results = useMemo(() => {
    if (!searching) return [];
    const rows = Object.values(years).flatMap((y) => y.catalog?.rows ?? []);
    return searchSessions(query, rows, now);
  }, [searching, query, years, now]);
  const states = results.map((r) => rowState(r, { jobs, remote, entries, partial }, now, learned));
  const loading = YEARS.filter((y) => !years[y]?.catalog && years[y]?.loading);
  const pick = Math.min(active, Math.max(0, results.length - 1));
  const optionId = (i: number) => `jump-option-${results[i]?.sessionKey}`;

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      if (query) setQuery("");
      else e.currentTarget.blur();
      e.preventDefault();
    } else if (e.key === "ArrowDown" && results.length) {
      setActive((pick + 1) % results.length);
      e.preventDefault();
    } else if (e.key === "ArrowUp" && results.length) {
      setActive((pick - 1 + results.length) % results.length);
      e.preventDefault();
    } else if (e.key === "Enter" && results[pick]) {
      const open = openAction(results[pick], states[pick]);
      if (open) {
        e.currentTarget.blur();
        open();
      }
      e.preventDefault();
    }
  };

  return (
    <>
      <div role="search" className="relative">
        <label htmlFor="jump" className="sr-only">
          Jump to a session
        </label>
        <Glyph name="search" className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
        <input
          ref={input}
          id="jump"
          type="text"
          role="combobox"
          aria-expanded={searching}
          aria-controls="jump-results"
          aria-autocomplete="list"
          aria-activedescendant={searching && results.length ? optionId(pick) : undefined}
          autoComplete="off"
          spellCheck={false}
          value={query}
          onFocus={loadAll}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
          placeholder="Jump to a session: monza 24 quali, spa race, r15"
          className={`peer h-12 w-full rounded-md border border-zinc-800 bg-zinc-900 pl-11 pr-24 text-base text-zinc-50 placeholder:text-zinc-400 hover:border-zinc-700 focus:border-zinc-500 focus:outline-none ${FOCUS}`}
        />
        <span className={`pointer-events-none absolute right-3 top-1/2 flex -translate-y-1/2 items-center gap-1.5 text-xs text-zinc-400 ${searching ? "" : "peer-focus:hidden"}`}>
          {searching ? (
            <>
              <kbd className="rounded border border-zinc-700 bg-zinc-800 px-1.5 py-0.5 font-sans text-[11px] text-zinc-200">Esc</kbd> clear
            </>
          ) : (
            <kbd className="rounded border border-zinc-700 bg-zinc-800 px-1.5 py-0.5 font-sans text-[11px] text-zinc-200">/</kbd>
          )}
        </span>
      </div>

      {searching ? (
        <section aria-label="Matching sessions" className="mt-6">
          <p className="mb-3 px-3 text-sm text-zinc-300" aria-live="polite">
            {results.length ? `${results.length === 25 ? "25+" : results.length} ${results.length === 1 ? "session" : "sessions"}` : "No session matches"}
            {loading.length > 0 && <span className="text-zinc-400"> · loading the {loading.join(", ")} calendar{loading.length > 1 ? "s" : ""}…</span>}
            {results.length > 0 && <span className="text-zinc-400"> · ↑↓ to pick, Enter to open</span>}
          </p>
          {results.length ? (
            <RowTable>
              <RowHeader />
              <ul id="jump-results" role="listbox" aria-label="Matching sessions">
                {results.map((r, i) => (
                  <SessionRow
                    key={r.sessionKey}
                    id={optionId(i)}
                    role="option"
                    row={r}
                    state={states[i]}
                    resume={resume[r.sessionKey] ?? null}
                    active={i === pick}
                    onPointerEnter={() => setActive(i)}
                  />
                ))}
              </ul>
            </RowTable>
          ) : (
            <p id="jump-results" className="border-y border-zinc-800 px-3 py-4 text-sm text-zinc-300">
              Try a Grand Prix, circuit or country, a year, and a session: “spa 23 race”, “japan quali”, “brazil sprint”.
            </p>
          )}
        </section>
      ) : (
        children
      )}
    </>
  );
}
