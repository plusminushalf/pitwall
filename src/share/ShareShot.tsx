// Share a screenshot (S, or the Share button): the screen is frozen as it is, the user drags out an area, clicks a
// widget or panel (anything marked data-widget / data-shot), or presses Enter for all of it, and the area is copied
// to the clipboard as a PNG with Pitwall's name and address underneath. A toast then offers the link to this moment
// (share/link.ts) and the image to save.

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { create } from "zustand";
import { useReplay } from "../store";
import { Icon } from "../widgetkit/ui/Icon";
import { brandedImage, captureApp, clampArea, IGNORE, type Rect, type Shot } from "./capture";
import { shareLink, siteOrigin } from "./link";

/** A drag shorter than this (CSS px) is a click. */
const DRAG_PX = 4;
const TOAST_MS = 20_000;

interface Result {
  id: number;
  /** The image, once made (an object URL), and the file it saves as. */
  image: string | null;
  blob: Blob | null;
  fileName: string;
  link: string | null;
  copied: "pending" | "yes" | "no";
  error?: string;
}

type Phase = { kind: "idle" } | { kind: "capturing" } | { kind: "picking"; shot: Shot; image: string; link: Promise<string | null>; fileName: string };

interface ShareState {
  phase: Phase;
  result: Result | null;
  /** Freezes the screen and opens the picker. */
  start: () => void;
  /** Shares `area` of the frozen screen (all of it if null). Called from the pointer or key event, so the clipboard takes it. */
  pick: (area: Rect | null) => void;
  cancel: () => void;
  dismiss: () => void;
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

let nextId = 1;

export const useShare = create<ShareState>((set, get) => {
  const update = (id: number, patch: Partial<Result>) => {
    const r = get().result;
    if (r?.id === id) set({ result: { ...r, ...patch } });
  };
  const clearResult = () => {
    const r = get().result;
    if (r?.image) URL.revokeObjectURL(r.image);
    set({ result: null });
  };
  return {
    phase: { kind: "idle" },
    result: null,
    start: () => {
      const s = useReplay.getState();
      if (get().phase.kind !== "idle" || !s.session || s.view !== "replay") return;
      const meta = s.session.meta;
      // The link is to the moment the key was pressed.
      const link = shareLink().catch(() => null);
      const fileName = `pitwall-${slug(`${meta.year} ${meta.meetingName} ${meta.sessionName}`)}-${Math.floor(s.t / 1000)}.png`;
      clearResult();
      set({ phase: { kind: "capturing" } });
      captureApp()
        .then(async (shot) => {
          const blob = await new Promise<Blob | null>((resolve) => shot.canvas.toBlob(resolve, "image/png"));
          if (!blob) throw new Error("The screen couldn't be captured");
          if (get().phase.kind !== "capturing") return;
          set({ phase: { kind: "picking", shot, image: URL.createObjectURL(blob), link, fileName } });
        })
        .catch((e) => {
          console.error("Screenshot failed", e);
          set({ phase: { kind: "idle" }, result: { id: nextId++, image: null, blob: null, fileName, link: null, copied: "no", error: "The screen couldn't be captured." } });
          void link.then((l) => update(get().result!.id, { link: l }));
        });
    },
    pick: (area) => {
      const phase = get().phase;
      if (phase.kind !== "picking") return;
      const image = brandedImage(phase.shot, clampArea(phase.shot, area), new URL(siteOrigin()).host);
      // Straight away, inside the click or key press: browsers only let a page write to the clipboard from one.
      let copied: Promise<boolean>;
      try {
        copied = navigator.clipboard.write([new ClipboardItem({ "image/png": image })]).then(
          () => true,
          () => false,
        );
      } catch {
        copied = Promise.resolve(false);
      }
      URL.revokeObjectURL(phase.image);
      const id = nextId++;
      set({ phase: { kind: "idle" }, result: { id, image: null, blob: null, fileName: phase.fileName, link: null, copied: "pending" } });
      image.then(
        (blob) => update(id, { blob, image: URL.createObjectURL(blob) }),
        () => update(id, { error: "The image couldn't be made." }),
      );
      void copied.then((ok) => update(id, { copied: ok ? "yes" : "no" }));
      void phase.link.then((link) => update(id, { link }));
    },
    cancel: () => {
      const phase = get().phase;
      if (phase.kind === "picking") URL.revokeObjectURL(phase.image);
      set({ phase: { kind: "idle" } });
    },
    dismiss: clearResult,
  };
});

/** The widget or panel at a point of the page, from the app's top left; null if it's in none. */
function regionAt(x: number, y: number, bounds: Rect): Rect | null {
  for (const el of document.elementsFromPoint(x, y)) {
    // The picker itself is on top.
    if (el.closest(`[${IGNORE}]`)) continue;
    const region = el.closest("[data-widget], [data-shot]");
    if (!region) return null;
    const r = region.getBoundingClientRect();
    return { left: r.left - bounds.left, top: r.top - bounds.top, width: r.width, height: r.height };
  }
  return null;
}

function Picker({ shot, image }: { shot: Shot; image: string }) {
  const { pick, cancel } = useShare.getState();
  const { bounds } = shot;
  const start = useRef<{ x: number; y: number } | null>(null);
  const [drag, setDrag] = useState<Rect | null>(null);
  const [hover, setHover] = useState<Rect | null>(null);

  useEffect(() => {
    // Before the replay's keys (window, bubbling): Esc here mustn't also clear the selection.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") cancel();
      else if (e.key === "Enter") pick(null);
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [pick, cancel]);

  const local = (e: ReactPointerEvent) => ({ x: e.clientX - bounds.left, y: e.clientY - bounds.top });
  const onPointerDown = (e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    start.current = local(e);
  };
  const onPointerMove = (e: ReactPointerEvent) => {
    const p = local(e);
    const s = start.current;
    if (s && (drag || Math.hypot(p.x - s.x, p.y - s.y) > DRAG_PX)) {
      setDrag({ left: Math.min(s.x, p.x), top: Math.min(s.y, p.y), width: Math.abs(p.x - s.x), height: Math.abs(p.y - s.y) });
    } else if (!s) {
      setHover(regionAt(e.clientX, e.clientY, bounds));
    }
  };
  const onPointerUp = (e: ReactPointerEvent) => {
    if (!start.current) return;
    start.current = null;
    if (drag) {
      setDrag(null);
      // Too small to be meant: start again.
      if (drag.width >= 8 && drag.height >= 8) pick(drag);
      return;
    }
    pick(regionAt(e.clientX, e.clientY, bounds));
  };

  const area = drag ?? hover;
  return (
    <div
      data-shot-ignore=""
      className="fixed inset-0 z-50 cursor-crosshair touch-none select-none"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={() => !start.current && setHover(null)}
      onContextMenu={(e) => {
        e.preventDefault();
        cancel();
      }}
    >
      <img src={image} alt="" draggable={false} className="absolute max-w-none" style={{ left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height }} />
      {area ? (
        <div
          className="pointer-events-none absolute outline-1 outline-zinc-100 outline-solid"
          style={{ left: bounds.left + area.left, top: bounds.top + area.top, width: area.width, height: area.height, boxShadow: "0 0 0 200vmax rgb(0 0 0 / 0.55)" }}
        >
          {drag && (
            <span className="absolute left-0 top-full mt-1 rounded bg-zinc-900 px-1.5 py-0.5 text-[11px] tabular-nums text-zinc-300">
              {Math.round(drag.width)} × {Math.round(drag.height)}
            </span>
          )}
        </div>
      ) : (
        <div className="pointer-events-none absolute inset-0 bg-black/40" />
      )}
      {!drag && (
        <div className="pointer-events-none absolute left-1/2 top-3 flex -translate-x-1/2 items-center gap-2 whitespace-nowrap rounded-lg border border-zinc-700 bg-zinc-900/95 px-3 py-1.5 text-xs text-zinc-300 shadow-xl">
          <Icon name="camera" size={14} className="text-zinc-400" />
          Drag out an area or click a widget
          <span className="text-zinc-500">·</span>
          <Kbd>Enter</Kbd> whole screen
          <span className="text-zinc-500">·</span>
          <Kbd>Esc</Kbd> cancel
        </div>
      )}
    </div>
  );
}

const Kbd = ({ children }: { children: string }) => (
  <kbd className="rounded border border-zinc-700 bg-zinc-800 px-1.5 py-0.5 font-mono text-[11px] text-zinc-200">{children}</kbd>
);

const BUTTON = "flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md bg-zinc-800 px-2.5 py-1 text-xs font-semibold text-zinc-100 hover:bg-zinc-700 hover:text-white";

function ShareToast({ result }: { result: Result }) {
  const dismiss = useShare((s) => s.dismiss);
  const [held, setHeld] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);

  useEffect(() => {
    if (held) return;
    const id = setTimeout(dismiss, TOAST_MS);
    return () => clearTimeout(id);
  }, [held, dismiss, result.id]);

  const copyLink = (e: { currentTarget: HTMLButtonElement }) => {
    e.currentTarget.blur();
    if (!result.link) return;
    void navigator.clipboard.writeText(result.link).then(() => setLinkCopied(true));
  };
  const save = (e: { currentTarget: HTMLButtonElement }) => {
    e.currentTarget.blur();
    if (!result.image) return;
    const a = document.createElement("a");
    a.href = result.image;
    a.download = result.fileName;
    a.click();
  };

  const title = result.error ? "Couldn't share the screen" : result.copied === "yes" ? "Screenshot copied" : result.copied === "no" ? "Screenshot ready" : "Copying the screenshot…";
  const note = result.error ?? (result.copied === "no" ? "This browser wouldn't copy it: save it instead." : "Paste it anywhere. The link opens this moment, as you see it.");
  return (
    <div
      data-shot-ignore=""
      role="status"
      onPointerEnter={() => setHeld(true)}
      onPointerLeave={() => setHeld(false)}
      onFocus={() => setHeld(true)}
      className="fixed right-4 top-16 z-40 w-96 rounded-lg border border-zinc-700 bg-zinc-900/95 p-3 text-xs shadow-2xl backdrop-blur"
    >
      <div className="flex items-start gap-3">
        {result.image && <img src={result.image} alt="The screenshot" className="max-h-20 max-w-32 shrink-0 rounded border border-zinc-800 object-contain" />}
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-1.5 font-semibold text-zinc-100">
            {result.copied === "yes" && <Icon name="check" size={14} className="text-emerald-400" />}
            {title}
          </p>
          <p className="mt-0.5 text-zinc-400">{note}</p>
        </div>
        <button onClick={dismiss} className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100" aria-label="Dismiss">
          <Icon name="close" size={12} />
        </button>
      </div>
      {result.link && (
        <div className="mt-3 flex items-center gap-1.5">
          <input
            readOnly
            value={result.link}
            onFocus={(e) => e.currentTarget.select()}
            aria-label="Link to this moment"
            className="min-w-0 flex-1 rounded bg-zinc-800 px-2 py-1 text-[11px] text-zinc-300"
          />
          <button onClick={copyLink} className={BUTTON}>
            <Icon name={linkCopied ? "check" : "link"} size={12} />
            {linkCopied ? "Copied" : "Copy link"}
          </button>
        </div>
      )}
      {result.image && (
        <div className="mt-2 flex justify-end">
          <button onClick={save} className={BUTTON}>
            <Icon name="download" size={12} />
            Save image
          </button>
        </div>
      )}
    </div>
  );
}

/** The picker while sharing, and the toast after. */
export function ShareShot() {
  const phase = useShare((s) => s.phase);
  const result = useShare((s) => s.result);
  return (
    <>
      {phase.kind === "capturing" && <div data-shot-ignore="" className="fixed inset-0 z-50 cursor-wait" />}
      {phase.kind === "picking" && <Picker shot={phase.shot} image={phase.image} />}
      {result && phase.kind === "idle" && <ShareToast result={result} />}
    </>
  );
}

/** The top bar's Share button. */
export function ShareButton() {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.currentTarget.blur();
        useShare.getState().start();
      }}
      className="flex items-center gap-1.5 whitespace-nowrap rounded-md bg-zinc-800 px-2.5 py-1 text-xs font-semibold text-zinc-100 hover:bg-zinc-700 hover:text-white"
      title="Copy a screenshot of an area, with a link to this moment (S)"
    >
      <Icon name="camera" size={14} />
      Share
    </button>
  );
}
