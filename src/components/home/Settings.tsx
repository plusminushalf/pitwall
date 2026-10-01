import { useEffect, useRef, useState, type Ref } from "react";
import { createPortal } from "react-dom";
import { useReplay, type SpoilerPref } from "../../store";
import { useVaultAttention, VaultAccount } from "../vault/VaultStatus";
import { LABEL, SECONDARY } from "./common";

const SPOILER_OPTIONS: { value: SpoilerPref; label: string; hint: string }[] = [
  { value: "ask", label: "Ask each time", hint: "Opening a race asks whether to hide what's ahead on the timeline." },
  { value: "hide", label: "Always hide spoilers", hint: "The timeline shows only what you've watched so far." },
  { value: "show", label: "Always show everything", hint: "The whole race on the timeline from the start." },
];

type Position = { top: number; right: number };

/** Home's Settings button (top right) and its panel: spoilers when opening a race, and the OpenF1 account. */
export function Settings() {
  // Where the open panel goes (below the button, right-aligned to it); null while closed.
  const [at, setAt] = useState<Position | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const attention = useVaultAttention();

  const toggle = () => {
    const r = button.current?.getBoundingClientRect();
    setAt(at || !r ? null : { top: r.bottom + 8, right: window.innerWidth - r.right });
  };

  // Open: focus goes into the panel (its chosen spoiler option), so the keyboard doesn't have to travel the page to
  // reach it (it's portaled to the end of the body).
  const open = at != null;
  useEffect(() => {
    if (open) panel.current?.querySelector<HTMLElement>("input:checked, input, button")?.focus();
  }, [open]);

  // Closes on a click outside, Escape or a resize (not when focus moves to the vault's login window). Escape hands
  // focus back to the Settings button.
  useEffect(() => {
    if (!at) return;
    const close = () => setAt(null);
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!panel.current?.contains(t) && !button.current?.contains(t)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      close();
      button.current?.focus();
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", close);
    };
  }, [at]);

  return (
    <>
      <button
        ref={button}
        type="button"
        onClick={toggle}
        className={`${SECONDARY} flex shrink-0 items-center gap-1.5 px-3 py-1.5 ${at ? "bg-zinc-700 text-white" : ""}`}
        aria-expanded={at != null}
        aria-haspopup="dialog"
      >
        Settings
        {attention && <span className={`h-1.5 w-1.5 rounded-full ${attention}`} title="Your OpenF1 account needs attention" />}
      </button>
      {/* A portal, out of the header's stacking context: over the vault's debug panel and banners too. */}
      {at && createPortal(<SettingsPanel ref={panel} at={at} />, document.body)}
    </>
  );
}

function SettingsPanel({ ref, at }: { ref: Ref<HTMLDivElement>; at: Position }) {
  const pref = useReplay((s) => s.spoilerPref);
  return (
    <div
      ref={ref}
      role="dialog"
      aria-label="Settings"
      data-testid="settings-panel"
      className="fixed z-[60] w-80 space-y-4 rounded-lg border border-zinc-800 bg-zinc-900 p-4 shadow-2xl"
      style={at}
    >
      <fieldset>
        <legend className={LABEL}>Spoilers · when you open a race</legend>
        <div className="mt-2 space-y-1">
          {SPOILER_OPTIONS.map((o) => (
            <label key={o.value} className="flex cursor-pointer gap-2 rounded px-1.5 py-1 hover:bg-zinc-800/60">
              <input
                type="radio"
                name="spoiler-pref"
                value={o.value}
                checked={pref === o.value}
                onChange={() => useReplay.getState().setSpoilerPref(o.value)}
                className="mt-0.5 accent-zinc-100"
              />
              <span>
                <span className="block text-xs font-semibold text-zinc-200">{o.label}</span>
                <span className="block text-xs leading-snug text-zinc-400">{o.hint}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      <section className="border-t border-zinc-800 pt-3">
        <h2 className={`${LABEL} mb-2`}>OpenF1 account</h2>
        <VaultAccount />
      </section>
    </div>
  );
}
