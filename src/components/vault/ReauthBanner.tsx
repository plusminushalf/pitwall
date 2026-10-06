import { usePhone } from "../../hooks/usePhone";
import { getVault, type VaultState } from "../../vault/client";

const time = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/** Whether the vault says the stored OpenF1 login stopped working (password changed or revoked). */
export const needsReauth = (s: VaultState) => s.phase === "ready" && !!s.status?.needsReauth && !s.popup;

/**
 * "Reconnect your OpenF1 account": OpenF1 refused the stored login on a refresh. The current token keeps
 * working until it expires (said here), then live data and authenticated downloads stop. `below`: under the
 * replay screen's header (live mode), so it doesn't cover the header's controls.
 */
export function ReauthBanner({ state, below = false }: { state: VaultState; below?: boolean }) {
  const phone = usePhone();
  if (!needsReauth(state)) return null;
  const exp = state.status?.tokenExpiresAt;
  const running = exp != null && exp > Date.now();
  // The phone's header is two rows (Header.tsx): the banner goes under both.
  const top = below ? (phone ? "top-[calc(5.5rem_+_env(safe-area-inset-top))]" : "top-16") : phone ? "top-[calc(0.75rem_+_env(safe-area-inset-top))]" : "top-3";
  return (
    <div
      role="alert"
      data-testid="vault-reauth-banner"
      className={`fixed left-1/2 ${top} z-50 flex max-w-[calc(100vw-2rem)] -translate-x-1/2 items-center gap-3 rounded-md border border-amber-700 bg-amber-950 px-3 py-2 text-xs text-amber-100 shadow-lg max-md:w-[calc(100vw-1.5rem)] max-md:flex-wrap max-md:justify-end`}
    >
      <span>
        <span className="font-semibold">Reconnect your OpenF1 account.</span> OpenF1 no longer accepts the saved login (was the password changed?).
        {running ? ` Live data keeps working until ${time(exp)}.` : " Live data and faster downloads are off until you reconnect."}
      </span>
      {/* connect() opens the vault's popup: it must run synchronously inside the click. */}
      <button type="button" data-testid="vault-reauth-connect" className="touch-hit shrink-0 rounded bg-amber-600 px-2 py-0.5 font-semibold text-zinc-950 hover:bg-amber-500" onClick={() => void getVault().connect()}>
        Reconnect
      </button>
    </div>
  );
}
