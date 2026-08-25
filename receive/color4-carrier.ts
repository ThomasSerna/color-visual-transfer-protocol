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
  Color4ClassifyRequest,
  Color4WorkerDebugFrame,
  Color4WorkerDebugOptions,
  Color4WorkerDiagnostics,
  Color4WorkerFrameSource,
  Color4WorkerResponse,
  Color4WorkerRole,
} from "./color4-worker-protocol";

export interface Color4BrowserDecodeOptions {
  readonly captureMs?: number;
  readonly debug?: Color4WorkerDebugOptions;
}

export type Color4GeometryPath = "cold" | "tracked" | "fallback" | "legacy";

export type BrowserDecodeResult =
  | {
      status: "valid";
      innerFrame: Uint8Array;
      diagnostics: FrameDiagnostics & BrowserCarrierDiagnostics;
      captureSequence: number;
      capturedAt: number;
      trackingGeneration: number;
      geometryPath: Color4GeometryPath;
      debug?: Color4WorkerDebugFrame;
    }
  | {
      status: "rejected";
      reason: RejectReason;
      diagnostics: FrameDiagnostics & BrowserCarrierDiagnostics;
      captureSequence: number;
      capturedAt: number;
      trackingGeneration: number;
      geometryPath: Color4GeometryPath;
      debug?: Color4WorkerDebugFrame;
    };

/** Opaque ownership token acquired before any capture-side allocation. */
export interface Color4CaptureReservation {
  readonly reservationId: number;
  readonly captureSequence: number;
  readonly trackingGeneration: number;
  readonly classifierSlot: number;
  readonly mode: "fast" | "legacy";
  readonly session: number;
}

interface PendingCallbacks {
  readonly startedAt: number;
  readonly resolve: (result: BrowserDecodeResult) => void;
  readonly reject: (error: Error) => void;
}

interface ReservationState {
  readonly token: Color4CaptureReservation;
  readonly classifier: ClassifierSlot;
  phase: "reserved" | "geometry" | "classifier";
  callbacks?: PendingCallbacks;
  watchdog?: ReturnType<typeof setTimeout>;
  capturedAt?: number;
  captureMs?: number;
  debug?: Color4WorkerDebugOptions;
}

interface WorkerSlotBase {
  worker: Worker;
  ready: boolean;
  restarting: boolean;
  initMs: number;
  restarts: number;
  initialPending: boolean;
}

interface GeometrySlot extends WorkerSlotBase {
  readonly role: "geometry";
}

interface ClassifierSlot extends WorkerSlotBase {
  readonly role: "classifier";
  readonly index: number;
  reservationId?: number;
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
  const data = source.data;
  const rgba: Uint8ClampedArray<ArrayBuffer> = data.buffer instanceof ArrayBuffer &&
      data.byteOffset === 0 && data.byteLength === data.buffer.byteLength
    ? new Uint8ClampedArray(data.buffer)
    : Uint8ClampedArray.from(data);
  return { source: { kind: "rgba", rgba: rgba.buffer }, transfer: [rgba.buffer] };
}

function closeFrame(frame: CapturedFrame): void {
  if (!(frame.source instanceof ImageData)) frame.source.close();
}

function canonicalTransferables(request: Color4ClassifyRequest): Transferable[] {
  const values = new Set<ArrayBuffer>();
  values.add(request.canonical.kind === "samples" ? request.canonical.rgb : request.canonical.rgba);
  for (const plane of Object.values(request.geometry.debug?.planes ?? {})) {
    if (plane?.pixels.buffer instanceof ArrayBuffer) values.add(plane.pixels.buffer);
  }
  return [...values];
}

/**
 * How the receiver retreats from the temporal path, and comes back.
 *
 * Three non-transition rejections buy one legacy capture. If that capture
 * decodes, the fast path is the likely culprit and legacy holds for a while --
 * but only for a while. A hold that never expired turned one bad second into a
 * session that never tried the fast path again, and the rejections that trigger
 * it (uncorrectable FEC, CRC mismatch, failed calibration) are ordinary events
 * on a moving camera, not evidence of a broken device. Repeated failures double
 * the hold up to the cap; a sustained run of fast successes clears it.
 */
