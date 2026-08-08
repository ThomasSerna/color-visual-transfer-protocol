import type {
  CapturedFrame,
  Color4PaletteId,
  DecodeResult,
  RejectReason,
  VisualDecoder,
} from "../shared/color4";
import type { BrowserCarrierDiagnostics } from "../shared/carrier";

type BrowserDecodeResult =
  | {
      status: "valid";
      innerFrame: Uint8Array;
      diagnostics: DecodeResult extends { status: "valid"; diagnostics: infer D }
        ? D & BrowserCarrierDiagnostics
        : never;
    }
  | {
      status: "rejected";
      reason: RejectReason;
      diagnostics: DecodeResult extends { status: "rejected"; diagnostics: infer D }
        ? D & BrowserCarrierDiagnostics
        : never;
    };

type WorkerResponse =
  | {
      id: number;
      status: "valid";
      innerFrame: ArrayBuffer;
      diagnostics: BrowserDecodeResult["diagnostics"];
    }
  | {
      id: number;
      status: "rejected";
      reason: RejectReason;
      diagnostics: BrowserDecodeResult["diagnostics"];
    };

export class Color4CameraDecoder implements VisualDecoder {
  readonly carrier = "COLOR_4" as const;
  private readonly worker = new Worker(new URL("./color4-worker.ts", import.meta.url), {
    type: "module",
  });
  private pending:
    | { id: number; resolve: (result: BrowserDecodeResult) => void; reject: (error: Error) => void }
    | undefined;
  private nextId = 0;
  private disposed = false;

  constructor(readonly paletteId: Color4PaletteId) {
    this.worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      if (!this.pending || event.data.id !== this.pending.id) return;
      const pending = this.pending;
      this.pending = undefined;
      if (event.data.status === "valid") {
        pending.resolve({
          status: "valid",
          innerFrame: new Uint8Array(event.data.innerFrame),
          diagnostics: event.data.diagnostics,
        });
      } else pending.resolve(event.data);
    };
    const fail = () => this.failPending(new Error("The COLOR_4 decoder worker stopped unexpectedly."));
    this.worker.onerror = fail;
    this.worker.onmessageerror = fail;
  }

  get busy(): boolean {
    return this.pending !== undefined;
  }

  decode(frame: CapturedFrame): Promise<BrowserDecodeResult> {
    if (this.disposed) return Promise.reject(new Error("COLOR_4 decoder is disposed."));
    if (this.pending) return Promise.reject(new Error("COLOR_4 decoder accepts one frame at a time."));
    if (!(frame.source instanceof ImageData)) {
      return Promise.reject(new Error("COLOR_4 camera decoder requires ImageData."));
    }
    const id = this.nextId++;
    // captureFrame creates a fresh ImageData and never reuses it. Transfer its
    // backing store directly so a 1920×1440 capture does not incur another
    // full-frame copy before OpenCV.
    const source = frame.source.data;
    const rgba = source.byteOffset === 0 && source.byteLength === source.buffer.byteLength
      ? source
      : Uint8ClampedArray.from(source);
    return new Promise((resolve, reject) => {
      this.pending = { id, resolve, reject };
      this.worker.postMessage(
        {
          id,
          width: frame.source.width,
          height: frame.source.height,
          rgba: rgba.buffer,
          paletteId: this.paletteId,
        },
        [rgba.buffer],
      );
    });
  }

  private failPending(error: Error): void {
    const pending = this.pending;
    this.pending = undefined;
    pending?.reject(error);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.worker.terminate();
    this.failPending(new Error("COLOR_4 decoder was disposed."));
  }
}

export function createColor4Decoder(paletteId: Color4PaletteId): Color4CameraDecoder {
  return new Color4CameraDecoder(paletteId);
}
