// Standalone sender: file:// cannot fetch a module-worker URL, so Vite embeds
// the same fountain implementation behind a blob URL.
import InlineFountainWorker from "./fountain-worker.ts?worker&inline";

export function createFountainWorker(): Worker {
  return new InlineFountainWorker();
}
