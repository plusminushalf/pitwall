import { useEffect } from "react";
import { DriverPanel } from "./components/DriverPanel";
import { DownloadPrompt } from "./components/DownloadPrompt";
import { EventFeed } from "./components/EventFeed";
import { Header } from "./components/Header";
import { LiveScreen } from "./components/LiveControl";
import { ReadyToast } from "./components/Navigation";
import { Timeline } from "./components/Timeline";
import { TimingTower } from "./components/TimingTower";
import { TrackMap } from "./components/TrackMap";
import { QualiView } from "./components/quali/QualiView";
import { Home } from "./components/home/Home";
import { useKeyboard } from "./hooks/useKeyboard";
import { useReplayLoop } from "./hooks/useReplayLoop";
import { applyUrl, useHistoryNav, useUrlSync } from "./hooks/useUrlState";
import { useLibrary } from "./library";
import { useReplay } from "./store";

function LoadingScreen() {
  const loading = useReplay((s) => s.loading);
  const error = useReplay((s) => s.error);
  return (
    <div className="flex h-full items-center justify-center">
      {error ? (
        <div className="max-w-lg text-center">
          <p className="text-red-400">{error}</p>
          <button
            onClick={() => useReplay.getState().goHome()}
            className="mt-3 rounded border border-zinc-700 px-2.5 py-1 text-xs font-semibold text-zinc-200 hover:border-zinc-500 hover:text-white"
          >
            ← All races
          </button>
        </div>
      ) : (
        <div className="w-72">
          <p className="mb-2 text-sm text-zinc-400">Loading race data…</p>
          <div className="h-1.5 overflow-hidden rounded bg-zinc-800">
            <div className="h-full bg-zinc-200 transition-all" style={{ width: `${(loading?.progress ?? 0) * 100}%` }} />
          </div>
        </div>
      )}
    </div>
  );
}

/** No OPFS: an insecure origin (http:// on another host) or an old browser. */
function Unsupported() {
  return (
    <div className="flex h-full items-center justify-center px-4">
      <div className="max-w-md text-center text-sm text-zinc-400">
        <h1 className="mb-2 text-xl font-black tracking-tight text-zinc-100">F1 Race Replay</h1>
        <p>
          This browser can't store races for this site. It needs a secure page (https, or localhost) and a current Chrome, Edge, Firefox or Safari.
        </p>
      </div>
    </div>
  );
}

export function App() {
  useReplayLoop();
  useKeyboard();
  useUrlSync();
  useHistoryNav();
  const view = useReplay((s) => s.view);
  const session = useReplay((s) => s.session);
  const loading = useReplay((s) => s.loading);
  const supported = useLibrary((s) => s.supported);
  const link = useLibrary((s) => s.link);
  const live = useReplay((s) => s.mode === "live");

  useEffect(() => {
    void (async () => {
      await useLibrary.getState().init();
      await useReplay.getState().loadIndex();
      // Home, unless the link opens a session (or offers to download it) or live mode.
      applyUrl();
    })();
  }, []);

  if (!supported) return <Unsupported />;
  if (view === "home") return <Home />;
  // Live mode before there's a live session to show: connecting, relay offline, or no race right now.
  if (!session && live) return <LiveScreen />;
  // A shared link to a session that isn't downloaded: offer to.
  if (link && !live && !loading && session?.meta.sessionKey !== link.key) return <DownloadPrompt sessionKey={link.key} />;
  if (!session) return <LoadingScreen />;
  // Qualifying sessions open in the lap comparison view.
  if (session.meta.quali) {
    return (
      <>
        <QualiView overlay={loading && <div className="absolute inset-0 z-10 bg-zinc-950/80"><LoadingScreen /></div>} />
        <ReadyToast />
      </>
    );
  }

  return (
    <div className="relative grid h-full grid-rows-[auto_minmax(0,1fr)_auto]">
      <Header />
      <div className="grid min-h-0 grid-cols-[410px_minmax(0,1fr)_360px]">
        <aside className="min-h-0 border-r border-zinc-800">
          <TimingTower />
        </aside>
        <main className="min-h-0">
          <TrackMap />
        </main>
        <aside className="flex min-h-0 flex-col border-l border-zinc-800">
          <DriverPanel />
          <EventFeed />
        </aside>
      </div>
      <Timeline />
      {loading && (
        <div className="absolute inset-0 z-10 bg-zinc-950/80">
          <LoadingScreen />
        </div>
      )}
      <ReadyToast />
    </div>
  );
}
