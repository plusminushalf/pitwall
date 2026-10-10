// What Home's Drivers and Teams tabs and the driver and team pages share: whether this season's figures count, the
// line saying what's counted (with the way to count this season too), the F1DB credit, the pages' frame, links
// between drivers and teams, and how a race is named.
//
// Figures from earlier seasons are history; this season's are spoilers (who won last Sunday is in them).
// They count once the spoiler setting is Show, or once revealed here: for this tab only, so a reveal doesn't carry
// over to a race weekend not watched yet.

import { useEffect, useState, type ReactNode } from "react";
import { create } from "zustand";
import { currentYear } from "../../library";
import type { HistoryNames, HistorySource, RaceRef } from "../../history/types";
import { useReplay } from "../../store";
import { FOCUS, LABEL, SECONDARY } from "../controls";
import { Attribution } from "../home/common";
import { Settings } from "../home/Settings";
import { RacesButton } from "../Navigation";

const KEY = "f1-replay:drivers-season";

const readRevealed = (): number | null => {
  try {
    const v = Number(globalThis.sessionStorage?.getItem(KEY));
    return Number.isInteger(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
};

/** The season revealed in this tab, if any. */
const useRevealed = create<{ year: number | null }>(() => ({ year: readRevealed() }));

function reveal(year: number) {
  useRevealed.setState({ year });
  try {
    globalThis.sessionStorage?.setItem(KEY, String(year));
  } catch {
    // Revealed until the page reloads.
  }
}

/** Whether `year`'s figures count: any season but the one under way does, and that one once shown. */
export function useCounts(year: number): boolean {
  const show = useReplay((s) => s.spoilerPref === "show");
  const revealed = useRevealed((s) => s.year);
  return year !== currentYear() || show || revealed === year;
}

const LINK = `rounded-sm text-zinc-300 underline decoration-zinc-600 underline-offset-2 hover:text-zinc-100 ${FOCUS}`;

/** "History from F1DB (CC BY 4.0), v2026.16.1." */
export function F1dbCredit({ source }: { source: HistorySource }) {
  return (
    <>
      From{" "}
      <a href={source.url} target="_blank" rel="noreferrer" className={LINK}>
        F1DB
      </a>{" "}
      (
      <a href={source.licenseUrl} target="_blank" rel="noreferrer" className={LINK}>
        {source.license}
      </a>
      ), {source.release}
    </>
  );
}

/**
 * What the figures count: careers to the end of last season, with the button to count this one too; or through the
 * latest round F1DB has (it's updated after each race weekend).
 */
export function SeasonNote({ year, through, source, className = "" }: { year: number; through: string | null; source: HistorySource; className?: string }) {
  const counts = useCounts(year);
  return (
    <p data-shot-credit={`History: F1DB (${source.license})`} className={`flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-zinc-400 ${className}`}>
      <span>
        {counts ? (through ? `Through ${through}. ` : "") : `Careers to the end of ${year - 1}: ${year} is hidden, as spoilers. `}
        <F1dbCredit source={source} />.
      </span>
      {!counts && (
        <button onClick={() => reveal(year)} className={SECONDARY} title={`Count ${year} too, in this tab (Settings › Spoilers › Show counts it always)`}>
          Count {year}
        </button>
      )}
    </p>
  );
}

/** "1 win", "71 wins". */
export const count = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

/** Points as a table prints them: 3632.5, 421. */
export const points = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 2 });

/** "1.8": an average to a tenth, or a dash. */
export const tenth = (n: number | null) => (n == null ? "—" : n.toFixed(1));

/** A history file by id; null while it loads, "none" if there isn't one. */
export function useHistoryFile<T>(id: string, fetch: (id: string, signal: AbortSignal) => Promise<T | null>): T | "none" | null {
  const [got, setGot] = useState<{ id: string; v: T | "none" } | null>(null);
  useEffect(() => {
    const abort = new AbortController();
    fetch(id, abort.signal)
      .then((v) => setGot({ id, v: v ?? "none" }))
      .catch(() => {
        if (!abort.signal.aborted) setGot({ id, v: "none" });
      });
    return () => abort.abort();
  }, [id, fetch]);
  return got?.id === id ? got.v : null;
}

/** A driver's or a team's name that opens their page. */
export function NameLink({ kind, id, children, className = "" }: { kind: "driver" | "team"; id: string; children: ReactNode; className?: string }) {
  const open = useReplay((s) => (kind === "driver" ? s.openDriver : s.openTeam));
  return (
    <button
      onClick={(e) => {
        e.currentTarget.blur();
        open(id);
      }}
      className={`rounded-sm text-left underline decoration-zinc-700 underline-offset-2 hover:text-zinc-50 hover:decoration-zinc-400 ${FOCUS} ${className}`}
    >
      {children}
    </button>
  );
}

/** "2016 Spanish GP". */
export const raceName = (r: RaceRef, names: HistoryNames) => `${r.year} ${names.gps[r.gp]?.short ?? r.gp}`;

/** A figure with its label, as the pages' rows of facts show them. */
export function Fact({ label, children, note, title }: { label: string; children: ReactNode; note?: string | null; title?: string }) {
  return (
    <div className="min-w-0" title={title}>
      <dt className={LABEL}>{label}</dt>
      <dd className="mt-1 text-2xl font-bold tabular-nums tracking-tight text-zinc-50">
        {children}
        {note && <span className="ml-1.5 text-sm font-normal text-zinc-400">{note}</span>}
      </dd>
    </div>
  );
}

/** A section of a driver's or team's page, under its heading. */
export function Section({ title, aside, children }: { title: ReactNode; aside?: ReactNode; children: ReactNode }) {
  return (
    <section data-shot="" className="mt-12">
      <div className="mb-3 flex flex-wrap items-baseline gap-x-4 gap-y-1 px-3">
        <h2 className="text-2xl font-bold tracking-tight text-zinc-50">{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

/** In place of a season under way that doesn't count yet. */
export function HiddenSeason({ year }: { year: number }) {
  return (
    <div className="flex flex-wrap items-center gap-3 border-y border-zinc-800 px-3 py-4 text-sm text-zinc-400">
      {year}'s results are hidden, as spoilers.
      <button onClick={() => reveal(year)} className={SECONDARY}>
        Count {year}
      </button>
    </div>
  );
}

/** A driver's or team's page: the back button and settings over it, the attribution under it. */
export function CareerPage({ children }: { children: ReactNode }) {
  useEffect(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  }, []);
  return (
    <div className="flex h-full flex-col">
      <div className="h-[env(safe-area-inset-top)] shrink-0 bg-zinc-950" aria-hidden />
      {/* Relative, so what is absolutely placed in the page scrolls in it. */}
      <div className="relative min-h-0 flex-1 overflow-y-auto">
        <header className="sticky top-0 z-20 border-b border-zinc-800 bg-zinc-950">
          <div className="mx-auto flex h-[52px] max-w-6xl items-center gap-3 px-4 md:px-6">
            <RacesButton />
            <span className="flex-1" />
            <Settings />
          </div>
        </header>
        <main className="mx-auto max-w-6xl px-4 pb-16 pt-8 md:px-6">{children}</main>
        <footer className="mx-auto max-w-6xl px-4 md:px-6">
          <div className="border-t border-zinc-800 py-5">
            <Attribution />
          </div>
        </footer>
      </div>
    </div>
  );
}
