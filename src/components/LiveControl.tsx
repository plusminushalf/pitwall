// Live mode UI: the header control (LIVE / Go live / live status, and the way back to replays), the Go
// live button, and the screen shown while there's no live session to display. Live data comes from the relay
// (dev), or through the credential vault with the user's own OpenF1 account (the hosted site): src/live/client.ts.

import { createPortal } from "react-dom";
import { liveTarget, useReplay, type LiveInfo } from "../store";
import { raceClock } from "../lib/format";
import type { LiveAccount, LiveStall } from "../live/vault";
import { getVault } from "../vault/client";
import { needsReauth, ReauthBanner } from "./vault/ReauthBanner";
import { useVault } from "./vault/useVault";

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

export interface Status {
  text: string;
  /** For the header, where there's little room (else `text`). */
  short?: string;
  /** A command to show after the text. */
  code?: string;
  /** A button after the text (it opens the vault's popup, which must happen inside the click). */
  action?: { label: string; run: () => void };
  tone: "error" | "muted";
}

/**
 * What the OpenF1 account needs before live can run through the vault, in words, with the button that does it.
 * `onHome`: said on Home, where Settings is at hand.
 */
export function accountStatus(account: LiveAccount, onHome = false): Status {
  const vault = getVault();
  switch (account) {
    case "loading":
      return { text: "Loading your OpenF1 account…", tone: "muted" };
    case "checking":
      return { text: "Checking your OpenF1 login…", tone: "muted" };
    case "connect":
      return {
        text: `Live timing needs an OpenF1 account (Settings → Connect${onHome ? "" : " on the home page"}).`,
        short: "Live needs an OpenF1 account",
        action: { label: "Connect", run: () => void vault.connect() },
        tone: "muted",
      };
    case "unlock":
      return { text: "Your OpenF1 account is locked. Unlock it to follow live.", short: "OpenF1 account locked", action: { label: "Unlock", run: () => void vault.unlock() }, tone: "muted" };
    case "reconnect":
      return {
        text: "OpenF1 no longer accepts your saved login. Reconnect it to follow live.",
        short: "OpenF1 login refused",
        action: { label: "Reconnect", run: () => void vault.connect() },
        tone: "error",
      };
    case "blocked":
      return {
        text: `Your browser blocks third-party cookies here, so your OpenF1 account can't be kept. Allow them for ${location.host} to follow live.`,
        short: "Third-party cookies blocked: no OpenF1 account",
        tone: "error",
      };
    case "unavailable":
      return {
        text: `Live timing needs the OpenF1 account vault, which didn't load (${vault.getState().reason ?? "unknown error"}).`,
        short: "The OpenF1 account vault didn't load",
        tone: "error",
      };
  }
}

const STALLS: Record<LiveStall, Status> = {
  reconnecting: { text: "Reconnecting to OpenF1's live stream…", short: "Reconnecting to OpenF1…", tone: "muted" },
  limit: { text: "OpenF1 refused another connection (10 per account at most). Retrying…", short: "OpenF1 connection limit: retrying…", tone: "error" },
  waiting: { text: "Waiting for a fresh OpenF1 token…", tone: "muted" },
};

/** "backfilling from OpenF1: 40%" -> "Backfilling from OpenF1: 40%…" */
const sentence = (s: string) => `${s[0].toUpperCase()}${s.slice(1)}…`;

/** The live situation in words, or null when there's nothing to say (streaming normally). */
function statusText(live: LiveInfo, hasSession: boolean): Status | null {
  if (live.via === null) return { text: "Live timing isn't available on this site.", tone: "muted" };
  if (live.via === "vault") {
    if (live.account) return accountStatus(live.account);
    if (live.offline && !live.connected) return { text: "Live timing stopped unexpectedly. Restarting…", tone: "error" };
    if (live.state === "error") return { text: `Live timing error: ${live.detail ?? "unknown error"}`, tone: "error" };
    if (hasSession) return live.state === "live" && live.stall ? STALLS[live.stall] : null;
    if (live.state === null) return { text: "Starting live timing…", tone: "muted" };
  } else {
    if (live.offline && !live.connected) return { text: "Live relay offline — run", code: "bun run live", tone: "error" };
    if (live.state === "error") return { text: `Live relay error: ${live.detail ?? "unknown error"}`, tone: "error" };
    if (hasSession) return null;
    if (live.state === null) return { text: "Connecting to the live relay…", tone: "muted" };
  }
  if (live.state === "connecting") return { text: live.detail ? sentence(live.detail) : "Loading the live session…", tone: "muted" };
  if (live.state === "idle") return { text: live.next ? nextLabel(live.next) : "No live session right now", tone: "muted" };
  return { text: "Waiting for live data…", tone: "muted" };
}

