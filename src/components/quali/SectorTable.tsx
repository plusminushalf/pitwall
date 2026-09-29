import { topSpeed } from "../../engine/compare";
import type { CompareEntry } from "../../hooks/useCompare";
import { lapTime } from "../../lib/format";
import { Swatch } from "./CompareCharts";

const LABEL = "text-[10px] font-semibold uppercase tracking-wider text-zinc-500";
const EPS = 1e-6;

interface Row {
  label: string;
  title?: string;
  values: (number | null)[];
  better: "low" | "high";
  format: (v: number) => string;
  gap: (v: number, best: number) => string;
}

export function SectorTable({ entries }: { entries: CompareEntry[] }) {
  if (!entries.length) return null;
  const sector = (k: number) => entries.map((e) => e.lap?.sectors[k] ?? null);
  const trap = (k: "i1" | "i2" | "st") => entries.map((e) => e.lap?.speedTrap[k] ?? null);
  const timeGap = (v: number, best: number) => `+${(v - best).toFixed(3)}`;
  const speedGap = (v: number, best: number) => `−${Math.round(best - v)}`;
  const rows: Row[] = [
    { label: "S1", values: sector(0), better: "low", format: lapTime, gap: timeGap },
    { label: "S2", values: sector(1), better: "low", format: lapTime, gap: timeGap },
    { label: "S3", values: sector(2), better: "low", format: lapTime, gap: timeGap },
    { label: "Lap", values: entries.map((e) => e.lap?.duration ?? null), better: "low", format: lapTime, gap: timeGap },
    { label: "I1", title: "Speed at intermediate 1 (km/h)", values: trap("i1"), better: "high", format: (v) => String(v), gap: speedGap },
    { label: "I2", title: "Speed at intermediate 2 (km/h)", values: trap("i2"), better: "high", format: (v) => String(v), gap: speedGap },
    { label: "Trap", title: "Speed trap (km/h)", values: trap("st"), better: "high", format: (v) => String(v), gap: speedGap },
    {
      label: "Top",
      title: "Highest speed on the lap (km/h, from the car data)",
      values: entries.map((e) => (e.trace ? topSpeed(e.trace).speed : null)),
      better: "high",
      format: (v) => String(Math.round(v)),
      gap: speedGap,
    },
  ];
  const ideal = [0, 1, 2].map((k) => sector(k));

  return (
    <div className="shrink-0 border-t border-zinc-800 px-3 py-2">
      <div className="grid items-center gap-x-2 gap-y-1 text-xs tabular-nums" style={{ gridTemplateColumns: `36px repeat(${entries.length}, minmax(0, 1fr))` }}>
        <span className={LABEL}>Sector</span>
        {entries.map((e, i) => (
          <span key={e.driver} className="flex min-w-0 items-center justify-end gap-1 font-bold text-zinc-100" title={`${e.info.fullName} · lap ${e.lapNo ?? "–"}`}>
            <Swatch color={e.style.color} dashed={e.style.dash.length > 0} width={12} />
            {e.info.acronym}
            {i === 0 && <span className="text-[9px] font-semibold text-zinc-500">REF</span>}
          </span>
        ))}
        {rows.map((r) => {
          const present = r.values.filter((v): v is number => v != null);
          const best = present.length ? (r.better === "low" ? Math.min(...present) : Math.max(...present)) : null;
          const isTime = r.better === "low";
          return (
            <div key={r.label} className={`contents ${r.label === "I1" ? "[&>*]:mt-1.5" : ""}`}>
              <span className={LABEL} title={r.title}>
                {r.label}
              </span>
              {r.values.map((v, i) => {
                const top = v != null && best != null && Math.abs(v - best) < EPS && present.length > 1;
                return (
                  <span key={i} className="flex min-w-0 flex-col items-end leading-tight">
                    <span className={top ? "font-semibold text-fuchsia-400" : v == null ? "text-zinc-600" : isTime ? "text-zinc-200" : "text-zinc-300"}>
                      {v == null ? "—" : r.format(v)}
                    </span>
                    {v != null && best != null && !top && present.length > 1 && <span className="text-[10px] text-zinc-500">{r.gap(v, best)}</span>}
                  </span>
                );
              })}
            </div>
          );
        })}
      </div>
      {entries.length > 1 && ideal.every((s) => s.some((v) => v != null)) && (
        <p className="mt-2 text-[10px] text-zinc-500">
          Best of these sectors combined:{" "}
          <span className="tabular-nums text-zinc-300">
            {lapTime(ideal.reduce((sum, s) => sum + Math.min(...s.filter((v): v is number => v != null)), 0))}
          </span>{" "}
          · purple marks the fastest of the compared laps
        </p>
      )}
    </div>
  );
}
