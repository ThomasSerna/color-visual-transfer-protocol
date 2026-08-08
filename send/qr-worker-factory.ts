/** Served/PWA sender: the QR renderer is a cached module worker. */
export function createQrEncodeWorker(): Worker {
  return new Worker(new URL("./qr-worker.ts", import.meta.url), { type: "module" });
}
