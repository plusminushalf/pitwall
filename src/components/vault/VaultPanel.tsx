import { useEffect, useState, type ReactNode } from "react";
import { getVault, type LiveTopic, type StreamStatus, type VaultStatus } from "../../vault/client";
import { STRIP_SECONDS, useLiveStats } from "./useLiveStats";
import { useVault } from "./useVault";

/** OpenF1's live topics (the vault's LIVE_TOPICS; the app imports only types from the vault). */
const TOPICS = [
  "car_data",
  "drivers",
  "intervals",
  "laps",
  "location",
  "overtakes",
  "pit",
  "position",
  "race_control",
  "session_result",
  "sessions",
  "stints",
  "team_radio",
  "weather",
] as const satisfies readonly LiveTopic[];

const PHASE_TEXT: Record<StreamStatus["phase"], string> = {
  off: "off",
  waiting: "waiting for a login",
  connecting: "connecting",
  connected: "connected",
  handover: "handing over to a new session",
  reconnecting: "reconnecting",
  "gap-filling": "filling the gap over REST",
  "connection-limit": "connection limit reached",
};

type Ping = { last: number; median: number; n: number } | { error: string };
type Got = { status: number; bytes: number; auth: boolean; ms: number } | { error: string };

/** The dev-vault knobs (spoil the token, fake a short lifetime, refresh now) and the test get: dev app only. */
const DEV = import.meta.env.DEV;

const knobButton = "rounded border border-zinc-700 px-2 py-0.5 font-semibold text-zinc-300 hover:border-zinc-500 hover:text-zinc-100 disabled:opacity-40";