export const LEGACY_HOLD_INITIAL_CAPTURES = 30;
export const LEGACY_HOLD_MAXIMUM_CAPTURES = 480;
export const LEGACY_HOLD_RESET_SUCCESSES = 30;

export const DEFAULT_COLOR4_WORKER_COUNT = 2;
export const MAXIMUM_COLOR4_WORKER_COUNT = 3;
export const COLOR4_WORKER_WATCHDOG_MS = 5_000;

export function clampColor4WorkerCount(requested: number): number {
  if (!Number.isFinite(requested)) return DEFAULT_COLOR4_WORKER_COUNT;
  return Math.max(1, Math.min(MAXIMUM_COLOR4_WORKER_COUNT, Math.floor(requested)));
}

export class Color4WorkerFailure extends Error {
  constructor(message: string, readonly fatal: boolean, readonly role: Color4WorkerRole) {
    super(message);
    this.name = "Color4WorkerFailure";
  }
}

/** One OpenCV geometry worker followed by an OpenCV-free classifier/FEC pool. */
export class Color4CameraDecoder implements VisualDecoder {
  readonly carrier = "COLOR_4" as const;
  private geometry!: GeometrySlot;
  private readonly classifiers: ClassifierSlot[] = [];
  private readonly reservations = new Map<number, ReservationState>();
  private geometryReservationId: number | undefined;
  private nextReservationId = 0;
  private nextCaptureSequence = 0;
  private trackingGeneration = 0;
  private session = 1;
  private fastRejectStreak = 0;
  private probeLegacyNext = false;
  private legacyHoldRemaining = 0;
  private legacyHoldLength = 0;
  private fastSuccessStreak = 0;
  private legacyProbes = 0;
  private legacyHolds = 0;
  private disposed = false;
  private fatal = false;
  private readyComplete = false;
  private initialReadyRemaining: number;
  private reportInitOnNextFrame = true;
  private readyResolve!: (milliseconds: number) => void;
  private readyReject!: (error: Error) => void;
  onWorkerRestart?: (role: "geometry" | "classifier") => void;
  onFatal?: (error: Error) => void;
  readonly ready = new Promise<number>((resolve, reject) => {
    this.readyResolve = resolve;
    this.readyReject = reject;
  });

  constructor(readonly paletteId: Color4PaletteId, workerCount = DEFAULT_COLOR4_WORKER_COUNT) {
    const count = clampColor4WorkerCount(workerCount);
    this.initialReadyRemaining = count + 1;
    this.geometry = this.makeGeometrySlot();
    for (let index = 0; index < count; index++) {
      this.classifiers.push(this.makeClassifierSlot(index));
    }
  }

  private createWorker(role: "geometry" | "classifier"): Worker {
    return new Worker(new URL("./color4-worker.ts", import.meta.url), { type: "module" });
  }

  private makeGeometrySlot(): GeometrySlot {
    const slot: GeometrySlot = {
      role: "geometry",
      worker: undefined as unknown as Worker,
      ready: false,
      restarting: false,
      initMs: 0,
      restarts: 0,
      initialPending: true,
    };
    this.installWorker(slot);
    return slot;
  }

  private makeClassifierSlot(index: number): ClassifierSlot {
    const slot: ClassifierSlot = {
      role: "classifier",
      index,
      worker: undefined as unknown as Worker,
      ready: false,
      restarting: false,
      initMs: 0,
      restarts: 0,
      initialPending: true,
    };
    this.installWorker(slot);
    return slot;
  }

