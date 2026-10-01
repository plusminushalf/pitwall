// Live mode UI: the header control (LIVE / Go live / relay status, and the way back to replays), the Go
// live button, and the screen shown while there's no live session to display.

import { LIVE_RELAY } from "../live/client";
import { liveTarget, useReplay, type LiveInfo } from "../store";
import { raceClock } from "../lib/format";

/** How far behind the follow position the replay is (0 while following live). Re-renders with every live update. */
export function useLiveBehind(): number {
  const following = useReplay((s) => s.mode !== "live" || s.followLive);
  const t = useReplay((s) => s.t);
  useReplay((s) => s.liveEdge); // re-render as the edge moves, also while paused
  return following ? 0 : Math.max(0, liveTarget() - t);
}

const nextLabel = (next: NonNullable<LiveInfo["next"]>) => {
  const when = new Date(next.dateStart).toLocaleString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
  return `Next live: ${next.name} · ${when}`;
};

interface Status {
  text: string;
  /** A command to show after the text. */
  code?: string;
  tone: "error" | "muted";
}

/** The relay's situation in words, or null when there's nothing to say (streaming normally). */
function statusText(live: LiveInfo, hasSession: boolean): Status | null {
  if (!LIVE_RELAY) return { text: "Live timing isn't available on this site yet: it needs a live relay, which this static build doesn't have.", tone: "muted" };
  if (live.offline && !live.connected) return { text: "Live relay offline — run", code: "bun run live", tone: "error" };
  if (live.state === "error") return { text: `Live relay error: ${live.detail ?? "unknown error"}`, tone: "error" };
  if (hasSession) return null;
  if (live.state === null) return { text: "Connecting to the live relay…", tone: "muted" };
  if (live.state === "connecting") return { text: "Loading the live session…", tone: "muted" };
  if (live.state === "idle") return { text: live.next ? nextLabel(live.next) : "No live race or sprint right now", tone: "muted" };
  return { text: "Waiting for live data…", tone: "muted" };
}

function StatusLine({ status, className = "" }: { status: Status; className?: string }) {
  return (
    <span className={`${status.tone === "error" ? "text-red-400" : "text-zinc-400"} ${className}`} title={status.code ? `${status.text} ${status.code}` : status.text}>
      {status.text}
      {status.code && (
        <>
          {" "}
          <code className="rounded bg-zinc-800 px-1 py-px font-mono text-zinc-200">{status.code}</code>
        </>
      )}
    </span>
  );
}

export function LiveDot({ pulse = true }: { pulse?: boolean }) {
  return (
    <span className="relative flex h-2 w-2">
      {pulse && <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-400 opacity-75" />}
      <span className="relative inline-flex h-2 w-2 rounded-full bg-red-500" />
    </span>
  );
}

/** Red pulsing LIVE while following; "Go live · −1:23" while watching back. */
export function GoLiveButton({ className = "" }: { className?: string }) {
  const hasSession = useReplay((s) => s.session != null);
  const followLive = useReplay((s) => s.followLive);
  const ended = useReplay((s) => s.live.state === "ended");
  const streaming = useReplay((s) => s.live.connected && s.live.state === "live");
  const goLive = useReplay((s) => s.goLive);
  const behind = useLiveBehind();
  if (!hasSession) return null;
  if (followLive) {
    if (!streaming && !ended) {
      return (
        <span
          className={`flex items-center gap-1.5 whitespace-nowrap rounded bg-zinc-800 px-2 py-0.5 text-[11px] font-black uppercase tracking-wider text-zinc-400 ${className}`}
          title="The live relay isn't streaming: showing the last data received"
        >
          <span className="h-2 w-2 rounded-full bg-zinc-500" />
          Live
        </span>
      );
    }
    return ended ? (
      <span className={`whitespace-nowrap rounded bg-zinc-800 px-2 py-0.5 text-[11px] font-bold uppercase tracking-wider text-zinc-300 ${className}`} title="The live session has ended">
        Live ended
      </span>
    ) : (
      <span
        className={`flex items-center gap-1.5 whitespace-nowrap rounded bg-red-600 px-2 py-0.5 text-[11px] font-black uppercase tracking-wider text-white ${className}`}
        title="Following the live session"
      >
        <LiveDot />
        Live
      </span>
    );
  }
  return (
    <button
      onClick={(e) => {
        e.currentTarget.blur();
        goLive();
      }}
      className={`flex items-center gap-1.5 whitespace-nowrap rounded border border-red-500/60 px-2 py-0.5 text-[11px] font-bold uppercase tracking-wider text-red-300 hover:bg-red-600 hover:text-white ${className}`}
      title="Jump to the live edge and follow it"
    >
      <LiveDot pulse={false} />
      Go live
      <span className="font-semibold normal-case tabular-nums">· −{raceClock(behind)}</span>
    </button>
  );
}

/**
 * Header control in live mode: its state, Go live and the way back to replays. Nothing in replays: live
 * mode is entered from Home's weekend card while a session is on (or a ?live=1 link).
 */
export function LiveControl() {
  const mode = useReplay((s) => s.mode);
  const live = useReplay((s) => s.live);
  const hasSession = useReplay((s) => s.session != null);
  const exitLive = useReplay((s) => s.exitLive);

  if (mode === "replay") return null;

  const status = statusText(live, hasSession);
  return (
    <div className="flex min-w-0 shrink-0 items-center gap-2">
      <GoLiveButton className="shrink-0" />
      {status && <StatusLine status={status} className="max-w-[22rem] truncate text-[11px]" />}
      <button
        onClick={(e) => {
          e.currentTarget.blur();
          exitLive();
        }}
        className="shrink-0 rounded px-1.5 py-0.5 text-[11px] text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
        title="Leave live mode and go back to replays"
      >
        Replays
      </button>
    </div>
  );
}

/** Live mode without a session to show yet: connecting, relay offline or erroring, or no live race right now. */
export function LiveScreen() {
  const live = useReplay((s) => s.live);
  const exitLive = useReplay((s) => s.exitLive);
  const status = statusText(live, false);
  return (
    <div className="flex h-full items-center justify-center">
      <div className="flex max-w-lg flex-col items-center gap-3 text-center">
        <span className="flex items-center gap-2 text-sm font-black uppercase tracking-widest text-zinc-200">
          <LiveDot pulse={live.connected && live.state !== "error"} />
          Live
        </span>
        {status && <StatusLine status={status} className="text-sm" />}
        {live.offline && !live.connected && (
          <p className="text-xs text-zinc-500">
            Or try a simulated race: <code className="rounded bg-zinc-800 px-1 py-0.5 text-zinc-300">bun run live:sim</code>. Retrying automatically.
          </p>
        )}
        <button onClick={exitLive} className="mt-1 rounded border border-zinc-700 px-3 py-1 text-xs text-zinc-300 hover:border-zinc-500 hover:text-white">
          Back to replays
        </button>
      </div>
    </div>
  );
}