/** "59:12" until `at`, ticking every second; "expired" after. */
function useCountdown(at: number | undefined): string | null {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (at == null) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [at]);
  if (at == null) return null;
  const s = Math.floor((at - now) / 1000);
  if (s <= 0) return "expired";
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Spike S3 debug panel (?vault=debug): handshake, vault status (never a token), `status` round-trip latency. */
export function VaultPanel() {
  const state = useVault();
  const [ping, setPing] = useState<Ping | null>(null);
  const [busy, setBusy] = useState(false);
  const status = state.status;
  const countdown = useCountdown(status?.tokenExpiresAt);
  const nextIn = useCountdown(status?.nextRefreshAt);
  const [got, setGot] = useState<Got | null>(null);
  const [knob, setKnob] = useState<string | null>(null);

  // Dev app only: the e2e (vault/e2e.ts) drives the vault through the same client the app uses.
  useEffect(() => {
    if (DEV) (window as unknown as { __vault?: unknown }).__vault = getVault();
  }, []);

  async function getLatest() {
    const t0 = performance.now();
    try {
      const r = await getVault().get("sessions", { session_key: "latest" });
      setGot({ status: r.status, bytes: r.body.byteLength, auth: r.auth, ms: Math.round(performance.now() - t0) });
    } catch (e) {
      setGot({ error: e instanceof Error ? e.message : String(e) });
    }
  }

  async function run(name: string, f: () => Promise<unknown>) {
    setKnob(`${name}…`);
    try {
      await f();
      setKnob(`${name}: done`);
    } catch (e) {
      setKnob(`${name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

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
    <aside data-testid="vault-panel" className="fixed bottom-4 right-4 z-50 max-h-[calc(100vh-5rem)] w-80 overflow-y-auto rounded-lg border border-zinc-800 bg-zinc-900 p-3 text-xs shadow-lg">
      <h2 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Vault (debug)</h2>
      <dl className="space-y-1">
        {row("Handshake", <span data-testid="vault-phase">{state.phase}</span>)}
        {state.reason && row("Reason", state.reason)}
        {row("Origin", state.origin ?? "none")}
        {state.handshakeMs != null && row("Handshake time", `${state.handshakeMs} ms`)}
        {status && row("State", <span data-testid="vault-panel-state">{status.state}</span>)}
        {status?.mode && row("Stored", <span data-testid="vault-panel-mode">{status.mode === "device" ? "on this device" : "behind a passkey"}</span>)}
        {status?.account && row("Account", <span data-testid="vault-panel-account">{status.account}</span>)}
        {countdown && row("Token expires in", <span data-testid="vault-token-expiry" data-expires-at={status?.tokenExpiresAt}>{countdown}</span>)}
        {status?.refresh && status.refresh !== "off" && row("Refresh", <span data-testid="vault-refresh" data-phase={status.refresh}>{status.refresh}{nextIn && status.nextRefreshAt ? ` (next in ${nextIn})` : ""}</span>)}
        {status?.refreshCount != null && row("Silent refreshes", <span data-testid="vault-refresh-count" data-count={status.refreshCount}>{status.refreshCount}</span>)}
        {status?.lastRefresh &&
          row(
            "Last refresh",
            <span data-testid="vault-last-refresh" data-ok={String(status.lastRefresh.ok)} data-error={status.lastRefresh.error ?? ""}>
              {status.lastRefresh.ok ? "ok" : `failed (${status.lastRefresh.error})`} at {new Date(status.lastRefresh.at).toLocaleTimeString()}
            </span>,
          )}
        {status?.needsReauth && row("Needs reconnect", <span data-testid="vault-needs-reauth">yes</span>)}
        {status?.error && row("Error", <span data-testid="vault-panel-error" title={status.error.message}>{status.error.code}</span>)}
        {state.popup && row("Popup", `open (${state.popup})`)}
        {status && row("Live", status.live)}
        {status && row("Vault version", status.version)}
        {ping &&
          row(
            "status round trip",
            <span data-testid="vault-ping">{"error" in ping ? ping.error : `${ping.median.toFixed(2)} ms median of ${ping.n}`}</span>,
          )}
        {got &&
          row(
            "get sessions latest",
            <span data-testid="vault-get-result" data-status={"error" in got ? "error" : got.status} data-auth={"error" in got ? "" : String(got.auth)}>
              {"error" in got ? got.error : `${got.status}, ${got.bytes} B, ${got.auth ? "authenticated" : "no token"}, ${got.ms} ms`}
            </span>,
          )}
        {knob && row("Knob", <span data-testid="vault-knob">{knob}</span>)}
      </dl>
      {status && <LiveSection status={status} ready={state.phase === "ready"} />}
      <button
        onClick={() => void measure()}
        disabled={busy || state.phase !== "ready"}
        className="mt-3 rounded border border-zinc-700 px-2 py-0.5 font-semibold text-zinc-300 hover:border-zinc-500 hover:text-zinc-100 disabled:opacity-40"
      >
        {busy ? "Measuring…" : "Measure status round trip"}
      </button>
      {DEV && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          <button onClick={() => void getLatest()} disabled={state.phase !== "ready"} className={knobButton}>
            get /v1/sessions?session_key=latest
          </button>
          <button onClick={() => void run("spoil", () => getVault().debug.spoilToken())} disabled={state.phase !== "ready"} className={knobButton} title="Corrupt the vault's in-memory token: the next get gets a real 401 and refreshes">
            Spoil token
          </button>
          <button onClick={() => void run("refresh", () => getVault().debug.refreshNow())} disabled={state.phase !== "ready"} className={knobButton}>
            Refresh now
          </button>
          <button onClick={() => void run("fake 120 s", () => getVault().debug.fakeExpiry(120))} disabled={state.phase !== "ready"} className={knobButton} title="New tokens last 120 s (applies from the next token: click Refresh now)">
            Fake 120 s tokens
          </button>
          <button onClick={() => void run("real expiry", () => getVault().debug.fakeExpiry(0))} disabled={state.phase !== "ready"} className={knobButton}>
            Real expiry
          </button>
          <button onClick={() => void run("503 ×2", () => getVault().debug.failToken(503, 2).then(() => getVault().debug.refreshNow()))} disabled={state.phase !== "ready"} className={knobButton} title="The next two /token calls answer 503, then refresh: watch the backoff (5 s, 10 s) and the recovery">
            /token 503 ×2
          </button>
          <button onClick={() => void run("401", () => getVault().debug.failToken(401, 1).then(() => getVault().debug.refreshNow()))} disabled={state.phase !== "ready"} className={knobButton} title="The next /token call answers 401 (password changed), then refresh: the reconnect banner">
            /token 401
          </button>
        </div>
      )}
    </aside>
  );
}

const clock = (iso: string | undefined) => (iso ? new Date(iso).toLocaleTimeString([], { hour12: false }) : "");

/** The live stream: who runs it, its state, this tab's subscriptions, what arrived (a gap shows in the strip). */
function LiveSection({ status, ready }: { status: VaultStatus; ready: boolean }) {
  const stats = useLiveStats();
  const [mine, setMine] = useState<LiveTopic[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const stream = status.stream;
  const tab = status.tab;

  async function toggle(t: LiveTopic) {
    setErr(null);
    try {
      const r = mine.includes(t) ? await getVault().unsubscribe([t]) : await getVault().subscribe([t]);
      setMine(r.topics);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }

  const peak = Math.max(1, ...stats.perSecond);
  const last = stats.perSecond.at(-2) ?? 0; // the last whole second
  const kv = (k: string, v: ReactNode) => (
    <div className="flex justify-between gap-4">
      <dt className="text-zinc-500">{k}</dt>
      <dd className="min-w-0 truncate text-right tabular-nums text-zinc-200">{v}</dd>
    </div>
  );
  return (
    <section className="mt-3 border-t border-zinc-800 pt-2" data-testid="vault-live">
      <h3 className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Live stream</h3>
      <dl className="space-y-1">
        {tab &&
          kv(
            "This tab",
            <span data-testid="vault-role" data-role={tab.role} data-leader={tab.leader ?? ""}>
              {tab.role === "leader" ? `leader${tab.frames ? ` of ${tab.frames} tab${tab.frames > 1 ? "s" : ""}` : ""}` : `follower of ${tab.leader?.slice(0, 6) ?? "?"}`} ({tab.id.slice(0, 6)})
            </span>,
          )}
        {stream && (
          <>
            {kv("Stream", <span data-testid="vault-stream-phase" data-phase={stream.phase} className={stream.phase === "connection-limit" ? "text-amber-400" : undefined}>{PHASE_TEXT[stream.phase]}</span>)}
            {kv("Sessions", <span data-testid="vault-stream-sessions" data-sessions={stream.sessions} data-max={stream.maxSessions}>{stream.sessions} open (max {stream.maxSessions})</span>)}
            {kv("Handovers / reconnects", `${stream.handovers} / ${stream.reconnects}`)}
            {kv("Delivered", <span data-testid="vault-stream-counts" data-delivered={stream.delivered} data-duplicates={stream.duplicates} data-gap-filled={stream.gapFilled}>{stream.delivered} ({stream.duplicates} dup dropped, {stream.gapFilled} gap-filled)</span>)}
            {stream.lastError && kv("Last error", <span title={stream.lastError}>{stream.lastError}</span>)}
          </>
        )}
      </dl>
      <div className="mt-2 flex flex-wrap gap-1" data-testid="vault-subscribe">
        {TOPICS.map((t) => {
          const on = mine.includes(t);
          const n = stats.counts[t] ?? 0;
          const seen = stream?.lastSeen[t];
          return (
            <button
              key={t}
              type="button"
              disabled={!ready}
              onClick={() => void toggle(t)}
              data-testid={`vault-sub-${t}`}
              data-on={String(on)}
              data-count={n}
              title={on ? `Subscribed. ${n} received${seen ? `, last at ${clock(seen)}` : ""}. Click to unsubscribe.` : "Click to subscribe"}
              className={`rounded border px-1.5 py-0.5 font-mono text-[10px] disabled:opacity-40 ${on ? "border-emerald-700 bg-emerald-950 text-emerald-200" : "border-zinc-700 text-zinc-400 hover:border-zinc-500"}`}
            >
              {t}
              {on && <span className="ml-1 tabular-nums text-emerald-400">{n}</span>}
            </button>
          );
        })}
      </div>
      {err && <p className="mt-1 text-red-400">{err}</p>}
      <div className="mt-2">
        <div className="mb-0.5 flex justify-between text-[10px] text-zinc-500">
          <span>arrivals, last {STRIP_SECONDS / 60} min</span>
          <span className="tabular-nums" data-testid="vault-rate">{last} msg/s, peak {peak === 1 && !stats.total ? 0 : peak}</span>
        </div>
        <div className="flex h-8 items-end gap-px bg-zinc-950" data-testid="vault-strip" role="img" aria-label={`messages per second over the last ${STRIP_SECONDS} seconds`}>
          {stats.perSecond.map((v, i) => (
            <div key={i} className={v ? "flex-1 bg-emerald-500" : "flex-1 bg-zinc-800"} style={{ height: v ? `${Math.max(8, (v / peak) * 100)}%` : "1px" }} />
          ))}
        </div>
      </div>
    </section>
  );
}
