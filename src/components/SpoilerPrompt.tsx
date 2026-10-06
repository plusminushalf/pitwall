import { useState } from "react";
import { useReplay } from "../store";

/** Whether the spoiler prompt is up: a race opened and no-spoiler mode not chosen for it yet. */
export const useSpoilerPrompt = () => useReplay((s) => s.noSpoilers === null && s.session != null && s.mode === "replay");

/**
 * Asked when a race opens (unless an answer is saved), over the blurred replay: hide what's ahead on the
 * timeline or not. Until answered the timeline hides it anyway, so nothing shows through the blur.
 */
export function SpoilerPrompt() {
  const open = useSpoilerPrompt();
  const meta = useReplay((s) => s.session?.meta);
  const [remember, setRemember] = useState(false);
  if (!open || !meta) return null;

  const choose = (hide: boolean) => {
    const s = useReplay.getState();
    if (remember) s.setSpoilerPref(hide ? "hide" : "show");
    s.setNoSpoilers(hide);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-950/60 px-4 backdrop-blur-xl">
      <div role="dialog" aria-modal="true" aria-labelledby="spoiler-prompt-title" className="w-full max-w-md rounded-lg border border-zinc-800 bg-zinc-900 p-5 shadow-2xl">
        <h1 id="spoiler-prompt-title" className="text-lg font-black tracking-tight text-zinc-100">
          Watch without spoilers?
        </h1>
        <p className="text-xs text-zinc-400">
          {meta.year} {meta.meetingName} · {meta.sessionName}
        </p>
        <p className="mt-2 text-sm leading-relaxed text-zinc-300">
          {meta.practice
            ? "The timeline will only show what you've watched so far. Red flags, VSCs, yellows and penalties stay hidden until you get to them."
            : "The timeline will only show what you've watched so far. Safety cars, retirements, penalties and the finish stay hidden until you get to them."}
        </p>
        <div className="mt-4 flex gap-2 max-md:flex-col">
          <button autoFocus onClick={() => choose(true)} className="flex-1 rounded bg-zinc-100 px-3 py-1.5 text-sm font-semibold text-zinc-900 hover:bg-white pointer-coarse:min-h-11">
            Hide spoilers
          </button>
          <button
            onClick={() => choose(false)}
            className="flex-1 rounded border border-zinc-700 px-3 py-1.5 text-sm font-semibold text-zinc-200 hover:border-zinc-500 hover:text-white pointer-coarse:min-h-11"
          >
            Show everything
          </button>
        </div>
        <label className="mt-4 flex cursor-pointer items-center gap-2 text-xs text-zinc-300 pointer-coarse:min-h-11">
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} className="accent-zinc-100 pointer-coarse:h-5 pointer-coarse:w-5" />
          Remember my choice for every session
        </label>
        <p className="mt-1 pl-5 text-[11px] text-zinc-400">You can change it in Settings on the home page.</p>
      </div>
    </div>
  );
}
