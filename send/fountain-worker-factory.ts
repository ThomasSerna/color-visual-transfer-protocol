/** Served/PWA sender: the common fountain producer is a cached module worker. */
export function createFountainWorker(): Worker {
  return new Worker(new URL("./fountain-worker.ts", import.meta.url), { type: "module" });
}
