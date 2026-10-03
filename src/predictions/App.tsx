// Called It's page: /predictions makes a call, /predictions/<id> is one (worker/index.ts serves both).

import { useEffect, useState } from "react";
import { Wordmark } from "./Card";
import { Compose } from "./Compose";
import { ID_PATTERN, predictionPath, type Prediction } from "./model";
import { Permalink } from "./Permalink";

const idIn = (path: string) => {
  const id = /^\/predictions\/([^/]+)\/?$/.exec(path)?.[1];
  return id && ID_PATTERN.test(id) ? id : id ? "missing" : null;
};

export function App() {
  const [path, setPath] = useState(location.pathname);
  // The call just locked in this tab: shown at once, with its "Locked in." moment.
  const [fresh, setFresh] = useState<Prediction | null>(null);
  useEffect(() => {
    const pop = () => {
      setFresh(null);
      setPath(location.pathname);
    };
    addEventListener("popstate", pop);
    return () => removeEventListener("popstate", pop);
  }, []);
  const go = (to: string, p: Prediction | null = null) => {
    history.pushState(null, "", to);
    setFresh(p);
    setPath(to);
    scrollTo({ top: 0 });
  };
  const id = idIn(path);

  return (
    <div className="mx-auto flex min-h-full max-w-5xl flex-col px-5 pb-12 pt-[max(1.25rem,env(safe-area-inset-top))] sm:px-8">
      <header className="flex items-center justify-between py-2">
        <a
          href="/predictions"
          onClick={(e) => {
            e.preventDefault();
            go("/predictions");
          }}
          className="text-white"
        >
          <Wordmark className="ci-wordmark ci-wordmark-sm" />
        </a>
        <a href="/" className="text-sm text-zinc-500 hover:text-zinc-200">
          by Pitwall
        </a>
      </header>

      <main className="pt-6 sm:pt-10">
        {id ? <Permalink key={id} id={id} fresh={fresh?.id === id ? fresh : null} onNew={() => go("/predictions")} /> : <Compose hero={<Hero />} onLocked={(p) => go(predictionPath(p.id), p)} />}
      </main>
    </div>
  );
}

function Hero() {
  return (
    <div>
      <h1 className="ci-display text-[3.4rem] font-black uppercase italic leading-[0.86] text-white sm:text-7xl">
        Receipts for your <span className="text-[#ff1e28]">pit calls.</span>
      </h1>
      <p className="mt-5 max-w-xl text-lg text-zinc-400">
        Call who pits first before lights out. Our server stamps the time and nobody can edit it, not even you. When you're right, you've got proof.
      </p>
    </div>
  );
}