  private installWorker(slot: GeometrySlot | ClassifierSlot): void {
    const worker = this.createWorker(slot.role);
    slot.worker = worker;
    slot.ready = false;
    slot.restarting = false;
    worker.onmessage = (event: MessageEvent<Color4WorkerResponse>) => {
      if (event.data.kind === "ready") {
        if (slot.worker !== worker) return;
        slot.ready = true;
        slot.restarting = false;
        slot.initMs = event.data.opencvInitMs;
        if (slot.initialPending) {
          slot.initialPending = false;
          this.initialReadyRemaining--;
          if (this.initialReadyRemaining === 0) {
            this.readyComplete = true;
            this.readyResolve(this.geometry.initMs);
          }
        }
        return;
      }
      if (slot.worker !== worker) return;
      if (slot.role === "geometry") this.onGeometryResponse(event.data);
      else this.onClassifierResponse(slot, event.data);
    };
    const fail = () => {
      if (slot.worker !== worker) return;
      this.onWorkerFailure(slot, `The COLOR_4 ${slot.role} worker stopped unexpectedly.`);
    };
    worker.onerror = fail;
    worker.onmessageerror = fail;
    worker.postMessage({ kind: "init", id: -1, role: slot.role });
  }

  get size(): number {
    return this.classifiers.length;
  }

  get geometryWorkers(): number {
    return 1;
  }

  get classifierWorkers(): number {
    return this.classifiers.length;
  }

  /** Legacy probes taken, and holds entered, since this decoder started. */
  get legacyFallbacks(): Readonly<{ probes: number; holds: number; holding: boolean }> {
    return Object.freeze({
      probes: this.legacyProbes,
      holds: this.legacyHolds,
      holding: this.legacyHoldRemaining > 0,
    });
  }

  get workerRestarts(): Readonly<{ geometry: number; classifier: number }> {
    return Object.freeze({
      geometry: this.geometry.restarts,
      classifier: this.classifiers.reduce((sum, slot) => sum + slot.restarts, 0),
    });
  }

  get busy(): boolean {
    return this.disposed ||
      this.fatal ||
      !this.readyComplete ||
      !this.geometry.ready ||
      this.geometryReservationId !== undefined ||
      this.classifiers.every((slot) => !slot.ready || slot.reservationId !== undefined);
  }

  get captureDropReason(): "geometry-busy" | "classifier-busy" | "reservation-unavailable" {
    if (!this.readyComplete || !this.geometry.ready || this.geometryReservationId !== undefined) {
      return "geometry-busy";
    }
    if (this.classifiers.every((slot) => !slot.ready || slot.reservationId !== undefined)) {
      return "classifier-busy";
    }
    return "reservation-unavailable";
  }

  tryReserveCapture(): Color4CaptureReservation | undefined {
    if (this.busy) return undefined;
    const classifier = this.classifiers.find(
      (slot) => slot.ready && slot.reservationId === undefined,
    );
    if (!classifier) return undefined;
    const reservationId = this.nextReservationId++;
    const mode = this.legacyHoldRemaining > 0 || this.probeLegacyNext ? "legacy" : "fast";
    if (this.probeLegacyNext) {
      this.probeLegacyNext = false;
      this.legacyProbes++;
    } else if (this.legacyHoldRemaining > 0) {
      this.legacyHoldRemaining--;
      // The hold just expired. Retire whatever the geometry worker still holds
      // so the fast path resumes from a cold acquisition rather than from state
      // captured before the trouble started.
      if (this.legacyHoldRemaining === 0) this.trackingGeneration++;
    }
    const token: Color4CaptureReservation = Object.freeze({
      reservationId,
      captureSequence: this.nextCaptureSequence++,
      trackingGeneration: this.trackingGeneration,
      classifierSlot: classifier.index,
      mode,
      session: this.session,
    });
    classifier.reservationId = reservationId;
    this.geometryReservationId = reservationId;
    this.reservations.set(reservationId, { token, classifier, phase: "reserved" });
    return token;
  }

