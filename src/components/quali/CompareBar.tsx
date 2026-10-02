import { Icon } from "../../blockkit/ui/Icon";
import { TyreBadge } from "../../blockkit/ui/TyreBadge";
import type { CompareModel } from "../../data/compare";
import type { CompareEntry } from "../../hooks/useCompare";
import { lapTime } from "../../lib/format";
import { MAX_COMPARE, useQuali } from "../../qualiStore";
import { useReplay } from "../../store";
import { Swatch } from "./CompareCharts";

const age = (laps: number) => `${laps} ${laps === 1 ? "lap" : "laps"} old`;

function LapSelect({ model, e }: { model: CompareModel; e: CompareEntry }) {
  const groups = model.lapGroups(e.driver);
  return (
    <select
      value={e.lapNo ?? ""}
      onChange={(ev) => {
        ev.currentTarget.blur(); // keep the keyboard shortcuts working
        useQuali.getState().setLap(e.driver, Number(ev.target.value));
      }}
      className="max-w-44 cursor-pointer rounded bg-zinc-900 px-1 py-0.5 text-xs tabular-nums text-zinc-200 outline-none hover:bg-zinc-800 focus-visible:ring-1 focus-visible:ring-zinc-600"
      title={e.picked ? "Lap picked by hand" : model.presets.length > 1 ? "Default lap (see the presets); pick another to compare it" : "Their fastest lap; pick another to compare it"}
    >
      {e.lapNo == null && <option value="">no lap</option>}
      {groups.map((g) => (
        <optgroup key={g.name} label={g.name} className="bg-zinc-900">
          {g.laps.map((l) => {
            // Practice: the set's age too (the group says which compound; the badge beside it, the chosen lap's).
            const notes = [...l.notes, l.tyre ? age(l.tyre.age) : ""].filter(Boolean);
            return (
              <option key={l.lap} value={l.lap} className="bg-zinc-900">
                {`L${l.lap}  ${lapTime(l.duration)}${notes.length ? `  ${notes.join(", ")}` : ""}`}
              </option>
            );
          })}
        </optgroup>
      ))}
    </select>
  );
}

export function CompareBar({ model, entries }: { model: CompareModel; entries: CompareEntry[] }) {
  const preset = useQuali((s) => s.preset);
  const setPreset = useQuali((s) => s.setPreset);
  const { presets } = model;

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-zinc-800 px-3 py-2">
      {entries.map((e, i) => (
        <div key={e.driver} className="flex items-center gap-1.5 rounded border border-zinc-800 bg-zinc-900/60 py-0.5 pl-2 pr-1">
          <Swatch color={e.style.color} dashed={e.style.dash.length > 0} />
          <span className="text-sm font-bold tracking-wide" title={e.info.fullName}>
            {e.info.acronym}
          </span>
          {i === 0 ? (
            <span className="rounded bg-zinc-800 px-1 text-[9px] font-bold uppercase tracking-wider text-zinc-400" title="Deltas are measured against this lap">
              Ref
            </span>
          ) : (
            <button
              onClick={() => {
                const sel = useReplay.getState().selected;
                useReplay.setState({ selected: [e.driver, ...sel.filter((n) => n !== e.driver)] });
              }}
              className="rounded px-1 text-[9px] font-bold uppercase tracking-wider text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
              title="Measure deltas against this lap"
            >
              Set ref
            </button>
          )}
          <LapSelect model={model} e={e} />
          {e.tyre && (
            <span className="flex items-center" title={`${e.tyre.compound.charAt(0)}${e.tyre.compound.slice(1).toLowerCase()}, ${age(e.tyre.age)} at the start of the lap`}>
              <TyreBadge compound={e.tyre.compound} age={e.tyre.age} size={16} />
            </span>
          )}
          {e.deleted && (
            <span className="text-[10px] font-semibold text-red-400" title={`Lap time deleted: ${e.deleted.toLowerCase()}`}>
              deleted
            </span>
          )}
          {e.loading && <span className="text-[10px] text-zinc-500">loading…</span>}
          {!e.loading && e.lapNo != null && !e.trace && <span className="text-[10px] text-amber-400">no telemetry</span>}
          <button
            onClick={() => useReplay.getState().toggleSelected(e.driver)}
            className="flex h-5 w-5 items-center justify-center rounded text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
            aria-label={`Remove ${e.info.acronym}`}
            title="Remove from the comparison"
          >
            <Icon name="close" size={12} />
          </button>
        </div>
      ))}
      {entries.length < MAX_COMPARE && <span className="text-[11px] text-zinc-600">{entries.length ? "+ add drivers from the board" : "Pick drivers on the board to compare"}</span>}
      {presets.length > 1 && (
        <div className="ml-auto flex items-center gap-2">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Laps</span>
          <div className="flex overflow-hidden rounded border border-zinc-800 text-xs">
            {presets.map((p) => (
              <button
                key={p.id}
                onClick={() => setPreset(p.id)}
                className={`px-2 py-0.5 ${preset === p.id ? "bg-zinc-100 font-bold text-zinc-900" : "text-zinc-400 hover:bg-zinc-800"}`}
                title={p.title}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
