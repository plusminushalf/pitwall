// What Home's Drivers and Teams tabs and the driver and team pages share: the line saying what the figures run
// through, the F1DB credit, the pages' frame and type levels (section, block, lead figures, detail rows), links
// between drivers and teams, and how a race is named.
//
// The season under way counts like any other: these pages are stats, not a replay, so no spoiler hiding here.

import { useEffect, useState, type ReactNode } from "react";
import { teamColor } from "../../history/teamColors";
import type { HistoryNames, HistorySource, RaceRef } from "../../history/types";
import { useReplay } from "../../store";
import { FOCUS, LABEL } from "../controls";
import { Attribution } from "../home/common";
import { Settings } from "../home/Settings";
import { RacesButton } from "../Navigation";

const LINK = `rounded-sm text-zinc-300 underline decoration-zinc-600 underline-offset-2 hover:text-zinc-100 ${FOCUS}`;

/** "from F1DB (CC BY 4.0), v2026.16.1" */
export function F1dbCredit({ source }: { source: HistorySource }) {
  return (
    <>
      from{" "}
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
      {through ? `Through ${through}, ` : "Results "}
      <F1dbCredit source={source} />.
    </p>
  );
}

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

/**
 * A driver's or a team's name that opens their page. In a table or list it's plain text that underlines on hover (a
 * column of underlines is noise); in a sentence, `inline` keeps the underline a link has.
 */
export function NameLink({
  kind,
  id,
  children,
  inline = false,
  className = "",
}: {
  kind: "driver" | "team";
  id: string;
  children: ReactNode;
  inline?: boolean;
  className?: string;
}) {
  const open = useReplay((s) => (kind === "driver" ? s.openDriver : s.openTeam));
  return (
    <button
      onClick={(e) => {
        e.currentTarget.blur();
        open(id);
      }}
      className={`rounded-sm text-left underline-offset-2 hover:text-zinc-50 hover:underline hover:decoration-zinc-400 ${inline ? "underline decoration-zinc-600" : "decoration-zinc-500"} ${FOCUS} ${className}`}
    >
      {children}
    </button>
  );
}

/** "2016 Spanish GP". */
export const raceName = (r: RaceRef, names: HistoryNames) => `${r.year} ${names.gps[r.gp]?.short ?? r.gp}`;

/**
 * A team's colour as the timing tower draws it: a short upright stripe before a name. `hold`: an empty one when the
 * team has no colour, so names in a column still line up.
 */
export function TeamStripe({ team, className = "h-4", hold = false }: { team: string | null; className?: string; hold?: boolean }) {
  const color = team ? teamColor(team) : null;
  if (!color && !hold) return null;
  return <span aria-hidden className={`w-1 shrink-0 rounded-sm ${className}`} style={color ? { background: color } : undefined} />;
}

/** A figure under its label: a section's lead row (DESIGN.md's stat role: 20px, black, tabular). */
export function Stat({ label, children, note, title }: { label: string; children: ReactNode; note?: string | null; title?: string }) {
  return (
    <div className="min-w-0" title={title}>
      <dt className={LABEL}>{label}</dt>
      <dd className="mt-1 text-xl font-black leading-7 tracking-tight tabular-nums text-zinc-50">
        {children}
        {note && <span className="ml-1.5 text-xs font-normal tracking-normal text-zinc-400">{note}</span>}
      </dd>
    </div>
  );
}

/** A section's lead row of figures, between hairlines. */
export function StatRow({ children }: { children: ReactNode }) {
  return (
    <dl className="grid grid-cols-2 gap-x-6 gap-y-4 border-y border-zinc-800 px-3 py-4 min-[480px]:grid-cols-4 lg:flex lg:flex-wrap lg:gap-x-10">{children}</dl>
  );
}

/**
 * A section of a driver's or team's page: its title (DESIGN.md's headline), what it covers beside it, and its blocks.
 * Generous space above, tight below, so it reads as the start of what follows.
 */
export function Section({ title, aside, children }: { title: ReactNode; aside?: ReactNode; children: ReactNode }) {
  return (
    <section data-shot="" className="mt-14 first:mt-10">
      <div className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1 px-3">
        <h2 className="text-2xl font-bold tracking-tight text-zinc-50">{title}</h2>
        {aside && <span className="text-sm text-zinc-400">{aside}</span>}
      </div>
      {children}
    </section>
  );
}

/** A block inside a section, under its own title (DESIGN.md's title role), set apart from the block before it. */
export function Block({ title, aside, children, className = "" }: { title: string; aside?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={`mt-8 min-w-0 ${className}`}>
      <h3 className="mb-2 flex flex-wrap items-baseline gap-x-2 px-3 text-sm font-semibold text-zinc-100">
        {title}
        {aside && <span className="text-xs font-normal text-zinc-400">{aside}</span>}
      </h3>
      {children}
    </div>
  );
}

/** Rows of a label, what it is, and a detail: milestones and the like, aligned like timing rows. */
export function DetailRows({ rows }: { rows: { key: string; label: string; value: ReactNode; detail?: ReactNode }[] }) {
  return (
    <dl className="border-t border-zinc-800">
      {rows.map((r) => (
        <div
          key={r.key}
          className="grid grid-cols-[7.5rem_minmax(0,1fr)] items-baseline gap-x-3 border-b border-zinc-800/70 px-3 py-2 text-sm sm:grid-cols-[9rem_auto_minmax(0,1fr)]"
        >
          <dt className="text-zinc-400">{r.label}</dt>
          <dd className="font-semibold tabular-nums text-zinc-50">{r.value}</dd>
          {r.detail && <dd className="col-start-2 truncate text-xs text-zinc-400 sm:col-start-3 sm:text-sm">{r.detail}</dd>}
        </div>
      ))}
    </dl>
  );
}

/** A driver's or team's page: the back button and settings over it, the source and attribution under it. */
export function CareerPage({ children, source }: { children: ReactNode; source?: HistorySource }) {
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
          <div className="space-y-1.5 border-t border-zinc-800 py-5">
            {source && (
              <p data-shot-credit={`History: F1DB (${source.license})`} className="text-xs text-zinc-400">
                Results <F1dbCredit source={source} />, updated after each race weekend. Wins, podiums and poles are Grands Prix only; championship points
                include sprints.
              </p>
            )}
            <Attribution />
          </div>
        </footer>
      </div>
    </div>
  );
}
