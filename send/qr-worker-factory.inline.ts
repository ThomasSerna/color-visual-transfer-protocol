// Standalone sender: file:// cannot fetch a module-worker URL, so Vite embeds
// the exact same worker behind a blob URL.
import InlineQrEncodeWorker from "./qr-worker.ts?worker&inline";

export function createQrEncodeWorker(): Worker {
  return new InlineQrEncodeWorker();
}