  cancelReservation(token: Color4CaptureReservation): boolean {
    const state = this.reservationFor(token);
    if (!state || state.phase !== "reserved") return false;
    this.releaseReservation(state);
    return true;
  }

  async decodeReserved(
    token: Color4CaptureReservation,
    frame: CapturedFrame,
    options: Color4BrowserDecodeOptions = {},
  ): Promise<BrowserDecodeResult> {
    if (this.disposed) {
      closeFrame(frame);
      throw new Error("COLOR_4 decoder is disposed.");
    }
    await this.ready;
    const state = this.reservationFor(token);
    if (!state || state.phase !== "reserved") {
      closeFrame(frame);
      throw new Error("COLOR_4 capture reservation is stale or already consumed.");
    }
    const { source, transfer } = frameSource(frame.source);
    state.phase = "geometry";
    state.capturedAt = frame.timestamp;
    state.captureMs = Math.max(0, options.captureMs ?? 0);
    state.debug = options.debug ?? defaultDebug;
    const promise = new Promise<BrowserDecodeResult>((resolve, reject) => {
      state.callbacks = { startedAt: performance.now(), resolve, reject };
    });
    this.armWatchdog(state, "geometry");
    try {
      this.geometry.worker.postMessage(
        {
          kind: "geometry",
          id: token.reservationId,
          captureSequence: token.captureSequence,
          trackingGeneration: token.trackingGeneration,
          classifierSlot: token.classifierSlot,
          width: frame.source.width,
          height: frame.source.height,
          source,
          paletteId: this.paletteId,
          capturedAt: frame.timestamp,
          captureMs: state.captureMs,
          debug: state.debug,
          mode: token.mode,
        },
        transfer,
      );
    } catch (error) {
      closeFrame(frame);
      const reject = state.callbacks?.reject;
      this.releaseReservation(state);
      reject?.(error instanceof Error ? error : new Error(String(error)));
    }
    return promise;
  }

  async decode(
    frame: CapturedFrame,
    options: Color4BrowserDecodeOptions = {},
  ): Promise<BrowserDecodeResult> {
    if (this.disposed) {
      closeFrame(frame);
      throw new Error("COLOR_4 decoder is disposed.");
    }
    await this.ready;
    const reservation = this.tryReserveCapture();
    if (!reservation) {
      closeFrame(frame);
      throw new Error("The COLOR_4 temporal pipeline is busy.");
    }
    return this.decodeReserved(reservation, frame, options);
  }

  private reservationFor(token: Color4CaptureReservation): ReservationState | undefined {
    if (token.session !== this.session) return undefined;
    const state = this.reservations.get(token.reservationId);
    return state?.token === token ? state : undefined;
  }

  private armWatchdog(state: ReservationState, role: "geometry" | "classifier"): void {
    if (state.watchdog !== undefined) clearTimeout(state.watchdog);
    state.watchdog = setTimeout(() => {
      const slot = role === "geometry" ? this.geometry : state.classifier;
      this.onWorkerFailure(slot, `COLOR_4 ${role} work exceeded ${COLOR4_WORKER_WATCHDOG_MS} ms.`);
    }, COLOR4_WORKER_WATCHDOG_MS);
  }

