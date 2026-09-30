import { useState, type ReactNode } from "react";
import { getVault } from "../../vault/client";
import { useVault } from "./useVault";

type Ping = { last: number; median: number; n: number } | { error: string };

/** Spike S3 debug panel (?vault=debug): handshake state, vault origin, `status` round-trip latency. */
export function VaultPanel() {
  const state = useVault();
  const [ping, setPing] = useState<Ping | null>(null);
  const [busy, setBusy] = useState(false);

  async function measure() {
    setBusy(true);
    try {
      const times: number[] = [];
      for (let i = 0; i < 20; i++) {
        const t0 = performance.now();
        await getVault().status();
        times.push(performance.now() - t0);
      }
      const sorted = [...times].sort((a, b) => a - b);
      setPing({ last: times.at(-1)!, median: sorted[sorted.length >> 1]!, n: times.length });
    } catch (e) {
      setPing({ error: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }

  const row = (k: string, v: ReactNode) => (
    <div className="flex justify-between gap-4">
      <dt className="text-zinc-500">{k}</dt>
      <dd className="min-w-0 truncate text-right tabular-nums text-zinc-200">{v}</dd>
    </div>
  );

  return (
    <aside data-testid="vault-panel" className="fixed bottom-4 right-4 z-50 w-80 rounded-lg border border-zinc-800 bg-zinc-900 p-3 text-xs shadow-lg">
      <h2 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Vault (debug)</h2>
      <dl className="space-y-1">
        {row("Handshake", <span data-testid="vault-phase">{state.phase}</span>)}
        {state.reason && row("Reason", state.reason)}
        {row("Origin", state.origin ?? "none")}
        {state.handshakeMs != null && row("Handshake time", `${state.handshakeMs} ms`)}
        {state.status && row("Account", state.status.account)}
        {state.status && row("Live", state.status.live)}
        {state.status && row("Vault version", state.status.version)}
        {ping &&
          row(
            "status round trip",
            <span data-testid="vault-ping">{"error" in ping ? ping.error : `${ping.median.toFixed(2)} ms median of ${ping.n}`}</span>,
          )}
      </dl>
      <button
        onClick={() => void measure()}
        disabled={busy || state.phase !== "ready"}
        className="mt-3 rounded border border-zinc-700 px-2 py-0.5 font-semibold text-zinc-300 hover:border-zinc-500 hover:text-zinc-100 disabled:opacity-40"
      >
        {busy ? "Measuring…" : "Measure status round trip"}
      </button>
    </aside>
  );
}
