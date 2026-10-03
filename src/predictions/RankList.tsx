// Three teams to put in order: drag a row by its grip (mouse or finger), or move it with its arrows.

import { useRef, useState, type PointerEvent } from "react";
import { team, type TeamId } from "./model";

const ROW = 64; // px, row height + gap: drag maths assume every row is this tall
const ORDINAL = ["1st", "2nd", "3rd"];

export function RankList({ teams, onChange, label }: { teams: TeamId[]; onChange: (next: TeamId[]) => void; label: (i: number) => string }) {
  const [drag, setDrag] = useState<{ id: TeamId; startY: number; dy: number } | null>(null);
  const order = useRef(teams);
  order.current = teams;

  const move = (from: number, to: number) => {
    if (to < 0 || to >= teams.length || from === to) return;
    const next = [...teams];
    const [t] = next.splice(from, 1);
    next.splice(to, 0, t!);
    onChange(next);
  };

  const down = (e: PointerEvent, id: TeamId) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag({ id, startY: e.clientY, dy: 0 });
  };
  const moveTo = (e: PointerEvent) => {
    if (!drag) return;
    const dy = e.clientY - drag.startY;
    const from = order.current.indexOf(drag.id);
    const to = Math.max(0, Math.min(order.current.length - 1, from + Math.round(dy / ROW)));
    if (to !== from) {
      move(from, to);
      setDrag({ ...drag, startY: drag.startY + (to - from) * ROW, dy: dy - (to - from) * ROW });
    } else setDrag({ ...drag, dy });
  };
  const up = () => setDrag(null);

  return (
    <ol className="flex flex-col gap-2 select-none">
      {teams.map((id, i) => {
        const t = team(id);
        const dragging = drag?.id === id;
        return (
          <li
            key={id}
            className={`relative flex h-14 items-center gap-3 overflow-hidden rounded-md border bg-zinc-900 pr-1.5 transition-shadow ${dragging ? "z-10 border-zinc-500 shadow-2xl shadow-black" : "border-zinc-800"}`}
            style={{ transform: dragging ? `translateY(${drag.dy}px) scale(1.02)` : undefined, transition: dragging ? "none" : "transform 150ms" }}
          >
            <span className="h-full w-2 flex-none" style={{ background: t.colour }} />
            <span className="ci-display w-12 flex-none text-3xl font-black italic leading-none text-white">
              {i + 1}
              <span className="ml-0.5 align-top text-sm font-extrabold uppercase text-zinc-500">{ORDINAL[i]!.slice(1)}</span>
            </span>
            <span className="ci-display min-w-0 flex-1 truncate text-2xl font-extrabold uppercase italic leading-none text-white">{t.name}</span>
            <span className="sr-only">{label(i)}</span>
            <button type="button" className="ci-icon" aria-label={`Move ${t.name} up`} disabled={i === 0} onClick={() => move(i, i - 1)}>
              <svg viewBox="0 0 20 20" className="size-5">
                <path d="M5 12l5-5 5 5" />
              </svg>
            </button>
            <button type="button" className="ci-icon" aria-label={`Move ${t.name} down`} disabled={i === teams.length - 1} onClick={() => move(i, i + 1)}>
              <svg viewBox="0 0 20 20" className="size-5">
                <path d="M5 8l5 5 5-5" />
              </svg>
            </button>
            <span
              role="presentation"
              className="flex h-11 w-9 flex-none cursor-grab touch-none items-center justify-center text-zinc-500 active:cursor-grabbing"
              onPointerDown={(e) => down(e, id)}
              onPointerMove={moveTo}
              onPointerUp={up}
              onPointerCancel={up}
            >
              <svg viewBox="0 0 20 20" className="size-5 fill-current">
                {[6, 10, 14].flatMap((y) => [7, 13].map((x) => <circle key={`${x}${y}`} cx={x} cy={y} r="1.5" />))}
              </svg>
            </span>
          </li>
        );
      })}
    </ol>
  );
}
