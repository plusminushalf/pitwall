import { useEffect, useState } from "react";
import { DriverPanel } from "./components/DriverPanel";
import { DownloadPrompt } from "./components/DownloadPrompt";
import { EventFeed } from "./components/EventFeed";
import { Header } from "./components/Header";
import { LiveControl, LiveScreen } from "./components/LiveControl";
import { Timeline } from "./components/Timeline";
import { TimingTower } from "./components/TimingTower";
import { TrackMap } from "./components/TrackMap";
import { QualiView } from "./components/quali/QualiView";
import { RacePicker } from "./components/RacePicker";
import { useKeyboard } from "./hooks/useKeyboard";
import { useReplayLoop } from "./hooks/useReplayLoop";
import { readUrlState, useUrlSync } from "./hooks/useUrlState";
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
            onClick={() => useLibrary.getState().openPicker()}
            className="mt-3 rounded border border-zinc-700 px-2.5 py-1 text-xs font-semibold text-zinc-200 hover:border-zinc-500 hover:text-white"
          >
            Browse races
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
  const session = useReplay((s) => s.session);
  const loading = useReplay((s) => s.loading);
  const indexSize = useReplay((s) => s.index.length);
  const pickerOpen = useLibrary((s) => s.open);
  const supported = useLibrary((s) => s.supported);
  const link = useLibrary((s) => s.link);
  const live = useReplay((s) => s.mode === "live");
  // The library has been read (or failed to be): until then an empty index doesn't mean a first run.
  const [indexChecked, setIndexChecked] = useState(false);

  useEffect(() => {
    const { loadIndex, loadSession, enterLive } = useReplay.getState();
    void (async () => {
      await useLibrary.getState().init();
      await loadIndex();
      setIndexChecked(true);
      const url = readUrlState();
      if (url.live) return enterLive({ session: url.session, t: url.t, drivers: url.drivers, focus: url.focus });
      const opts = { t: url.t, drivers: url.drivers, focus: url.focus };
      const index = useReplay.getState().index;
      if (url.session != null) {
        // A shared link: open it if it's here, otherwise offer to download it (then open it at `t`).
        if (index.some((e) => e.sessionKey === url.session)) loadSession(url.session, opts);
        else useLibrary.getState().setLink({ key: url.session, opts });
        return;
      }
      const key = index.at(-1)?.sessionKey;
      if (key != null) loadSession(key);
    })();
  }, []);

  const picker = pickerOpen && <RacePicker />;
  if (!supported) return <Unsupported />;
  // Live mode before there's a live session to show: connecting, relay offline, or no race right now.
  if (!session && live) {
    return (
      <>
        <LiveScreen />
        {picker}
      </>
    );
  }
  if (!session && link && !loading) {
    return (
      <>
        <DownloadPrompt sessionKey={link.key} />
        {picker}
      </>
    );
  }
  // First run (nothing downloaded yet): the race picker is the whole app (live mode still works).
  if (!session && indexChecked && !loading && indexSize === 0) {
    return (
      <>
        <RacePicker firstRun />
        <div className="fixed right-4 top-4">
          <LiveControl />
        </div>
      </>
    );
  }
  if (!session) {
    return (
      <>
        <LoadingScreen />
        {picker}
      </>
    );
  }
  // Qualifying sessions open in the lap comparison view.
  if (session.meta.quali) {
    return (
      <>
        <QualiView overlay={loading && <div className="absolute inset-0 z-10 bg-zinc-950/80"><LoadingScreen /></div>} />
        {picker}
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
      {picker}
    </div>
  );
}
