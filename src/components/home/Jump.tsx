// Home's jump field: type "monza 24 q" and the sessions that match replace what's below it (Continue and the season),
// as timing rows. "/" focuses it, ↑/↓ pick a row, Enter opens it, Esc clears. The first time it's used it loads every
// season's calendar (cached in this browser; two OpenF1 requests for each season not seen yet). When the matches are at
// a few circuits, their pages are offered too (every session there over the years, and its history).

import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useCoarsePointer, usePhone } from "../../hooks/usePhone";
import { loadLearned } from "../../ingest/runner";
import { rowState, useLibrary, YEARS } from "../../library";
import { circuitSlug } from "../../circuit";
import { useReplay } from "../../store";
import { FOCUS, Glyph, LABEL, openAction, SECONDARY, useDownloadBlock, useNow } from "./common";
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
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-read whenever the downloads change
  const learned = useMemo(() => loadLearned(), [jobs]);
  const [resume] = useState(resumeClocks);
  const waitUntil = useDownloadBlock();
  const searching = query.trim() !== "";
  // Touch has no "/" or Esc: a Clear button instead of the key hints. A phone's field is too short for the long examples.
  const coarse = useCoarsePointer();
  const phone = usePhone();

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
  const circuits = [...new Set(results.map((r) => r.circuit).filter(Boolean))];
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
          placeholder={phone ? "Jump: monza 24 quali, spa race, r15" : "Jump to a session: monza 24 quali, spa race, japan fp2, r15"}
          className={`peer h-12 w-full rounded-md border border-zinc-800 bg-zinc-900 pl-11 pr-24 text-base text-zinc-50 placeholder:text-zinc-400 hover:border-zinc-700 focus:border-zinc-500 focus:outline-2 focus:outline-zinc-400`}
        />
        {coarse ? (
          searching && (
            <button
              type="button"
              onClick={() => {
                setQuery("");
                input.current?.focus();
              }}
              className={`absolute right-1 top-1/2 flex h-10 -translate-y-1/2 items-center rounded-md px-3 text-xs font-semibold text-zinc-300 hover:text-white ${FOCUS}`}
            >
              Clear
            </button>
          )
        ) : (
          <span className={`pointer-events-none absolute right-3 top-1/2 flex -translate-y-1/2 items-center gap-1.5 text-xs text-zinc-400 ${searching ? "" : "peer-focus:hidden"}`}>
            {searching ? (
              <>
                <kbd className="rounded border border-zinc-700 bg-zinc-800 px-1.5 py-0.5 font-sans text-[11px] text-zinc-200">Esc</kbd> clear
              </>
            ) : (
              <kbd className="rounded border border-zinc-700 bg-zinc-800 px-1.5 py-0.5 font-sans text-[11px] text-zinc-200">/</kbd>
            )}
          </span>
        )}
      </div>

      {searching ? (
        <section aria-label="Matching sessions" className="mt-6">
          <p className="mb-3 px-3 text-sm text-zinc-300" aria-live="polite">
            {results.length === 25 ? "The 25 newest matches" : results.length ? `${results.length} ${results.length === 1 ? "session" : "sessions"}` : "No session matches"}
            {loading.length > 0 && <span className="text-zinc-400"> · loading the {loading.join(", ")} calendar{loading.length > 1 ? "s" : ""}…</span>}
            {results.length === 25 && <span className="text-zinc-400"> · add a year or a session to narrow it</span>}
            {results.length > 0 && !coarse && <span className="text-zinc-400"> · ↑↓ to pick, Enter to open</span>}
          </p>
          {circuits.length > 0 && circuits.length <= 3 && (
            <p className="mb-3 flex flex-wrap items-center gap-2 px-3">
              <span className={LABEL}>{circuits.length === 1 ? "Circuit" : "Circuits"}</span>
              {circuits.map((c) => (
                <button
                  key={c}
                  onClick={(e) => {
                    e.currentTarget.blur();
                    useReplay.getState().openCircuit(circuitSlug(c));
                  }}
                  className={`${SECONDARY} pointer-coarse:min-h-11`}
                  title={`${c}: every session there over the years, and its history`}
                >
                  {c} →
                </button>
              ))}
            </p>
          )}
          {results.length ? (
            <RowTable>
              <RowHeader />
              {/* biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: the combobox pattern's listbox, as in WAI-ARIA */}
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
                    waitUntil={waitUntil}
                  />
                ))}
              </ul>
            </RowTable>
          ) : (
            <p id="jump-results" className="border-y border-zinc-800 px-3 py-4 text-sm text-zinc-300">
              Pitwall has every race, sprint, qualifying and free practice since 2023. Try a Grand Prix, circuit or country, a year, and a session:
              “spa 23 race”, “japan quali”, “brazil sprint”, “monaco fp2”.
            </p>
          )}
        </section>
      ) : (
        children
      )}
    </>
  );
}
