import { useState } from "react";
import {
  defineBlock,
  teamColor,
  textOn,
  useDriver,
  useDrivers,
  useSelectedDriver,
  useSelection,
  useSettings,
  type DriverInfo,
  type DriverSetting,
  type DriverState,
  type DriverStatus,
} from "block-kit";

/** Lines of text in a text-sm block (line height 20/14 of the font size). */
const line = (fontSize: number) => (fontSize * 20) / 14;
/** The focus chips' row: py-1.5, a 20 px chip and the hairline under it. */
const CHIPS_H = 12 + 20 + 1;
/** py-2 around the headshot's 48 px, or the name (text-lg, tight), full name (text-xs) and team if taller. */
const HEAD_H = 16 + Math.max(48, 18 * 1.25 + 16 + line(11));
/** The hint under the header: mt-1 and lines of 10 px text (the hints with a selection take two). */
const hintHeight = (lines: number) => 4 + lines * line(10);

const STATUS_PILL: Record<Exclude<DriverStatus, "RUNNING">, string> = {
  PIT: "bg-zinc-200 text-zinc-900",
  OUT: "bg-red-500/20 text-red-400",
  FINISHED: "bg-white text-black",
};

function Headshot({ url, color }: { url: string | null; color: string }) {
  const [failed, setFailed] = useState(false);
  if (!url || failed) return null;
  return (
    <img
      src={url}
      alt=""
      onError={() => setFailed(true)}
      className="h-12 w-12 shrink-0 rounded-md object-cover object-top"
      style={{ background: `${color}40` }}
    />
  );
}

function Position({ s }: { s: Pick<DriverState, "status" | "position" | "gridPosition"> }) {
  const out = s.status === "OUT";
  const delta = s.gridPosition != null && s.position != null ? s.gridPosition - s.position : null;
  return (
    <div className="shrink-0 text-right">
      <div className="text-2xl font-bold leading-none tabular-nums">{out || s.position == null ? "–" : `P${s.position}`}</div>
      {!out && delta != null && (
        <div className="mt-1 text-[10px] tabular-nums">
          {delta > 0 ? (
            <span className="text-emerald-400">▲{delta}</span>
          ) : delta < 0 ? (
            <span className="text-red-400">▼{-delta}</span>
          ) : (
            <span className="text-zinc-500">–</span>
          )}
          <span className="text-zinc-500"> grid P{s.gridPosition}</span>
        </div>
      )}
    </div>
  );
}

/** Focuses one of the selected drivers (ringed on the map, shown here); clicking the active chip unfocuses. */
function FocusChips({ drivers, selected, focused, onFocus }: { drivers: readonly DriverInfo[]; selected: readonly number[]; focused: number | null; onFocus: (n: number | null) => void }) {
  return (
    <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-zinc-800 px-3 py-1.5 [scrollbar-width:none]">
      {selected.map((n) => {
        const info = drivers.find((d) => d.number === n);
        if (!info) return null;
        const color = teamColor(info.teamColour || "71717a");
        const active = n === focused;
        return (
          <button
            key={n}
            onClick={() => onFocus(active ? null : n)}
            aria-pressed={active}
            className={`shrink-0 rounded border px-1.5 text-[11px] font-bold leading-[18px] tracking-wide ${active ? "" : "text-zinc-300 hover:bg-zinc-800 hover:text-white"}`}
            style={active ? { background: color, borderColor: color, color: textOn(info.teamColour) } : { borderColor: `${color}99` }}
            title={active ? `Stop highlighting ${info.fullName}` : `Highlight ${info.fullName} on the map`}
          >
            {info.acronym}
          </button>
        );
      })}
    </div>
  );
}

function DriverHeader() {
  const n = useSelectedDriver();
  const s = useDriver(n, (d) => ({ driver: d.driver, status: d.status, position: d.position, gridPosition: d.gridPosition }));
  const drivers = useDrivers();
  const { selected, focused, focus, clear } = useSelection();
  const [{ driver: setting }] = useSettings<{ driver: DriverSetting }>();
  const info = drivers.find((d) => d.number === n);
  if (!s || !info) return null;

  const following = focused === s.driver;
  // The same test as the block's height (below), so there's room for it exactly when it's shown.
  const hint =
    focused != null || typeof setting === "number"
      ? null
      : selected.length === 0
        ? "Showing the leader · click a car or row to select drivers"
        : selected.length === 1
          ? "Showing the selected driver · pick the chip to highlight on the map"
          : "Showing the highest-placed selected driver · pick a chip to highlight on the map";
  const canClear = following || selected.length > 0;
  const color = teamColor(info.teamColour || "71717a");

  return (
    <section className="flex h-full flex-col text-sm">
      {selected.length > 0 && <FocusChips drivers={drivers} selected={selected} focused={focused} onFocus={focus} />}
      {/* Flat: the screen before blocks faded this from the team colour (no gradients now). */}
      <div className="min-h-0 flex-1 border-l-[3px] px-3 py-2" style={{ borderLeftColor: color, background: `linear-gradient(90deg, ${color}2e, transparent 70%)` }}>
        <div className="flex items-center gap-3">
          <Headshot key={info.number} url={info.headshotUrl} color={color} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="text-lg font-bold leading-tight tracking-wide">{info.acronym}</span>
              <span className="text-xs tabular-nums text-zinc-500">#{info.number}</span>
              {s.status !== "RUNNING" && <span className={`rounded px-1.5 text-[10px] font-bold leading-4 ${STATUS_PILL[s.status]}`}>{s.status}</span>}
            </div>
            <div className="truncate text-xs text-zinc-300">{info.fullName}</div>
            <div className="truncate text-[11px] text-zinc-500">{info.team}</div>
          </div>
          <Position s={s} />
          {canClear && (
            <button
              onClick={clear}
              className="-mr-1 self-start rounded px-1 text-base leading-none text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
              title="Clear selection (show everyone on the map and the leader here)"
              aria-label="Clear driver selection"
            >
              ×
            </button>
          )}
        </div>
        {hint && <p className={`mt-1 text-[10px] text-zinc-500 ${selected.length > 0 ? "line-clamp-2" : "truncate"}`}>{hint}</p>}
      </div>
    </section>
  );
}

export default defineBlock({
  id: "driver-header",
  name: "Driver",
  description: "Headshot, name, team and position of the driver it shows, with focus chips for the selection.",
  version: "1.0.0",
  // The focus chips with a selection; the hint unless a focused or pinned driver is shown.
  height: ({ selection: { selected, focused }, settings }) =>
    (selected.length > 0 ? CHIPS_H : 0) + HEAD_H + (focused != null || typeof settings.driver === "number" ? 0 : hintHeight(selected.length > 0 ? 2 : 1)),
  width: { min: 15, default: 21, max: 40 },
  sessions: ["race"],
  settings: { driver: "follow-selection" as DriverSetting },
  Component: DriverHeader,
});
