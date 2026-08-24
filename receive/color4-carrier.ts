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
  Color4WorkerFrameSource,
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

function frameSource(
  source: CapturedFrame["source"],
): { source: Color4WorkerFrameSource; transfer: Transferable[] } {
  if (!(source instanceof ImageData)) {
    return { source: { kind: "bitmap", bitmap: source }, transfer: [source] };
  }
  // captureFrame creates a fresh ImageData and never reuses it. Transfer its
  // backing store directly so a 1920×1440 capture does not incur another
  // full-frame copy before OpenCV.
  const data = source.data;
  const rgba: Uint8ClampedArray<ArrayBuffer> = data.buffer instanceof ArrayBuffer &&
      data.byteOffset === 0 && data.byteLength === data.buffer.byteLength
    ? new Uint8ClampedArray(data.buffer)
    : Uint8ClampedArray.from(data);
  return { source: { kind: "rgba", rgba: rgba.buffer }, transfer: [rgba.buffer] };
}

/** One vision worker and whatever frame it currently owns. */
interface DecoderSlot {
  readonly worker: Worker;
  pending: PendingDecode | undefined;
  initMs: number;
}

export const DEFAULT_COLOR4_WORKER_COUNT = 1;
export const MAXIMUM_COLOR4_WORKER_COUNT = 3;

export function clampColor4WorkerCount(requested: number): number {
  if (!Number.isFinite(requested)) return DEFAULT_COLOR4_WORKER_COUNT;
  return Math.max(1, Math.min(MAXIMUM_COLOR4_WORKER_COUNT, Math.floor(requested)));
}

/**
 * A fixed pool of COLOR_4 vision workers.
 *
 * This was a single worker holding one frame at a time, which put a hard
 * ceiling of `1 / workerLatency` on the decode rate no matter how fast the
 * camera ran: the physical exports show 93% of captures dropped as
 * `skippedWhileBusy`. Frames are independent — the fountain decoder neither
 * needs them in order nor cares which ones arrive — so the only thing standing
 * between the receiver and N concurrent decodes was the slot count.
 *
 * The pool defaults to one worker regardless. Each carries its own OpenCV WASM
 * instance, and a phone is the target device; a second slot is a deliberate
 * choice a user makes on hardware that can afford it.
 */
export class Color4CameraDecoder implements VisualDecoder {
  readonly carrier = "COLOR_4" as const;
  private readonly slots: DecoderSlot[] = [];
  private nextId = 0;
  private disposed = false;
  private readyResolve!: (milliseconds: number) => void;
  private readyReject!: (error: Error) => void;
  private pendingReady: number;
  private reportInitOnNextFrame = true;
  readonly ready = new Promise<number>((resolve, reject) => {
    this.readyResolve = resolve;
    this.readyReject = reject;
  });

  constructor(readonly paletteId: Color4PaletteId, workerCount = DEFAULT_COLOR4_WORKER_COUNT) {
    const count = clampColor4WorkerCount(workerCount);
    this.pendingReady = count;
    for (let index = 0; index < count; index++) this.slots.push(this.createSlot());
  }

  private createSlot(): DecoderSlot {
    const worker = new Worker(new URL("./color4-worker.ts", import.meta.url), {
      type: "module",
    });
    const slot: DecoderSlot = { worker, pending: undefined, initMs: 0 };
    worker.onmessage = (event: MessageEvent<Color4WorkerResponse>) => {
      if (event.data.kind === "ready") {
        slot.initMs = event.data.opencvInitMs;
        // Every worker loads its own WASM, so the pool is ready when the
        // slowest one is. Report that worst case rather than the first.
        this.pendingReady--;
        if (this.pendingReady <= 0) {
          this.readyResolve(Math.max(...this.slots.map((entry) => entry.initMs)));
        }
        return;
      }
      const pending = slot.pending;
      if (!pending || event.data.id !== pending.id) return;
      slot.pending = undefined;
      const diagnostics = this.withBrowserTimings(
        event.data.diagnostics,
        performance.now() - pending.startedAt,
        slot,
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
    worker.onerror = fail;
    worker.onmessageerror = fail;
    worker.postMessage({ kind: "init", id: -1 });
    return slot;
  }

  get size(): number {
    return this.slots.length;
  }

  /** True only when no slot is free: the caller should drop the frame. */
  get busy(): boolean {
    return this.slots.every((slot) => slot.pending !== undefined);
  }

  async decode(
    frame: CapturedFrame,
    options: Color4BrowserDecodeOptions = {},
  ): Promise<BrowserDecodeResult> {
    if (this.disposed) throw new Error("COLOR_4 decoder is disposed.");
    await this.ready;
    if (this.disposed) {
      if (frame.source instanceof ImageData === false) frame.source.close();
      throw new Error("COLOR_4 decoder is disposed.");
    }
    const slot = this.slots.find((candidate) => candidate.pending === undefined);
    if (!slot) throw new Error("Every COLOR_4 decoder worker is busy.");
    const id = this.nextId++;
    const { source, transfer } = frameSource(frame.source);
    return new Promise((resolve, reject) => {
      slot.pending = { id, startedAt: performance.now(), resolve, reject };
      slot.worker.postMessage(
        {
          kind: "decode",
          id,
          width: frame.source.width,
          height: frame.source.height,
          source,
          paletteId: this.paletteId,
          capturedAt: frame.timestamp,
          captureMs: Math.max(0, options.captureMs ?? 0),
          debug: options.debug ?? defaultDebug,
        },
        transfer,
      );
    });
  }

  private withBrowserTimings(
    diagnostics: Color4WorkerDiagnostics,
    roundTripTotal: number,
    slot: DecoderSlot,
  ): FrameDiagnostics & BrowserCarrierDiagnostics {
    const timings: NonNullable<BrowserCarrierDiagnostics["vision"]>["timings"] = {
      ...diagnostics.vision?.timings,
      roundTripTotal: Math.max(0, roundTripTotal),
      ...(this.reportInitOnNextFrame ? { opencvInit: slot.initMs } : {}),
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
    for (const slot of this.slots) {
      const pending = slot.pending;
      slot.pending = undefined;
      pending?.reject(error);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const slot of this.slots) slot.worker.terminate();
    this.fail(new Error("COLOR_4 decoder was disposed."));
  }
}

export function createColor4Decoder(
  paletteId: Color4PaletteId,
  workerCount = DEFAULT_COLOR4_WORKER_COUNT,
): Color4CameraDecoder {
  return new Color4CameraDecoder(paletteId, workerCount);
}
