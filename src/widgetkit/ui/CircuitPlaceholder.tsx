import type { CircuitRaces } from "../circuit";

/**
 * What a circuit widget shows until it can show races: the calendar or the races loading, none there yet, results
 * hidden (spoilers) with the button that shows them, or why they didn't load. `what` names what's hidden ("Safety cars").
 */
export function CircuitPlaceholder({ data, what }: { data: CircuitRaces; what: string }) {
  const at = data.circuit ? ` at ${data.circuit}` : "";
  let text: string;
  if (data.errors.length && !data.races.length && !data.pending) text = data.errors[0];
  else if (data.total === 0) text = data.ready ? `No earlier races${at} in OpenF1's data (it starts in 2023).` : "Loading the calendar…";
  else if (data.hidden)
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-3 text-center text-xs text-zinc-300">
        <p>
          {what}
          {at} give away how races ended.
        </p>
        <button type="button" onClick={data.reveal} className="rounded-md bg-zinc-800 px-2.5 py-1 text-xs font-semibold text-zinc-100 hover:bg-zinc-700 hover:text-white">
          Show
        </button>
      </div>
    );
  else text = `Loading ${data.total} earlier ${data.total === 1 ? "race" : "races"}${at} from OpenF1…`;
  return <div className="flex h-full items-center justify-center px-3 text-center text-xs text-zinc-400">{text}</div>;
}