  private onGeometryResponse(response: Color4WorkerResponse): void {
    if (response.kind !== "geometry-result") return;
    const state = this.reservations.get(response.id);
    if (!state || state.phase !== "geometry") return;
    if (
      response.captureSequence !== state.token.captureSequence ||
      response.trackingGeneration !== state.token.trackingGeneration ||
      response.classifierSlot !== state.token.classifierSlot
    ) return;
    if (state.watchdog !== undefined) clearTimeout(state.watchdog);
    state.watchdog = undefined;
    this.geometryReservationId = undefined;
    if (response.status === "rejected") {
      const diagnostics = this.withBrowserTimings(
        response.diagnostics,
        performance.now() - (state.callbacks?.startedAt ?? performance.now()),
      );
      this.updateFallbackState(state, false, diagnostics);
      this.finishReservation(state, {
        status: "rejected",
        reason: response.reason,
        diagnostics,
        captureSequence: response.captureSequence,
        capturedAt: state.capturedAt ?? 0,
        trackingGeneration: response.trackingGeneration,
        geometryPath: response.geometryPath,
        ...(response.debug ? { debug: response.debug } : {}),
      });
      return;
    }
    state.phase = "classifier";
    const request: Color4ClassifyRequest = {
      kind: "classify",
      id: response.id,
      captureSequence: response.captureSequence,
      trackingGeneration: response.trackingGeneration,
      classifierSlot: state.token.classifierSlot,
      paletteId: this.paletteId,
      capturedAt: state.capturedAt ?? 0,
      captureMs: state.captureMs ?? 0,
      debug: state.debug ?? defaultDebug,
      geometry: response.geometry,
      geometryPath: response.geometryPath,
      geometryMs: response.geometryMs,
      trackingMs: response.trackingMs,
      samplingMs: response.samplingMs,
      guardMs: response.guardMs,
      canonical: response.canonical,
    };
    this.armWatchdog(state, "classifier");
    try {
      state.classifier.worker.postMessage(request, canonicalTransferables(request));
    } catch (error) {
      const reject = state.callbacks?.reject;
      this.releaseReservation(state);
      reject?.(new Color4WorkerFailure(
        error instanceof Error ? error.message : String(error),
        false,
        "classifier",
      ));
    }
  }

  private onClassifierResponse(slot: ClassifierSlot, response: Color4WorkerResponse): void {
    if (response.kind !== "result") return;
    const state = this.reservations.get(response.id);
    if (!state || state.classifier !== slot || state.phase !== "classifier") return;
    if (response.classifierSlot !== state.token.classifierSlot) return;
    const callbacks = state.callbacks;
    if (!callbacks) return;
    const captureSequence = response.captureSequence ?? state.token.captureSequence;
    const trackingGeneration = response.trackingGeneration ?? state.token.trackingGeneration;
    const geometryPath = response.geometryPath ?? (state.token.mode === "legacy" ? "legacy" : "cold");
    const diagnostics = this.withBrowserTimings(
      response.diagnostics,
      performance.now() - callbacks.startedAt,
    );
    this.updateFallbackState(state, response.status === "valid", diagnostics);
    if (response.status === "valid") {
      this.finishReservation(state, {
        status: "valid",
        innerFrame: new Uint8Array(response.innerFrame),
        diagnostics,
        captureSequence,
        capturedAt: state.capturedAt ?? 0,
        trackingGeneration,
        geometryPath,
        ...(response.debug ? { debug: response.debug } : {}),
      });
    } else {
      this.finishReservation(state, {
        status: "rejected",
        reason: response.reason,
        diagnostics,
        captureSequence,
        capturedAt: state.capturedAt ?? 0,
        trackingGeneration,
        geometryPath,
        ...(response.debug ? { debug: response.debug } : {}),
      });
    }
  }

