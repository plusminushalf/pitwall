import { useState } from "react";
import { createPortal } from "react-dom";
import { getVault, type VaultState } from "../../vault/client";
import { needsReauth, ReauthBanner } from "./ReauthBanner";
import { useVault, vaultDebug } from "./useVault";
import { VaultPanel } from "./VaultPanel";

type Label = { text: string; dot: string; title: string };

function label(s: VaultState): Label {
  if (s.phase === "unavailable") return { text: "unavailable", dot: "bg-zinc-600", title: `Vault unavailable: ${s.reason ?? "unknown"}. Everything else works without it.` };
  if (s.phase !== "ready" || !s.status) return { text: "…", dot: "bg-zinc-600", title: "Loading the vault" };
  const { state, error } = s.status;
  if (s.popup && state !== "connecting") return { text: s.popup === "unlock" ? "unlocking in the vault window…" : "waiting for the vault window…", dot: "bg-sky-500", title: "Finish in the vault's window" };
  if (state === "connected" && needsReauth(s)) return { text: "reconnect needed", dot: "bg-amber-500", title: "OpenF1 no longer accepts the saved login. It keeps working until the current token expires." };
  switch (state) {
    case "connected":
      return { text: "connected", dot: "bg-emerald-500", title: "Live data and faster downloads use your OpenF1 login" };
    case "locked":
      return { text: "locked", dot: "bg-amber-500", title: "Unlock with your passkey to use your OpenF1 login" };
    case "connecting":
      return { text: "connecting…", dot: "bg-sky-500", title: "Checking your login with OpenF1" };
    case "error":
      return { text: "needs attention", dot: "bg-red-500", title: error?.message ?? "Your stored login didn't work" };
    case "unavailable":
      return {
        text: "unavailable",
        dot: "bg-zinc-600",
        title: `Your browser blocks third-party cookies here, so the vault can't keep a login. To connect, allow third-party cookies for ${location.host} in your browser's settings. Everything else works without it.`,
      };
    default:
      return { text: "not connected", dot: "bg-zinc-500", title: "Historical races need no login. An OpenF1 account adds live timing and faster downloads." };
  }
}

const button = "rounded px-1.5 py-0.5 text-[11px] font-semibold text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100 disabled:opacity-40";

/** The OpenF1 account, in Home's Settings: its state and what it's for, with Connect / Unlock / Disconnect. */
export function VaultAccount() {
  const state = useVault();
  const { text, dot, title } = label(state);
  const account = state.phase === "ready" ? state.status?.state : undefined;
  const reauth = needsReauth(state);
  const vault = getVault();
  // connect() / unlock() open the vault's popup: they must run synchronously inside the click.
  return (
    <div data-vault-phase={state.phase}>
      <div className="flex items-center gap-1.5 text-xs">
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dot}`} />
        <span className="font-semibold text-zinc-200" data-testid="vault-state" data-state={account ?? state.phase}>
          {text}
        </span>
        <span className="flex-1" />
        {account === "locked" && (
          <button type="button" className={button} data-testid="vault-unlock" onClick={() => void vault.unlock()}>
            Unlock
          </button>
        )}
        {(account === "disconnected" || account === "error" || (account === "connected" && reauth)) && (
          <button type="button" className={button} data-testid="vault-connect" onClick={() => void vault.connect()}>
            {account === "disconnected" ? "Connect" : "Reconnect"}
          </button>
        )}
        {(account === "connected" || account === "locked" || account === "error") && (
          <button type="button" className={button} data-testid="vault-disconnect" onClick={() => void vault.disconnect().catch(() => {})}>
            Disconnect
          </button>
        )}
      </div>
      <p className="mt-1 text-[11px] leading-snug text-zinc-500">{title}</p>
      {state.actionError && (
        <p className="mt-1 text-[11px] text-red-400" data-testid="vault-action-error">
          {state.actionError}
        </p>
      )}
    </div>
  );
}

/** A dot for the Settings button while the account needs the user (locked, failing, or to reconnect); else null. */
export function useVaultAttention(): string | null {
  const state = useVault();
  const account = state.phase === "ready" ? state.status?.state : undefined;
  if (account === "error") return "bg-red-500";
  if (account === "locked" || needsReauth(state)) return "bg-amber-500";
  return null;
}

/**
 * What stays on Home's header whatever Settings shows: the SIMULATED badge, the reconnect banner and,
 * with ?vault=debug, the vault debug panel. Mounting it starts the vault.
 */
export function VaultIndicators() {
  const state = useVault();
  const [debug] = useState(vaultDebug);
  const reauth = needsReauth(state);
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
      {/* Portals: the header's backdrop-blur would otherwise be the fixed elements' containing block. */}
      {reauth && createPortal(<ReauthBanner state={state} />, document.body)}
      {debug && createPortal(<VaultPanel />, document.body)}
    </>
  );
}
