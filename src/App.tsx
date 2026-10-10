import { useEffect, type ReactNode } from "react";
import { DownloadPrompt } from "./components/DownloadPrompt";
import { Header } from "./components/Header";
import { LiveScreen } from "./components/LiveControl";
import { Logo } from "./components/Logo";
import { ReadyToast } from "./components/Navigation";
import { SpoilerPrompt, useSpoilerPrompt } from "./components/SpoilerPrompt";
import { StreamBuffering, StreamLoading } from "./components/StreamStatus";
import { Timeline } from "./components/Timeline";
import { QualiView } from "./components/quali/QualiView";
import { Home } from "./components/home/Home";
import { CircuitPage } from "./components/circuit/CircuitPage";
import { DriverPage } from "./components/driver/DriverPage";
import { ShareShot } from "./share/ShareShot";
import { Grid } from "./grid/Grid";
import { useKeyboard } from "./hooks/useKeyboard";
import { useReplayLoop } from "./hooks/useReplayLoop";
import { applyUrl, useHistoryNav, useUrlSync } from "./hooks/useUrlState";
import { useLibrary } from "./library";
import { comparing, useReplay } from "./store";

function LoadingScreen() {
  const loading = useReplay((s) => s.loading);
  const error = useReplay((s) => s.error);
  return (
    <div className="flex h-full items-center justify-center px-4">
      {error ? (
        <div className="max-w-lg text-center [overflow-wrap:anywhere]">
          <p className="text-red-400">{error}</p>
          <button
            onClick={() => useReplay.getState().goHome()}
            className="mt-3 rounded border border-zinc-700 px-2.5 py-1 text-xs font-semibold text-zinc-200 hover:border-zinc-500 hover:text-white"
          >
            ← All races
          </button>
        </div>
      ) : (
        <div className="w-full max-w-72">
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
        <h1 className="mb-3 flex justify-center text-zinc-100">
          <Logo className="h-10 w-auto" />
        </h1>
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
  const circuit = useReplay((s) => s.circuit);
  const driver = useReplay((s) => s.driver);
  const session = useReplay((s) => s.session);
  const loading = useReplay((s) => s.loading);
  const supported = useLibrary((s) => s.supported);
  const link = useLibrary((s) => s.link);
  const live = useReplay((s) => s.mode === "live");
  const streaming = useReplay((s) => s.stream != null);
  const compare = useReplay(comparing);
  const spoilerPrompt = useSpoilerPrompt();

  useEffect(() => {
    void (async () => {
      await useLibrary.getState().init();
      await useReplay.getState().loadIndex();
      // Home, unless the link opens a session (or offers to download it) or live mode.
      applyUrl();
    })();
  }, []);

  if (!supported) return <Unsupported />;
  // The screenshot (S) works on every page, not only a session's.
  let page: ReactNode = null;
  if (view === "home") page = <Home />;
  else if (view === "circuit" && circuit) page = <CircuitPage slug={circuit} />;
  else if (view === "driver" && driver) page = <DriverPage id={driver} />;
  // Live mode before there's a live session to show: connecting, relay offline, or no race right now.
  else if (!session && live) page = <LiveScreen />;
  // A shared link to a session that isn't downloaded: offer to.
  else if (link && !live && !loading && session?.meta.sessionKey !== link.key) page = <DownloadPrompt sessionKey={link.key} />;
  // Watched while it downloads, before it can start.
  else if (!session && streaming) page = <StreamLoading />;
  else if (!session) page = <LoadingScreen />;
  if (page) {
    return (
      <>
        {page}
        <ShareShot />
      </>
    );
  }
  // Qualifying sessions open in the lap comparison view, as do practice's Fastest laps.
  if (compare) {
    return (
      <>
        <QualiView overlay={loading && <div className="absolute inset-0 z-10 bg-zinc-950/80"><LoadingScreen /></div>} />
        <ReadyToast />
        <ShareShot />
      </>
    );
  }

  return (
    <>
      {/* Behind the spoiler prompt: blurred, and out of reach of focus and clicks. */}
      {/* The middle row takes what the header and timeline leave; on a phone the grid scrolls inside it (Grid.tsx). */}
      {/* One column clamped to the viewport: a long session name truncates instead of widening the page (a phone). */}
      <div className="relative grid h-full grid-cols-[minmax(0,1fr)] grid-rows-[auto_minmax(0,1fr)_auto]" inert={spoilerPrompt}>
        <Header />
        <div className="relative grid min-h-0 min-w-0 grid-rows-[minmax(0,1fr)]">
          <Grid />
          <StreamBuffering />
        </div>
        <Timeline />
        {loading && (
          <div className="absolute inset-0 z-10 bg-zinc-950/80">
            <LoadingScreen />
          </div>
        )}
      </div>
      <SpoilerPrompt />
      <ReadyToast />
      <ShareShot />
    </>
  );
}
