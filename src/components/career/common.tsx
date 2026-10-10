// What Home's Drivers and Teams tabs and the driver and team pages share: the line saying what the figures run
// through, the F1DB credit, the pages' frame, links
// between drivers and teams, and how a race is named.
//
// The season under way counts like any other: these pages are stats, not a replay, so no spoiler hiding here.

import { useEffect, useState, type ReactNode } from "react";
import type { HistoryNames, HistorySource, RaceRef } from "../../history/types";
import { useReplay } from "../../store";
import { FOCUS, LABEL } from "../controls";
import { Attribution } from "../home/common";
import { Settings } from "../home/Settings";
import { RacesButton } from "../Navigation";

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

/** What the figures run through (the latest round F1DB has: it's updated after each race weekend), and the credit. */
export function SeasonNote({ through, source, className = "" }: { through: string | null; source: HistorySource; className?: string }) {
  return (
    <p data-shot-credit={`History: F1DB (${source.license})`} className={`text-xs text-zinc-400 ${className}`}>
      {through ? `Through ${through}. ` : ""}
      <F1dbCredit source={source} />.
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
