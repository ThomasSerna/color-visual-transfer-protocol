import type {
  CapturedFrame,
  Color4PaletteId,
  FrameDiagnostics,
  RejectReason,
  VisualDecoder,
} from "../shared/color4";
import type { BrowserCarrierDiagnostics } from "../shared/carrier";
import {
  DEFAULT_COLOR4_CANONICAL_SCALE,
  DEFAULT_COLOR4_DETECTION_DIMENSION,
} from "../shared/receiver-defaults";
import type {
  Color4WorkerDebugFrame,
  Color4WorkerDebugOptions,
  Color4WorkerDiagnostics,
  Color4WorkerResponse,
} from "./color4-worker-protocol";

export interface Color4BrowserDecodeOptions {
  readonly captureMs?: number;
  readonly debug?: Color4WorkerDebugOptions;
}

type BrowserDecodeResult =
  | {
      status: "valid";
      innerFrame: Uint8Array;
      diagnostics: FrameDiagnostics & BrowserCarrierDiagnostics;
      debug?: Color4WorkerDebugFrame;
    }
  | {
      status: "rejected";
      reason: RejectReason;
      diagnostics: FrameDiagnostics & BrowserCarrierDiagnostics;
      debug?: Color4WorkerDebugFrame;
    };

interface PendingDecode {
  readonly id: number;
  readonly startedAt: number;
  readonly resolve: (result: BrowserDecodeResult) => void;
  readonly reject: (error: Error) => void;
}

const defaultDebug: Color4WorkerDebugOptions = Object.freeze({
  enabled: false,
  view: "fiducials",
  generation: 0,
  canonicalScale: DEFAULT_COLOR4_CANONICAL_SCALE,
  maxDetectionDimension: DEFAULT_COLOR4_DETECTION_DIMENSION,
  emitPlane: false,
  snapshot: false,
});

export class Color4CameraDecoder implements VisualDecoder {
  readonly carrier = "COLOR_4" as const;
  private readonly worker = new Worker(new URL("./color4-worker.ts", import.meta.url), {
    type: "module",
  });
  private pending: PendingDecode | undefined;
  private nextId = 0;
  private disposed = false;
  private readyResolve!: (milliseconds: number) => void;
  private readyReject!: (error: Error) => void;
  private reportInitOnNextFrame = true;
  private initMs = 0;
  readonly ready = new Promise<number>((resolve, reject) => {
    this.readyResolve = resolve;
    this.readyReject = reject;
  });

  constructor(readonly paletteId: Color4PaletteId) {
    this.worker.onmessage = (event: MessageEvent<Color4WorkerResponse>) => {
      if (event.data.kind === "ready") {
        this.initMs = event.data.opencvInitMs;
        this.readyResolve(event.data.opencvInitMs);
        return;
      }
      if (!this.pending || event.data.id !== this.pending.id) return;
      const pending = this.pending;
      this.pending = undefined;
      const diagnostics = this.withBrowserTimings(
        event.data.diagnostics,
        performance.now() - pending.startedAt,
      );
      if (event.data.status === "valid") {
        pending.resolve({
          status: "valid",
          innerFrame: new Uint8Array(event.data.innerFrame),
          diagnostics,
          ...(event.data.debug ? { debug: event.data.debug } : {}),
        });
      } else {
        pending.resolve({
          status: "rejected",
          reason: event.data.reason,
          diagnostics,
          ...(event.data.debug ? { debug: event.data.debug } : {}),
        });
      }
    };
    const fail = () => this.fail(new Error("The COLOR_4 decoder worker stopped unexpectedly."));
    this.worker.onerror = fail;
    this.worker.onmessageerror = fail;
    this.worker.postMessage({ kind: "init", id: -1 });
  }

  get busy(): boolean {
    return this.pending !== undefined;
  }

  async decode(
    frame: CapturedFrame,
    options: Color4BrowserDecodeOptions = {},
  ): Promise<BrowserDecodeResult> {
    if (this.disposed) throw new Error("COLOR_4 decoder is disposed.");
    await this.ready;
    if (this.disposed) throw new Error("COLOR_4 decoder is disposed.");
    if (this.pending) throw new Error("COLOR_4 decoder accepts one frame at a time.");
    if (!(frame.source instanceof ImageData)) {
      throw new Error("COLOR_4 camera decoder requires ImageData.");
    }
    const id = this.nextId++;
    // captureFrame creates a fresh ImageData and never reuses it. Transfer its
    // backing store directly so a 1920×1440 capture does not incur another
    // full-frame copy before OpenCV.
    const source = frame.source.data;
    const rgba: Uint8ClampedArray<ArrayBuffer> = source.buffer instanceof ArrayBuffer &&
        source.byteOffset === 0 && source.byteLength === source.buffer.byteLength
      ? new Uint8ClampedArray(source.buffer)
      : Uint8ClampedArray.from(source);
    return new Promise((resolve, reject) => {
      this.pending = { id, startedAt: performance.now(), resolve, reject };
      this.worker.postMessage(
        {
          kind: "decode",
          id,
          width: frame.source.width,
          height: frame.source.height,
          rgba: rgba.buffer,
          paletteId: this.paletteId,
          capturedAt: frame.timestamp,
          captureMs: Math.max(0, options.captureMs ?? 0),
          debug: options.debug ?? defaultDebug,
        },
        [rgba.buffer],
      );
    });
  }

  private withBrowserTimings(
    diagnostics: Color4WorkerDiagnostics,
    roundTripTotal: number,
  ): FrameDiagnostics & BrowserCarrierDiagnostics {
    const timings: NonNullable<BrowserCarrierDiagnostics["vision"]>["timings"] = {
      ...diagnostics.vision?.timings,
      roundTripTotal: Math.max(0, roundTripTotal),
      ...(this.reportInitOnNextFrame ? { opencvInit: this.initMs } : {}),
    };
    if (this.reportInitOnNextFrame) {
      this.reportInitOnNextFrame = false;
    }
    return {
      ...diagnostics,
      vision: diagnostics.vision ? { ...diagnostics.vision, timings } : undefined,
    };
  }

  private fail(error: Error): void {
    this.readyReject(error);
    const pending = this.pending;
    this.pending = undefined;
    pending?.reject(error);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.worker.terminate();
    this.fail(new Error("COLOR_4 decoder was disposed."));
  }
}

export function createColor4Decoder(paletteId: Color4PaletteId): Color4CameraDecoder {
  return new Color4CameraDecoder(paletteId);
}
