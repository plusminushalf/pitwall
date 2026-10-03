// The live worker: the browser's live engine (./vaultEngine.ts) off the page's main thread. The page (./vault.ts)
// starts it while live mode runs through the vault with a connected account, and terminates it when it stops.

import { VaultEngine, type FromEngine, type ToEngine } from "./vaultEngine";

const scope = self as unknown as {
  postMessage(m: FromEngine, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent<ToEngine>) => void) | null;
};

const engine = new VaultEngine({
  post: (m, transfer = []) => scope.postMessage(m, transfer),
  log: (line) => console.info(line),
  warn: (line) => console.warn(line),
});

scope.onmessage = (e) => engine.handle(e.data);
