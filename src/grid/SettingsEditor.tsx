// The generic settings editor behind a widget's ⚙ (H3.10): one control per setting the widget shows
// (settingField), over its defaults with the layout's settings on top.

import { settingField, type WidgetDefinition, type WidgetSettings, type SettingField, type SettingValue } from "../widgetkit/defineWidget";
import { LABEL_CLASS } from "../widgetkit/ui/Label";
import type { DriverInfo } from "../types";

const INPUT = "w-full rounded bg-zinc-800 px-2 py-1 text-xs text-zinc-100";

/** The settings a widget's editor shows, in the order the widget declares them. */
export function shownFields(widget: WidgetDefinition<any>): [string, SettingField][] {
  return Object.keys(widget.settings).flatMap((key) => {
    const field = settingField(widget, key);
    return field ? [[key, field] as [string, SettingField]] : [];
  });
}

function Field({
  field,
  value,
  drivers,
  showing,
  onChange,
}: {
  field: SettingField;
  value: SettingValue;
  drivers: readonly DriverInfo[];
  showing: () => number | null;
  onChange: (v: SettingValue) => void;
}) {
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
    case "driver": {
      const pinned = typeof value === "number" ? value : null;
      return (
        <div className="flex flex-col gap-1.5">
          <div className="flex rounded-md bg-zinc-800 p-0.5" role="radiogroup" aria-label={field.label ?? "Driver"}>
            {[
              { label: "Selected driver", on: pinned == null, pick: () => onChange("follow-selection") },
              // Pinning starts with whoever the widget shows now.
              { label: "Pinned", on: pinned != null, pick: () => pinned == null && onChange(showing() ?? drivers[0]?.number ?? "follow-selection") },
            ].map((o) => (
              <button
                key={o.label}
                type="button"
                role="radio"
                aria-checked={o.on}
                onClick={o.pick}
                className={`flex-1 whitespace-nowrap rounded px-2 py-0.5 text-xs font-semibold ${o.on ? "bg-zinc-600 text-zinc-50" : "text-zinc-400 hover:text-zinc-100"}`}
              >
                {o.label}
              </button>
            ))}
          </div>
          {pinned == null ? (
            <p className="text-[11px] leading-snug text-zinc-400">Follows the drivers you click in the tower or on the map.</p>
          ) : (
            <>
              <select
                aria-label="Pinned driver"
                value={String(pinned)}
                onChange={(e) => onChange(Number(e.currentTarget.value))}
                className={`${INPUT} cursor-pointer`}
              >
                {!drivers.some((d) => d.number === pinned) && (
                  <option value={String(pinned)} className="bg-zinc-900">
                    #{pinned} · not in this race
                  </option>
                )}
                {drivers.map((d) => (
                  <option key={d.number} value={String(d.number)} className="bg-zinc-900">
                    #{d.number} · {d.acronym} · {d.team}
                  </option>
                ))}
              </select>
              <p className="text-[11px] leading-snug text-zinc-400">Always this driver, whatever you select. In a race without them, it follows the selection.</p>
            </>
          )}
        </div>
      );
    }
  }
}

export function SettingsEditor({
  widget,
  settings,
  drivers,
  showing,
  onChange,
}: {
  widget: WidgetDefinition<any>;
  settings: Partial<WidgetSettings>;
  drivers: readonly DriverInfo[];
  /** Who the widget shows now when it follows the selection: who a driver setting pins when switched to "Pinned". */
  showing: () => number | null;
  onChange: (settings: Partial<WidgetSettings>) => void;
}) {
  const values: WidgetSettings = { ...widget.settings, ...settings };
  return (
    <div className="flex flex-col gap-3">
      {shownFields(widget).map(([key, field]) => (
        <div key={key} className={field.kind === "toggle" ? "flex items-center justify-between gap-3" : "flex flex-col gap-1.5"}>
          <span className={LABEL_CLASS}>{field.label ?? "Driver"}</span>
          <Field field={field} value={values[key]} drivers={drivers} showing={showing} onChange={(v) => onChange({ ...settings, [key]: v })} />
        </div>
      ))}
    </div>
  );
}