/** The status in words (`className` on the words: the header truncates them), then its button if it has one. */
export function StatusLine({ status, short = false, className = "" }: { status: Status; short?: boolean; className?: string }) {
  const text = (short && status.short) || status.text;
  return (
    <>
      <span className={`${status.tone === "error" ? "text-red-400" : "text-zinc-400"} ${className}`} title={status.code ? `${status.text} ${status.code}` : status.text} data-testid="live-status">
        {text}
        {status.code && (
          <>
            {" "}
            <code className="rounded bg-zinc-800 px-1 py-px font-mono text-zinc-200">{status.code}</code>
          </>
        )}
      </span>
      {status.action && (
        <button
          type="button"
          data-testid="live-account-action"
          onClick={(e) => {
            e.currentTarget.blur();
            status.action!.run();
          }}
          className="shrink-0 rounded bg-zinc-100 px-1.5 py-px text-[11px] font-semibold text-zinc-900 hover:bg-white"
        >
          {status.action.label}
        </button>
      )}
    </>
  );
}

/** Live through the vault: the SIMULATED badge (the dev vault's simulate mode) and the reconnect banner. */
function VaultBits() {
  const state = useVault();
  return (
    <>
      {state.status?.sim && (
        <span
          className="shrink-0 rounded bg-amber-500 px-1.5 py-0.5 text-[10px] font-bold tracking-wider text-zinc-950"
          data-testid="vault-sim-badge"
          title={`Simulated live data: a replay of ${state.status.sim.label} (#${state.status.sim.sessionKey}) at ${state.status.sim.speed}x from the vault dev server, not OpenF1`}
        >
          SIMULATED
        </span>
      )}
      {/* A portal: the header's backdrop-blur would otherwise be the fixed banner's containing block. */}
      {needsReauth(state) && createPortal(<ReauthBanner state={state} below />, document.body)}
    </>
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
  const streaming = useReplay((s) => s.live.connected && s.live.state === "live" && !s.live.stall);
  const goLive = useReplay((s) => s.goLive);
  const behind = useLiveBehind();
  if (!hasSession) return null;
  if (followLive) {
    if (!streaming && !ended) {
      return (
        <span
          className={`flex items-center gap-1.5 whitespace-nowrap rounded bg-zinc-800 px-2 py-0.5 text-[11px] font-black uppercase tracking-wider text-zinc-400 ${className}`}
          title="Not streaming right now: showing the last data received"
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
        data-testid="live-badge"
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
 * mode is entered from Home's weekend card while a session is on (or a /live link).
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
      {live.via === "vault" && <VaultBits />}
      <GoLiveButton className="shrink-0" />
      {status && <StatusLine status={status} short className="max-w-[16rem] truncate text-[11px]" />}
      <button
        onClick={(e) => {
          e.currentTarget.blur();
          exitLive();
        }}
        className="shrink-0 rounded px-1.5 py-0.5 text-[11px] text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
        title="Leave live mode and go back to replays"
      >
        Replays
      </button>
    </div>
  );
}

/** Live mode without a session to show yet: connecting, the account or relay to sort out, or no live session right now. */
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
          {live.via === "vault" && <VaultBits />}
        </span>
        {status && (
          <span className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-sm">
            <StatusLine status={status} />
          </span>
        )}
        {live.via === "relay" && live.offline && !live.connected && (
          <p className="text-xs text-zinc-400">
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
