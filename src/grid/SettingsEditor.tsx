// The generic settings editor behind a block's ⚙ (H3.10): one control per setting the block shows
// (settingField), over its defaults with the layout's settings on top.

import { settingField, type BlockDefinition, type BlockSettings, type SettingField, type SettingValue } from "../blockkit/defineBlock";
import type { DriverInfo } from "../types";

const LABEL = "text-[10px] font-semibold uppercase tracking-wider text-zinc-500";
const INPUT = "w-full rounded bg-zinc-800 px-2 py-1 text-xs text-zinc-100 outline-none focus-visible:ring-1 focus-visible:ring-zinc-600";

/** The settings a block's editor shows, in the order the block declares them. */
export function shownFields(block: BlockDefinition<any>): [string, SettingField][] {
  return Object.keys(block.settings).flatMap((key) => {
    const field = settingField(block, key);
    return field ? [[key, field] as [string, SettingField]] : [];
  });
}

function Field({ field, value, drivers, onChange }: { field: SettingField; value: SettingValue; drivers: readonly DriverInfo[]; onChange: (v: SettingValue) => void }) {
  switch (field.kind) {
    case "choice":
      return (
        <div className="flex rounded-md bg-zinc-800 p-0.5" role="radiogroup" aria-label={field.label}>
          {field.options.map((o) => (
            <button
              key={String(o.value)}
              type="button"
              role="radio"
              aria-checked={o.value === value}
              onClick={() => onChange(o.value)}
              className={`flex-1 whitespace-nowrap rounded px-2 py-0.5 text-xs font-semibold ${
                o.value === value ? "bg-zinc-600 text-zinc-50" : "text-zinc-400 hover:text-zinc-100"
              }`}
            >
              {o.label}
            </button>
          ))}
        </div>
      );
    case "toggle":
      return (
        <button
          type="button"
          role="switch"
          aria-checked={value === true}
          aria-label={field.label}
          onClick={() => onChange(value !== true)}
          className={`relative h-4 w-7 rounded-full transition-colors ${value === true ? "bg-zinc-300" : "bg-zinc-700"}`}
        >
          <span className={`absolute top-0.5 h-3 w-3 rounded-full bg-zinc-950 transition-[left] ${value === true ? "left-3.5" : "left-0.5"}`} />
        </button>
      );
    case "number":
      return (
        <input
          type="number"
          aria-label={field.label}
          value={typeof value === "number" ? value : ""}
          min={field.min}
          max={field.max}
          step={field.step}
          onChange={(e) => {
            const n = e.currentTarget.valueAsNumber;
            if (Number.isFinite(n)) onChange(Math.min(Math.max(n, field.min ?? -Infinity), field.max ?? Infinity));
          }}
          className={`${INPUT} tabular-nums`}
        />
      );
    case "driver":
      return (
        <select
          aria-label={field.label ?? "Driver"}
          value={typeof value === "number" ? String(value) : "follow-selection"}
          onChange={(e) => onChange(e.currentTarget.value === "follow-selection" ? "follow-selection" : Number(e.currentTarget.value))}
          className={`${INPUT} cursor-pointer`}
        >
          <option value="follow-selection" className="bg-zinc-900">
            Follow selection
          </option>
          {typeof value === "number" && !drivers.some((d) => d.number === value) && (
            <option value={String(value)} className="bg-zinc-900">
              Pinned to #{value}
            </option>
          )}
          {drivers.map((d) => (
            <option key={d.number} value={String(d.number)} className="bg-zinc-900">
              Pinned to #{d.number} · {d.acronym}
            </option>
          ))}
        </select>
      );
  }
}

export function SettingsEditor({
  block,
  settings,
  drivers,
  onChange,
}: {
  block: BlockDefinition<any>;
  settings: Partial<BlockSettings>;
  drivers: readonly DriverInfo[];
  onChange: (settings: Partial<BlockSettings>) => void;
}) {
  const values: BlockSettings = { ...block.settings, ...settings };
  return (
    <div className="flex flex-col gap-3">
      {shownFields(block).map(([key, field]) => (
        <div key={key} className={field.kind === "toggle" ? "flex items-center justify-between gap-3" : "flex flex-col gap-1.5"}>
          <span className={LABEL}>{field.label ?? "Driver"}</span>
          <Field field={field} value={values[key]} drivers={drivers} onChange={(v) => onChange({ ...settings, [key]: v })} />
        </div>
      ))}
    </div>
  );
}
