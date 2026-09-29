import { useMemo } from "react";
import type { Session } from "../../data/session";
import { compareStyles } from "../../lib/compareColors";
import { lapTime, shortTeam, teamColor } from "../../lib/format";
import { MAX_COMPARE, useQuali, type BoardTab } from "../../qualiStore";
import { useReplay } from "../../store";
import type { QualiResult } from "../../types";
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
  const q = meta.quali!;
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

  const segBest = q.segments.map((_, k) => Math.min(...q.results.map((r) => r.times[k] ?? Infinity)));
  const full = selected.length >= MAX_COMPARE;

  const driverCell = (r: QualiResult) => {
    const d = session.drivers.get(r.driver)!.info;
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

  let body: React.ReactNode;
  if (board === "result") {
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
                {driverCell(r)}
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
    const cols = "grid-cols-[26px_minmax(0,1fr)_62px_54px_36px]";
    const rows = q.results
      .filter((r) => r.eliminated == null || r.eliminated >= seg.number)
      .sort((a, b) => (a.times[k] ?? Infinity) - (b.times[k] ?? Infinity) || (a.position ?? 99) - (b.position ?? 99));
    const leader = rows[0]?.times[k] ?? null;
    body = (
      <>
        <div className={`${ROW} ${cols} border-b border-zinc-800 py-1.5 ${HEAD}`}>
          <span>Pos</span>
          <span>Driver</span>
          <span className="text-right">Best</span>
          <span className="text-right">Gap</span>
          <span className="text-right" title="Timed push laps (deleted)">Laps</span>
        </div>
        {rows.map((r, i) => {
          const t = r.times[k];
          const own = q.laps.filter((l) => l.driver === r.driver && l.segment === seg.number && !l.afterFlag);
          const push = own.filter((l) => l.kind === "push").length;
          const deleted = own.filter((l) => l.deleted);
          return (
            <div key={r.driver}>
              {seg.advance != null && i === seg.advance && <Cutoff label={`Out in ${seg.name}`} />}
              <div
                role="button"
                tabIndex={0}
                onClick={() => (t != null && !selected.includes(r.driver) ? pick(r.driver, r.laps[k]) : toggle(r.driver))}
                onKeyDown={(e) => e.key === "Enter" && toggle(r.driver)}
                className={`${rowClass(r.driver)} ${ROW} ${cols} h-[30px] text-sm`}
                title={
                  selected.includes(r.driver)
                    ? "Remove from the comparison"
                    : t != null
                      ? `Compare ${session.drivers.get(r.driver)!.info.acronym}'s best ${seg.name} lap (lap ${r.laps[k]})`
                      : undefined
                }
              >
                {check(r.driver)}
                <span className="font-bold tabular-nums">{t != null ? i + 1 : "–"}</span>
                {driverCell(r)}
                <span className={`text-right text-xs tabular-nums ${t == null ? "text-zinc-600" : i === 0 ? "text-fuchsia-400" : "text-zinc-200"}`}>{t != null ? lapTime(t) : "no time"}</span>
                <span className="text-right text-xs tabular-nums text-zinc-400">{t != null && leader != null && i > 0 ? `+${(t - leader).toFixed(3)}` : ""}</span>
                <span className="text-right text-xs tabular-nums text-zinc-400" title={deleted.map((l) => `Lap ${l.lap}: ${l.deleted?.toLowerCase()}`).join("\n") || undefined}>
                  {push}
                  {deleted.length > 0 && <span className="ml-0.5 text-red-400">✕{deleted.length}</span>}
                </span>
              </div>
            </div>
          );
        })}
      </>
    );
  }

  return (
    <div className="flex h-full flex-col text-sm">
      <Tabs session={session} />
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
