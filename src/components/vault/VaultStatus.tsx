import { useState } from "react";
import type { VaultState } from "../../vault/client";
import { useVault, vaultDebug } from "./useVault";
import { VaultPanel } from "./VaultPanel";

function label(s: VaultState): { text: string; dot: string; title: string } {
  if (s.phase === "unavailable") return { text: "unavailable", dot: "bg-zinc-600", title: `Vault unavailable: ${s.reason ?? "unknown"}. Everything else works without it.` };
  if (s.phase !== "ready" || !s.status) return { text: "…", dot: "bg-zinc-600", title: "Loading the vault" };
  const account = s.status.account;
  if (account === "connected") return { text: "connected", dot: "bg-emerald-500", title: "Live data and faster downloads use your OpenF1 login" };
  if (account === "locked") return { text: "locked", dot: "bg-amber-500", title: "Unlock with your passkey to use your OpenF1 login" };
  return { text: "not connected", dot: "bg-zinc-500", title: "Historical races need no login. An OpenF1 account adds live timing and faster downloads." };
}

/** A compact "OpenF1 account: …" chip. With ?vault=debug, also the vault debug panel. */
export function VaultStatus() {
  const state = useVault();
  const [debug] = useState(vaultDebug);
  const { text, dot, title } = label(state);
  return (
    <>
      <span
        className="flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded bg-zinc-900 px-2 py-0.5 text-[11px] font-semibold text-zinc-400"
        title={title}
        data-vault-phase={state.phase}
      >
        <span className={`h-1.5 w-1.5 rounded-full ${dot}`} />
        OpenF1 account: <span className="text-zinc-200">{text}</span>
      </span>
      {debug && <VaultPanel />}
    </>
  );
}
