// What Home's Drivers tab and a driver's page share: whether this season's figures count, the line saying what's
// counted (with the way to count this season too), and the F1DB credit.
//
// A driver's figures from earlier seasons are history; this season's are spoilers (who won last Sunday is in them).
// They count once the spoiler setting is Show, or once revealed here: for this tab only, so a reveal doesn't carry
// over to a race weekend not watched yet.

import { create } from "zustand";
import { currentYear } from "../../library";
import type { HistorySource } from "../../history/types";
import { useReplay } from "../../store";
import { FOCUS, SECONDARY } from "../controls";

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
