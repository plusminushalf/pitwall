import { useState } from "react";
import {
  defineWidget,
  Icon,
  TAP_CLASS,
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
} from "widget-kit";

/** Lines of text in a text-sm widget (line height 20/14 of the font size). */
const line = (fontSize: number) => (fontSize * 20) / 14;
/** The focus chips' row: py-1.5, a 20 px chip and the hairline under it. */
const CHIPS_H = 12 + 20 + 1;
/** py-2 around the headshot's 48 px, or the name (text-lg, tight), full name (text-xs) and team if taller. */
const HEAD_H = 16 + Math.max(48, 18 * 1.25 + 16 + line(11));
/** The hint under the header with one driver selected: mt-1 and two lines of 11 px text. */
const HINT_H = 4 + 2 * line(11);
/** Pinned to a driver in this race: the widget ignores the selection, so it has no chips, hint or clear. */
const pinnedIn = (setting: DriverSetting, drivers: readonly DriverInfo[]) => typeof setting === "number" && drivers.some((d) => d.number === setting);

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
            <span className="text-zinc-600">–</span>
          )}
          <span className="text-zinc-400"> grid P{s.gridPosition}</span>
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
            className={`${TAP_CLASS} shrink-0 rounded border px-1.5 text-[11px] font-bold leading-[18px] tracking-wide ${active ? "" : "text-zinc-300 hover:bg-zinc-800 hover:text-white"}`}
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

  const pinned = pinnedIn(setting, drivers);
  const following = focused === s.driver;
  // The same tests as the widget's height (below), so there's room for them exactly when they're shown.
  const chips = selected.length > 0 && !pinned;
  const hint = focused == null && !pinned && selected.length === 1;
  const canClear = !pinned && (following || selected.length > 0);
  const color = teamColor(info.teamColour || "71717a");

  return (
    <section className="flex h-full flex-col text-sm">
      {chips && <FocusChips drivers={drivers} selected={selected} focused={focused} onFocus={focus} />}
      {/* Flat, like every panel: the team colour is data, the stripe the tower gives each driver. */}
      <div className="min-h-0 flex-1 px-3 py-2">
        <div className="flex items-center gap-3">
          <Headshot key={info.number} url={info.headshotUrl} color={color} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="h-4 w-1 shrink-0 rounded-sm" style={{ background: color }} />
              <span className="text-lg font-bold leading-tight tracking-wide">{info.acronym}</span>
              <span className="text-xs tabular-nums text-zinc-400">#{info.number}</span>
              {s.status !== "RUNNING" && <span className={`rounded px-1.5 text-[11px] font-bold leading-4 ${STATUS_PILL[s.status]}`}>{s.status}</span>}
            </div>
            <div className="truncate text-xs text-zinc-300">{info.fullName}</div>
            <div className="truncate text-[11px] text-zinc-400">{info.team}</div>
          </div>
          <Position s={s} />
          {canClear && (
            <button
              onClick={clear}
              className={`${TAP_CLASS} -mr-1 flex h-5 w-5 shrink-0 items-center justify-center self-start rounded text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100`}
              title="Clear selection (show everyone on the map and the leader here)"
              aria-label="Clear driver selection"
            >
              <Icon name="close" size={12} />
            </button>
          )}
        </div>
        {hint && <p className="mt-1 line-clamp-2 text-[11px] text-zinc-400">Showing the selected driver · pick the chip to highlight on the map</p>}
      </div>
    </section>
  );
}

export default defineWidget({
  id: "driver-header",
  name: "Driver",
  description: "Headshot, name, team and position of the driver it shows, with focus chips for the selection.",
  version: "1.0.0",
  // The focus chips with a selection, unless pinned; the hint with one driver selected, unless it's focused or pinned.
  height: ({ drivers, selection: { selected, focused }, settings }) => {
    const pinned = pinnedIn(settings.driver, drivers);
    return (selected.length > 0 && !pinned ? CHIPS_H : 0) + HEAD_H + (focused == null && !pinned && selected.length === 1 ? HINT_H : 0);
  },
  width: { min: 15, default: 21, max: 40 },
  sessions: ["race", "practice"],
  settings: { driver: "follow-selection" as DriverSetting },
  Component: DriverHeader,
});
