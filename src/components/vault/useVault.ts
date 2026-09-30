import { useEffect, useSyncExternalStore } from "react";
import { getVault, type VaultState } from "../../vault/client";

/** The vault client's state; mounting the first user starts the vault (once per tab). */
export function useVault(): VaultState {
  const vault = getVault();
  useEffect(() => void vault.start(), [vault]);
  return useSyncExternalStore((fn) => vault.onState(fn), vault.getState);
}

/** `?vault=debug` shows the spike's debug panel. */
export const vaultDebug = () => new URLSearchParams(location.search).get("vault") === "debug";
