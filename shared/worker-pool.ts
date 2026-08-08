// Fixed-slot pool of decode workers.
//
// The subtle part is slot identity: every worker's message handler closes over
// its own index, so growing and shrinking the pool has to leave the surviving
// workers' indices alone. Shrinking from the end is what makes that true, and
// it is why this is worth having on its own rather than inline in the receiver.
//
// Each worker holds its own ~940 KB zxing WASM instance, so the pool is also
// how the receiver reclaims that memory the moment the last frame is in.

export interface PoolWorker {
  onmessage: ((event: MessageEvent) => void) | null;
  onerror?: ((event: ErrorEvent) => void) | null;
  onmessageerror?: ((event: MessageEvent) => void) | null;
  postMessage(message: unknown, transfer: Transferable[]): void;
  terminate(): void;
}

interface DecodeMessage {
  id: number;
  bytes: Uint8Array | null;
}

export class DecodeWorkerPool {
  private readonly workers: PoolWorker[] = [];
  private readonly busy: boolean[] = [];
  private readonly available: boolean[] = [];
  private readonly requestIds: Array<number | undefined> = [];

  constructor(
    private readonly create: () => PoolWorker,
    private readonly onDecoded: (bytes: Uint8Array, id: number) => void,
    private readonly onSettled?: (bytes: Uint8Array | null, id?: number) => void,
    private readonly onWorkerError?: () => void,
  ) {}

  get size(): number {
    return this.workers.length;
  }

  get busyCount(): number {
    return this.busy.filter(Boolean).length;
  }

  private bind(worker: PoolWorker, slot: number): void {
    worker.onmessage = (event: MessageEvent) => {
      if (this.workers[slot] !== worker) return;
      const { id, bytes } = event.data as DecodeMessage;
      if (id === -1) return; // warm-up ping, no frame attached
      this.busy[slot] = false;
      this.requestIds[slot] = undefined;
      if (bytes) this.onDecoded(bytes, id);
      this.onSettled?.(bytes, id);
    };
    const failed = (event: Event) => {
      event.preventDefault?.();
      if (this.workers[slot] !== worker) return;
      const wasBusy = this.busy[slot] === true;
      const requestId = this.requestIds[slot];
      this.busy[slot] = false;
      this.requestIds[slot] = undefined;
      this.available[slot] = false;
      worker.terminate();
      if (wasBusy) this.onSettled?.(null, requestId);
      this.onWorkerError?.();
    };
    worker.onerror = failed;
    worker.onmessageerror = failed;
  }

  /** Grow or shrink in place. Terminating a busy worker just drops the frame it
   *  held, which the fountain absorbs like any other miss. */
  resize(count: number): void {
    while (this.workers.length > Math.max(0, count)) {
      const wasBusy = this.busy.pop() === true;
      const requestId = this.requestIds.pop();
      this.workers.pop()!.terminate();
      this.available.pop();
      if (wasBusy) this.onSettled?.(null, requestId);
    }
    while (this.workers.length < count) {
      const slot = this.workers.length;
      const worker = this.create();
      this.workers.push(worker);
      this.busy.push(false);
      this.available.push(true);
      this.requestIds.push(undefined);
      this.bind(worker, slot);
    }
  }

  /** Hand a frame to a free worker. False when every worker is busy — the
   *  caller drops the frame rather than queueing it, because a stale frame is
   *  worth less than the next one. */
  submit(message: unknown, transfer: Transferable[]): boolean {
    const slot = this.busy.findIndex((isBusy, index) => !isBusy && this.available[index] === true);
    if (slot === -1) return false;
    this.busy[slot] = true;
    const requestId =
      typeof message === "object" && message !== null && "id" in message &&
      typeof (message as { id?: unknown }).id === "number"
        ? (message as { id: number }).id
        : undefined;
    this.requestIds[slot] = requestId;
    try {
      this.workers[slot]!.postMessage(message, transfer);
      return true;
    } catch {
      this.workers[slot]!.onerror?.(new ErrorEvent("error"));
      return false;
    }
  }
}