  private updateFallbackState(
    state: ReservationState,
    valid: boolean,
    diagnostics: FrameDiagnostics & BrowserCarrierDiagnostics,
  ): void {
    if (state.token.mode === "legacy") {
      if (valid) {
        // Legacy decoded what the fast path could not, so hold it -- longer
        // each time this repeats, never forever.
        this.legacyHoldLength = Math.min(
          LEGACY_HOLD_MAXIMUM_CAPTURES,
          Math.max(LEGACY_HOLD_INITIAL_CAPTURES, this.legacyHoldLength * 2),
        );
        this.legacyHoldRemaining = this.legacyHoldLength;
        this.legacyHolds++;
        this.fastRejectStreak = 0;
        this.fastSuccessStreak = 0;
      } else if (this.legacyHoldRemaining === 0) {
        // Legacy failed too, so the fast path was not the problem. Retire the
        // geometry worker's state and let it acquire again.
        this.fastRejectStreak = 0;
        this.trackingGeneration++;
      }
      return;
    }
    if (valid) {
      this.fastRejectStreak = 0;
      this.fastSuccessStreak++;
      // A sustained run on the fast path retires the backoff, so an isolated
      // bad stretch cannot keep escalating the next one for the whole session.
      if (this.fastSuccessStreak >= LEGACY_HOLD_RESET_SUCCESSES) this.legacyHoldLength = 0;
      return;
    }
    const transition = diagnostics.stage === "bootstrap" &&
      (diagnostics.rejectReason === "sequence-phase-mismatch" ||
        diagnostics.vision?.rejectReason === "phase_mismatch");
    if (transition) return;
    this.fastSuccessStreak = 0;
    this.fastRejectStreak++;
    if (this.fastRejectStreak >= 3) {
      this.fastRejectStreak = 0;
      this.probeLegacyNext = true;
    }
  }

  private finishReservation(state: ReservationState, result: BrowserDecodeResult): void {
    const resolve = state.callbacks?.resolve;
    this.releaseReservation(state);
    resolve?.(result);
  }

  private releaseReservation(state: ReservationState): void {
    if (state.watchdog !== undefined) clearTimeout(state.watchdog);
    if (this.geometryReservationId === state.token.reservationId) {
      this.geometryReservationId = undefined;
    }
    if (state.classifier.reservationId === state.token.reservationId) {
      state.classifier.reservationId = undefined;
    }
    this.reservations.delete(state.token.reservationId);
  }

  private withBrowserTimings(
    diagnostics: Color4WorkerDiagnostics,
    roundTripTotal: number,
  ): FrameDiagnostics & BrowserCarrierDiagnostics {
    const timings: NonNullable<BrowserCarrierDiagnostics["vision"]>["timings"] = {
      ...diagnostics.vision?.timings,
      roundTripTotal: Math.max(0, roundTripTotal),
      ...(this.reportInitOnNextFrame ? { opencvInit: this.geometry.initMs } : {}),
    };
    if (this.reportInitOnNextFrame) this.reportInitOnNextFrame = false;
    return {
      ...diagnostics,
      vision: diagnostics.vision ? { ...diagnostics.vision, timings } : undefined,
    };
  }

  private onWorkerFailure(slot: GeometrySlot | ClassifierSlot, message: string): void {
    if (this.disposed || slot.restarting) return;
    slot.restarting = true;
    slot.ready = false;
    slot.worker.terminate();
    slot.restarts++;
    this.onWorkerRestart?.(slot.role);
    const reservationId = slot.role === "geometry" ? this.geometryReservationId : slot.reservationId;
    const state = reservationId === undefined ? undefined : this.reservations.get(reservationId);
    if (slot.restarts > 1) {
      this.failAll(new Color4WorkerFailure(message, true, slot.role));
      return;
    }
    if (state?.callbacks) {
      const reject = state.callbacks.reject;
      this.releaseReservation(state);
      reject(new Color4WorkerFailure(`${message} The worker was restarted once.`, false, slot.role));
    }
    this.installWorker(slot);
  }

  private failAll(error: Error): void {
    if (this.fatal) return;
    this.fatal = true;
    this.readyReject(error);
    for (const state of [...this.reservations.values()]) {
      const reject = state.callbacks?.reject;
      this.releaseReservation(state);
      reject?.(error);
    }
    this.onFatal?.(error);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.session++;
    this.geometry.worker.terminate();
    for (const slot of this.classifiers) slot.worker.terminate();
    this.onFatal = undefined;
    this.failAll(new Error("COLOR_4 decoder was disposed."));
  }
}

export function createColor4Decoder(
  paletteId: Color4PaletteId,
  workerCount = DEFAULT_COLOR4_WORKER_COUNT,
): Color4CameraDecoder {
  return new Color4CameraDecoder(paletteId, workerCount);
}
