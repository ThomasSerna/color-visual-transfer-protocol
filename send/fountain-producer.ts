import type { FountainSessionMetadata } from "./fountain-frame";
import { createFountainWorker } from "./fountain-worker-factory";
import type { FountainWorkerRequest, FountainWorkerResponse } from "./fountain-worker-protocol";

interface PendingFrame {
  readonly resolve: (frame: Uint8Array<ArrayBuffer>) => void;
  readonly reject: (error: Error) => void;
}

/**
 * UI-facing handle for the common LT/packFrame worker.
 *
 * The selected container remains available for settings-driven restarts, so
 * initialization copies it once and transfers that copy. Per-frame responses
 * are transferred without another copy; the existing visual adapters then own
 * their small, lookahead-bounded handoff to the renderer worker.
 */
export class FountainFrameProducer {
  readonly ready: Promise<FountainSessionMetadata>;
  private readonly worker: Worker;
  private readonly pending = new Map<number, PendingFrame>();
  private readonly resolveReady: (metadata: FountainSessionMetadata) => void;
  private readonly rejectReady: (error: Error) => void;
  private nextId = 0;
  private settledReady = false;
  private disposed = false;
  private failure: Error | undefined;

  constructor(
    payload: Uint8Array,
    blockLen: number,
    sessionId: number,
    worker: Worker = createFountainWorker(),
  ) {
    this.worker = worker;
    let resolveReady!: (metadata: FountainSessionMetadata) => void;
    let rejectReady!: (error: Error) => void;
    this.ready = new Promise((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    this.resolveReady = resolveReady;
    this.rejectReady = rejectReady;

    this.worker.onmessage = (event: MessageEvent<FountainWorkerResponse>) => {
      const response = event.data;
      if (response.kind === "ready") {
        if (this.settledReady) return;
        this.settledReady = true;
        this.resolveReady(response.metadata);
        return;
      }
      if (response.kind === "error") {
        if (response.id === undefined) {
          this.failAll(new Error(response.reason));
          return;
        }
        const pending = this.pending.get(response.id);
        if (!pending) return;
        this.pending.delete(response.id);
        pending.reject(new Error(response.reason));
        return;
      }
      const pending = this.pending.get(response.id);
      if (!pending) return;
      this.pending.delete(response.id);
      pending.resolve(new Uint8Array(response.innerFrame));
    };
    const fail = () => this.failAll(new Error("The fountain encoder worker stopped unexpectedly."));
    this.worker.onerror = fail;
    this.worker.onmessageerror = fail;

    // Keep selectedFile.payload usable for carrier/profile restarts. This is
    // the session's only full-container copy; all following messages are one
    // packed optical frame and are bounded by the sender lookahead.
    const transferred = Uint8Array.from(payload);
    this.post(
      { kind: "init", payload: transferred.buffer, blockLen, sessionId },
      [transferred.buffer],
    );
  }

  async encode(sequence: number): Promise<Uint8Array<ArrayBuffer>> {
    if (this.disposed) throw new Error("The fountain encoder is disposed.");
    if (this.failure) throw this.failure;
    await this.ready;
    if (this.disposed) throw new Error("The fountain encoder is disposed.");
    if (this.failure) throw this.failure;
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.post({ kind: "frame", id, sequence });
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.worker.terminate();
    this.failAll(new Error("The fountain encoder was disposed."));
  }

  private post(message: FountainWorkerRequest, transfer: Transferable[] = []): void {
    try {
      this.worker.postMessage(message, transfer);
    } catch (error) {
      this.failAll(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private failAll(error: Error): void {
    this.failure ??= error;
    if (!this.settledReady) {
      this.settledReady = true;
      this.rejectReady(error);
    }
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

export function createFountainFrameProducer(
  payload: Uint8Array,
  blockLen: number,
  sessionId: number,
): FountainFrameProducer {
  return new FountainFrameProducer(payload, blockLen, sessionId);
}
