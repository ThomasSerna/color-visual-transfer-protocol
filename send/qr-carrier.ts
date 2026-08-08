import type { FrameContext, VisualEncoder } from "../shared/carrier";
import { createQrEncodeWorker } from "./qr-worker-factory";
import type { QrErrorCorrectionLevel, QrRenderedFrame } from "./qr-render";

type WorkerResponse =
  | {
      readonly id: number;
      readonly status: "valid";
      readonly width: number;
      readonly height: number;
      readonly rgba: ArrayBuffer;
      readonly version: number;
      readonly moduleCount: number;
    }
  | { readonly id: number; readonly status: "rejected"; readonly reason: string };

/** Real QR_LEGACY carrier adapter; all qrcode/raster work stays off the UI thread. */
export class QrLegacyVisualEncoder implements VisualEncoder<FrameContext> {
  readonly carrier = "QR_LEGACY" as const;
  private readonly worker = createQrEncodeWorker();
  private readonly pending = new Map<
    number,
    { resolve: (frame: QrRenderedFrame) => void; reject: (error: Error) => void }
  >();
  private nextId = 0;
  private disposed = false;

  constructor(
    readonly errorCorrectionLevel: QrErrorCorrectionLevel,
    readonly margin: number,
  ) {
    this.worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const response = event.data;
      const pending = this.pending.get(response.id);
      if (!pending) return;
      this.pending.delete(response.id);
      if (response.status === "rejected") {
        pending.reject(new Error(response.reason));
        return;
      }
      pending.resolve({
        width: response.width,
        height: response.height,
        rgba: new Uint8ClampedArray(response.rgba),
        version: response.version,
        moduleCount: response.moduleCount,
      });
    };
    const fail = () => this.failAll(new Error("The QR encoder worker stopped unexpectedly."));
    this.worker.onerror = fail;
    this.worker.onmessageerror = fail;
  }

  encode(innerFrame: Uint8Array, context: FrameContext): Promise<QrRenderedFrame> {
    if (this.disposed) return Promise.reject(new Error("QR encoder is disposed."));
    const id = this.nextId++;
    const transferred = Uint8Array.from(innerFrame);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage(
        {
          id,
          innerFrame: transferred.buffer,
          context,
          errorCorrectionLevel: this.errorCorrectionLevel,
          margin: this.margin,
        },
        [transferred.buffer],
      );
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.worker.terminate();
    this.failAll(new Error("QR encoder was disposed."));
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

export function createQrLegacyEncoder(
  errorCorrectionLevel: QrErrorCorrectionLevel,
  margin: number,
): QrLegacyVisualEncoder {
  return new QrLegacyVisualEncoder(errorCorrectionLevel, margin);
}
