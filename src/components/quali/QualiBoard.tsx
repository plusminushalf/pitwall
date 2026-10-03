// The timing board beside the lap comparison: qualifying's (the result, and each segment's standings, with the
// knock-out lines), or practice's classification by best lap. Clicking a driver adds them to the comparison,
// clicking a time compares that lap.

import { useMemo, type ReactNode } from "react";
import { TyreBadge } from "../../widgetkit/ui/TyreBadge";
import { compareModel } from "../../data/compare";
import type { Tyre } from "../../data/practice";
import type { Session } from "../../data/session";
import { compareStyles } from "../../lib/compareColors";
import { lapTime, shortTeam, teamColor } from "../../lib/format";
import { MAX_COMPARE, useQuali, type BoardTab } from "../../qualiStore";
import { useReplay } from "../../store";
import { Swatch } from "./CompareCharts";

const ROW = "grid items-center gap-1 pl-5 pr-2";
const HEAD = "text-[10px] font-semibold uppercase tracking-wider text-zinc-500";

function Tabs({ session }: { session: Session }) {
  const q = session.meta.quali!;
  const board = useQuali((s) => s.board);
  const setBoard = useQuali((s) => s.setBoard);
  const tabs: { id: BoardTab; label: string }[] = [{ id: "result", label: "Result" }, ...q.segments.map((s) => ({ id: s.number, label: s.name }))];
  return (
    <div className="flex h-8 shrink-0 items-center gap-1 border-b border-zinc-800 px-2">
      {tabs.map((t) => (
        <button
          key={t.id}
          onClick={() => setBoard(t.id)}
          className={`rounded px-2 py-0.5 text-xs font-semibold ${board === t.id ? "bg-zinc-100 text-zinc-900" : "text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"}`}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

/**
 * A row of standings by best lap. `count`: laps (push laps in a qualifying segment, laps run in practice), `deleted`:
 * lap times race control deleted, `tyre`: practice's best lap's tyre.
 */
interface Standing {
  driver: number;
  time: number | null;
  lap: number | null;
  count: number;
  deleted: { lap: number; reason: string }[];
  tyre?: Tyre | null;
}

/** Practice has one table: its title where qualifying's tabs are. */
function Title({ children }: { children: ReactNode }) {
  return <div className="flex h-8 shrink-0 items-center border-b border-zinc-800 px-4 text-xs font-semibold text-zinc-100">{children}</div>;
}

/** Divider above the first driver knocked out in a segment. */
function Cutoff({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-red-400/80">
      <span className="h-px flex-1 bg-red-500/40" />
      {label}
      <span className="h-px flex-1 bg-red-500/40" />
    </div>
  );
}

export function QualiBoard() {
  const session = useReplay((s) => s.session)!;
  const selected = useReplay((s) => s.selected);
  const board = useQuali((s) => s.board);
  const meta = session.meta;
  const q = meta.quali;
  const styles = useMemo(() => {
    const st = compareStyles(selected.map((n) => session.drivers.get(n)?.info));
    return new Map(selected.map((n, i) => [n, st[i]]));
  }, [selected, session]);

  const toggle = (n: number) => {
    const { selected: sel, toggleSelected } = useReplay.getState();
    if (!sel.includes(n) && sel.length >= MAX_COMPARE) return;
    toggleSelected(n);
  };
  /** Compare this driver's lap (adding the driver if needed). */
  const pick = (n: number, lap: number | null) => {
    if (lap == null) return;
    const { selected: sel, toggleSelected } = useReplay.getState();
    if (!sel.includes(n)) {
      if (sel.length >= MAX_COMPARE) return;
      toggleSelected(n);
    }
    useQuali.getState().setLap(n, lap);
  };

  const segBest = q ? q.segments.map((_, k) => Math.min(...q.results.map((r) => r.times[k] ?? Infinity))) : [];
  const full = selected.length >= MAX_COMPARE;

  const driverCell = (n: number) => {
    const d = session.drivers.get(n)!.info;
    return (
      <span className="flex min-w-0 items-center gap-1.5">
        <span className="h-4 w-1 shrink-0 rounded-sm" style={{ background: teamColor(d.teamColour) }} />
        <span className="font-bold tracking-wide">{d.acronym}</span>
        <span className="truncate text-[11px] text-zinc-500" title={d.team}>
          {shortTeam(d.team)}
        </span>
      </span>
    );
  };
  const rowClass = (n: number) => {
    const on = selected.includes(n);
    return `group relative w-full text-left ${on ? "bg-zinc-800/70" : "hover:bg-zinc-900"} ${!on && full ? "cursor-not-allowed" : ""}`;
  };
  const check = (n: number) => {
    const style = styles.get(n);
    return (
      <span aria-hidden className="absolute left-1 top-1/2 flex -translate-y-1/2 items-center">
        {style ? <Swatch color={style.color} dashed={style.dash.length > 0} width={12} /> : <span className="ml-0.5 h-3 w-3 rounded-full border border-zinc-600 opacity-0 group-hover:opacity-100" />}
      </span>
    );
  };

  /** Standings by best lap: a qualifying segment's, or practice's for the session. */
  const standings = (rows: Standing[], o: { what: string; countTitle: string; cutoff?: { at: number; label: string }; tyres?: boolean }) => {
    const cols = o.tyres ? "grid-cols-[26px_minmax(0,1fr)_60px_50px_34px_40px]" : "grid-cols-[26px_minmax(0,1fr)_62px_54px_36px]";
    const leader = rows[0]?.time ?? null;
    return (
      <>
        <div className={`${ROW} ${cols} border-b border-zinc-800 py-1.5 ${HEAD}`}>
          <span>Pos</span>
          <span>Driver</span>
          <span className="text-right">Best</span>
          <span className="text-right">Gap</span>
          {o.tyres && <span title="The tyre the best lap was set on, and its age">Tyre</span>}
          <span className="text-right" title={o.countTitle}>
            Laps
          </span>
        </div>
        {rows.map((r, i) => {
          const t = r.time;
          return (
            <div key={r.driver}>
              {o.cutoff && i === o.cutoff.at && <Cutoff label={o.cutoff.label} />}
              <div
                role="button"
                tabIndex={0}
                onClick={() => (t != null && !selected.includes(r.driver) ? pick(r.driver, r.lap) : toggle(r.driver))}
                onKeyDown={(e) => e.key === "Enter" && toggle(r.driver)}
                className={`${rowClass(r.driver)} ${ROW} ${cols} h-[30px] text-sm`}
                title={
                  selected.includes(r.driver)
                    ? "Remove from the comparison"
                    : t != null
                      ? `Compare ${session.drivers.get(r.driver)!.info.acronym}'s best ${o.what}lap (lap ${r.lap})`
                      : undefined
                }
              >
                {check(r.driver)}
                <span className="font-bold tabular-nums">{t != null ? i + 1 : "–"}</span>
                {driverCell(r.driver)}
                <span className={`text-right text-xs tabular-nums ${t == null ? "text-zinc-600" : i === 0 ? "text-fuchsia-400" : "text-zinc-200"}`}>{t != null ? lapTime(t) : "no time"}</span>
                <span className="text-right text-xs tabular-nums text-zinc-400">{t != null && leader != null && i > 0 ? `+${(t - leader).toFixed(3)}` : ""}</span>
                {o.tyres && <span className="flex items-center">{r.tyre && <TyreBadge compound={r.tyre.compound} age={r.tyre.age} size={14} />}</span>}
                <span className="text-right text-xs tabular-nums text-zinc-400" title={r.deleted.map((l) => `Lap ${l.lap}: ${l.reason.toLowerCase()}`).join("\n") || undefined}>
                  {r.count}
                  {r.deleted.length > 0 && <span className="ml-0.5 text-red-400">✕{r.deleted.length}</span>}
                </span>
              </div>
            </div>
          );
        })}
      </>
    );
  };

  let body: ReactNode;
  if (!q) {
    // Practice: the classification at the flag.
    const model = compareModel(meta)!;
    body = standings(
      model.classification.map((r) => ({ driver: r.driver, time: r.best, lap: r.lap, count: r.laps, deleted: r.deleted, tyre: r.lap != null ? model.tyre(r.driver, r.lap) : null })),
      { what: "", countTitle: "Laps run (lap times deleted)", tyres: true },
    );
  } else if (board === "result") {
    const cols = "grid-cols-[26px_minmax(0,1fr)_62px_62px_62px]";
    body = (
      <>
        <div className={`${ROW} ${cols} border-b border-zinc-800 py-1.5 ${HEAD}`}>
          <span>Pos</span>
          <span>Driver</span>
          {q.segments.map((s) => (
            <span key={s.number} className="text-right">
              {s.name}
            </span>
          ))}
        </div>
        {q.results.map((r, i) => {
          const prev = q.results[i - 1];
          const cut = r.eliminated != null && prev?.eliminated !== r.eliminated ? `Out in ${q.segments[r.eliminated - 1]?.name}` : null;
          return (
            <div key={r.driver}>
              {cut && <Cutoff label={cut} />}
              <div
                role="button"
                tabIndex={0}
                onClick={() => toggle(r.driver)}
                onKeyDown={(e) => e.key === "Enter" && toggle(r.driver)}
                className={`${rowClass(r.driver)} ${ROW} ${cols} h-[30px] text-sm`}
                title={selected.includes(r.driver) ? "Remove from the comparison" : full ? `Up to ${MAX_COMPARE} drivers` : "Add to the comparison"}
              >
                {check(r.driver)}
                <span className="font-bold tabular-nums">{r.position ?? "–"}</span>
                {driverCell(r.driver)}
                {q.segments.map((s, k) => {
                  const t = r.times[k];
                  const fastest = t != null && Math.abs(t - segBest[k]) < 1e-6;
                  return (
                    <button
                      key={s.number}
                      onClick={(e) => {
                        e.stopPropagation();
                        pick(r.driver, r.laps[k]);
                      }}
                      disabled={t == null}
                      className={`rounded px-0.5 text-right text-xs tabular-nums ${t == null ? "text-zinc-700" : fastest ? "text-fuchsia-400 hover:bg-zinc-700" : "text-zinc-300 hover:bg-zinc-700"}`}
                      title={t != null ? `Compare ${session.drivers.get(r.driver)!.info.acronym}'s ${s.name} lap (lap ${r.laps[k]})` : undefined}
                    >
                      {t != null ? lapTime(t) : "—"}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </>
    );
  } else {
    const k = board - 1;
    const seg = q.segments[k];
    const rows = q.results
      .filter((r) => r.eliminated == null || r.eliminated >= seg.number)
      .sort((a, b) => (a.times[k] ?? Infinity) - (b.times[k] ?? Infinity) || (a.position ?? 99) - (b.position ?? 99))
      .map((r) => {
        const own = q.laps.filter((l) => l.driver === r.driver && l.segment === seg.number && !l.afterFlag);
        return {
          driver: r.driver,
          time: r.times[k],
          lap: r.laps[k],
          count: own.filter((l) => l.kind === "push").length,
          deleted: own.flatMap((l) => (l.deleted ? [{ lap: l.lap, reason: l.deleted }] : [])),
        };
      });
    body = standings(rows, { what: `${seg.name} `, countTitle: "Timed push laps (deleted)", cutoff: seg.advance != null ? { at: seg.advance, label: `Out in ${seg.name}` } : undefined });
  }

  return (
    <div className="flex h-full flex-col text-sm">
      {q ? <Tabs session={session} /> : <Title>Classification</Title>}
      <div className="flex h-7 shrink-0 items-center border-b border-zinc-800 px-2 text-[11px] text-zinc-500">
        {selected.length > 0 ? (
          <span>
            Comparing <span className="font-semibold tabular-nums text-zinc-200">{selected.length}</span>/{MAX_COMPARE} · click a time to compare that lap
          </span>
        ) : (
          <span>Click drivers to compare (up to {MAX_COMPARE}), or a time for that lap</span>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto pb-2">{body}</div>
    </div>
  );
}
