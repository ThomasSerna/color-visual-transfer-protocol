import type {
  CapturedFrame,
  FrameDiagnostics,
  RejectReason,
  VisualDecoder,
} from "../shared/carrier";
import type { BrowserCarrierDiagnostics } from "../shared/carrier";
import { parseFrame } from "../shared/protocol";
import { DecodeWorkerPool, type PoolWorker } from "../shared/worker-pool";
import { createDecodeWorker } from "./worker-factory";

export type QrBrowserDecodeResult =
  | {
      readonly status: "valid";
      readonly innerFrame: Uint8Array;
      readonly diagnostics: QrBrowserDiagnostics;
    }
  | {
      readonly status: "rejected";
      readonly reason: RejectReason;
      readonly diagnostics: QrBrowserDiagnostics;
    };

export type QrBrowserDiagnostics = FrameDiagnostics & BrowserCarrierDiagnostics;

interface PendingDecode {
  readonly startedAt: number;
  readonly resolve: (result: QrBrowserDecodeResult) => void;
  readonly reject: (error: Error) => void;
}

export interface QrLegacyDecoderOptions {
  readonly workerCount: number;
  readonly onFatal?: (error: Error) => void;
  /** Test seam; production always creates the self-hosted ZXing worker. */
  readonly createWorker?: () => PoolWorker;
  readonly now?: () => number;
}

/**
 * QR_LEGACY decoder adapter around the complete ZXing worker pool.
 *
 * It accepts camera-neutral CapturedFrame values and yields only validated
 * Decimen packFrame bytes, matching the fail-closed COLOR_4 adapter boundary.
 */
export class QrLegacyCameraDecoder implements VisualDecoder {
  readonly carrier = "QR_LEGACY" as const;
  private readonly pool: DecodeWorkerPool;
  private readonly pending = new Map<number, PendingDecode>();
  private readonly now: () => number;
  private readonly onFatal?: (error: Error) => void;
  private nextId = 0;
  private disposed = false;

  constructor(options: QrLegacyDecoderOptions) {
    this.now = options.now ?? (() => performance.now());
    this.onFatal = options.onFatal;
    this.pool = new DecodeWorkerPool(
      options.createWorker ?? createDecodeWorker,
      () => undefined,
      (bytes, id) => {
        if (id !== undefined) this.settle(id, bytes);
      },
      () => this.workerFailed(),
    );
    this.resize(options.workerCount);
  }

  get size(): number {
    return this.pool.size;
  }

  get busy(): boolean {
    return this.pool.size === 0 || this.pool.busyCount === this.pool.size;
  }

  resize(workerCount: number): void {
    if (this.disposed) return;
    this.pool.resize(workerCount);
  }

  decode(frame: CapturedFrame): Promise<QrBrowserDecodeResult> {
    if (this.disposed) return Promise.reject(new Error("QR decoder is disposed."));
    if (!(frame.source instanceof ImageData)) {
      return Promise.reject(new Error("QR camera decoder requires ImageData."));
    }
    if (this.busy) return Promise.reject(new Error("All QR decoder workers are busy."));

    const id = this.nextId++;
    // The ImageData has just been captured for this adapter and has no other
    // consumer. Transfer its backing buffer to avoid copying an entire camera
    // frame before ZXing sees it.
    const buffer = frame.source.data.buffer;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { startedAt: this.now(), resolve, reject });
      const submitted = this.pool.submit(
        { id, buf: buffer, w: frame.source.width, h: frame.source.height },
        [buffer],
      );
      if (!submitted) {
        this.pending.delete(id);
        reject(new Error("All QR decoder workers are busy."));
      }
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.failAll(new Error("QR decoder was disposed."));
    this.pool.resize(0);
  }

  private settle(id: number, bytes: Uint8Array | null): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    const decodeMs = Math.max(0, this.now() - pending.startedAt);
    const common = {
      erasures: 0,
      correctedErrors: 0,
      correctedBytes: 0,
      correctedShards: 0,
      decodeMs,
    } as const;
    if (!bytes) {
      pending.resolve({
        status: "rejected",
        reason: "no-symbol",
        diagnostics: {
          ...common,
          stage: "classification",
          candidates: 0,
          rejectReason: "no-symbol",
        },
      });
      return;
    }
    if (!parseFrame(bytes)) {
      pending.resolve({
        status: "rejected",
        reason: "invalid-inner-frame",
        diagnostics: {
          ...common,
          stage: "wire",
          candidates: 1,
          rejectReason: "invalid-inner-frame",
        },
      });
      return;
    }
    pending.resolve({
      status: "valid",
      innerFrame: bytes,
      diagnostics: { ...common, stage: "wire", candidates: 1 },
    });
  }

  private workerFailed(): void {
    const error = new Error("The QR decoder worker stopped unexpectedly.");
    this.failAll(error);
    this.onFatal?.(error);
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

export function createQrLegacyDecoder(options: QrLegacyDecoderOptions): QrLegacyCameraDecoder {
  return new QrLegacyCameraDecoder(options);
}
