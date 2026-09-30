import { useState } from "react";
import { createPortal } from "react-dom";
import { getVault, type VaultState } from "../../vault/client";
import { useVault, vaultDebug } from "./useVault";
import { VaultPanel } from "./VaultPanel";

type Label = { text: string; dot: string; title: string };

function label(s: VaultState): Label {
  if (s.phase === "unavailable") return { text: "unavailable", dot: "bg-zinc-600", title: `Vault unavailable: ${s.reason ?? "unknown"}. Everything else works without it.` };
  if (s.phase !== "ready" || !s.status) return { text: "…", dot: "bg-zinc-600", title: "Loading the vault" };
  const { state, error } = s.status;
  if (s.popup && state !== "connecting") return { text: s.popup === "unlock" ? "unlocking in the vault window…" : "waiting for the vault window…", dot: "bg-sky-500", title: "Finish in the vault's window" };
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
      return { text: "unavailable", dot: "bg-zinc-600", title: "This browser won't let the vault store a login (third-party storage blocked?)" };
    default:
      return { text: "not connected", dot: "bg-zinc-500", title: "Historical races need no login. An OpenF1 account adds live timing and faster downloads." };
  }
}

const button = "rounded px-1.5 py-0.5 text-[11px] font-semibold text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100 disabled:opacity-40";

/** A compact "OpenF1 account: …" chip with Connect / Unlock / Disconnect. With ?vault=debug, also the vault debug panel. */
export function VaultStatus() {
  const state = useVault();
  const [debug] = useState(vaultDebug);
  const { text, dot, title } = label(state);
  const account = state.phase === "ready" ? state.status?.state : undefined;
  const vault = getVault();
  // connect() / unlock() open the vault's popup: they must run synchronously inside the click.
  return (
    <>
      <span className="flex shrink-0 items-center gap-1 whitespace-nowrap rounded bg-zinc-900 py-0.5 pl-2 pr-0.5 text-[11px] font-semibold text-zinc-400" title={title} data-vault-phase={state.phase}>
        <span className={`h-1.5 w-1.5 rounded-full ${dot}`} />
        OpenF1 account: <span className="text-zinc-200" data-testid="vault-state" data-state={account ?? state.phase}>{text}</span>
        {account === "locked" && (
          <button type="button" className={button} data-testid="vault-unlock" onClick={() => void vault.unlock()}>
            Unlock
          </button>
        )}
        {(account === "disconnected" || account === "error") && (
          <button type="button" className={button} data-testid="vault-connect" onClick={() => void vault.connect()}>
            {account === "error" ? "Reconnect" : "Connect"}
          </button>
        )}
        {(account === "connected" || account === "locked" || account === "error") && (
          <button type="button" className={button} data-testid="vault-disconnect" onClick={() => void vault.disconnect().catch(() => {})}>
            Disconnect
          </button>
        )}
      </span>
      {state.actionError && (
        <span className="shrink-0 text-[11px] text-red-400" data-testid="vault-action-error">
          {state.actionError}
        </span>
      )}
      {/* A portal: the header's backdrop-blur would otherwise be the fixed panel's containing block. */}
      {debug && createPortal(<VaultPanel />, document.body)}
    </>
  );
}
