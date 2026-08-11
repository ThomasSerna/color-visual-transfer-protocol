import type { ExperimentSummary, VisionExperimentConditions } from "../shared/experiments";
import { createStoredZip } from "../shared/zip-store";
import { sha256Hex } from "../shared/sha256";
import {
  QUIET_MODULES,
  createPhysicalLayout,
} from "../shared/color4/physical";
import { getColor4Profile } from "../shared/color4/profiles";
import type {
  VisionCandidateTrace,
  VisionCanonicalScale,
  VisionDebugView,
  VisionDetectionLimit,
  VisionPlane,
  VisionQuad,
} from "./color4-vision-types";
import type {
  Color4WorkerDebugFrame,
  Color4WorkerDebugOptions,
} from "./color4-worker-protocol";

export interface Color4DebugFrame extends Color4WorkerDebugFrame {
  readonly diagnostics: unknown;
}

export type Color4DebugDecodeOptions = Color4WorkerDebugOptions;

export interface CoverProjection {
  readonly scale: number;
  readonly offsetX: number;
  readonly offsetY: number;
}

export function objectFitCoverProjection(
  sourceWidth: number,
  sourceHeight: number,
  viewWidth: number,
  viewHeight: number,
): CoverProjection {
  if (sourceWidth <= 0 || sourceHeight <= 0 || viewWidth <= 0 || viewHeight <= 0) {
    return { scale: 1, offsetX: 0, offsetY: 0 };
  }
  const scale = Math.max(viewWidth / sourceWidth, viewHeight / sourceHeight);
  return {
    scale,
    offsetX: (viewWidth - sourceWidth * scale) / 2,
    offsetY: (viewHeight - sourceHeight * scale) / 2,
  };
}

interface DebugControllerOptions {
  readonly currentExperiment: () => ExperimentSummary | undefined;
  readonly snapshotContext: () => Readonly<{
    requested: Readonly<{
      width: number | "max";
      height?: number;
      fps: number;
    }>;
    actual?: Readonly<{
      width?: number;
      height?: number;
      fps?: number;
    }>;
  }>;
}

const viewLabels: Readonly<Record<VisionDebugView, string>> = {
  raw: "Raw camera",
  grayscale: "Grayscale",
  threshold: "Threshold",
  contours: "Contours / quads",
  fiducials: "Detected fiducials",
  warped: "Warped frame",
  calibration: "Calibration swatches",
};

function required<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Debug Vision element #${id} is missing.`);
  return element as T;
}

function numberChoice<T extends number>(element: HTMLSelectElement): T {
  return Number(element.value) as T;
}

export class VisionDebugController {
  private readonly enabledInput = required<HTMLInputElement>("cfg-vision-debug");
  private readonly viewInput = required<HTMLSelectElement>("cfg-debug-view");
  private readonly scaleInput = required<HTMLSelectElement>("cfg-debug-scale");
  private readonly detectionInput = required<HTMLSelectElement>("cfg-debug-detection");
  private readonly labelInput = required<HTMLInputElement>("cfg-debug-label");
  private readonly txInput = required<HTMLSelectElement>("cfg-debug-tx");
  private readonly profileInput = required<HTMLSelectElement>("cfg-debug-profile");
  private readonly prefilterInput = required<HTMLSelectElement>("cfg-debug-prefilter");
  private readonly distanceInput = required<HTMLSelectElement>("cfg-debug-distance");
  private readonly angleInput = required<HTMLSelectElement>("cfg-debug-angle");
  private readonly brightnessInput = required<HTMLSelectElement>("cfg-debug-brightness");
  private readonly snapshotButton = required<HTMLButtonElement>("capture-debug-snapshot");
  private readonly snapshotStatus = required<HTMLElement>("debug-snapshot-status");
  private readonly overlayWrap = required<HTMLElement>("vision-overlay").parentElement!;
  private readonly overlay = required<HTMLCanvasElement>("vision-overlay");
  private readonly output = required<HTMLElement>("vision-debug-output");
  private readonly outputCanvas = required<HTMLCanvasElement>("vision-debug-canvas");
  private readonly outputTitle = required<HTMLElement>("vision-debug-title");
  private readonly outputSummary = required<HTMLElement>("vision-debug-summary");
  private readonly resizeObserver = new ResizeObserver(() => this.renderOverlay());
  private latest: Color4DebugFrame | undefined;
  private transferActive = false;
  private snapshotArmed = false;
  private snapshotBusy = false;
  private snapshotEpoch = 0;
  private lastPlaneRequest = Number.NEGATIVE_INFINITY;
  private generationValue = 0;

  constructor(private readonly options: DebugControllerOptions) {
    this.resizeObserver.observe(this.overlayWrap.parentElement!);
    this.enabledInput.addEventListener("change", () => {
      this.generationValue++;
      if (!this.enabled) {
        this.latest = undefined;
      }
      this.applyVisibility();
    });
    this.viewInput.addEventListener("change", () => {
      this.generationValue++;
      if (this.snapshotArmed || this.snapshotBusy) {
        this.cancelSnapshot("Snapshot cancelled because the debug view changed.");
      }
      this.outputTitle.textContent = viewLabels[this.view];
      this.clearCanvases();
    });
    this.snapshotButton.addEventListener("click", () => {
      if (!this.transferActive || this.snapshotBusy) return;
      this.snapshotEpoch++;
      this.snapshotArmed = true;
      this.snapshotButton.disabled = true;
      this.snapshotStatus.textContent = "Snapshot armed for the next free camera frame…";
    });
    this.outputTitle.textContent = viewLabels[this.view];
    this.applyVisibility();
  }

  get enabled(): boolean {
    return this.enabledInput.checked;
  }

  get view(): VisionDebugView {
    return this.viewInput.value as VisionDebugView;
  }

  get generation(): number {
    return this.generationValue;
  }

  get canonicalScale(): VisionCanonicalScale {
    return numberChoice<VisionCanonicalScale>(this.scaleInput);
  }

  get maxDetectionDimension(): VisionDetectionLimit {
    return this.detectionInput.value === "source"
      ? "source"
      : numberChoice<960 | 1280>(this.detectionInput);
  }

  get prefilterMode(): "observe" | "enabled" {
    return this.prefilterInput.value === "enabled" ? "enabled" : "observe";
  }

  get snapshotPending(): boolean {
    return this.snapshotArmed || this.snapshotBusy;
  }

  conditions(): VisionExperimentConditions {
    const label = this.labelInput.value.trim();
    const expectedProfile = this.profileInput.value === "ROBUST" ||
        this.profileInput.value === "EXPERIMENTAL"
      ? this.profileInput.value
      : undefined;
    return {
      label: label.length > 0 ? label : undefined,
      expectedTxFps: numberChoice<1 | 2 | 5 | 10>(this.txInput),
      expectedProfile,
      prefilterMode: this.prefilterMode,
      distanceM: numberChoice<0.3 | 0.5 | 1>(this.distanceInput),
      angleDeg: numberChoice<0 | 15>(this.angleInput),
      brightness: this.brightnessInput.value as "high" | "maximum",
    };
  }

  decodeOptions(now: number): Color4DebugDecodeOptions {
    const snapshot = this.snapshotArmed;
    if (snapshot) {
      this.snapshotArmed = false;
      this.snapshotBusy = true;
      this.snapshotStatus.textContent = "Capturing and encoding the diagnostic bundle…";
    }
    const emitPlane = this.enabled && (snapshot || now - this.lastPlaneRequest >= 500);
    if (emitPlane) this.lastPlaneRequest = now;
    return {
      enabled: this.enabled,
      view: this.view,
      generation: this.generationValue,
      canonicalScale: this.canonicalScale,
      maxDetectionDimension: this.maxDetectionDimension,
      emitPlane,
      snapshot,
    };
  }

  setTransferActive(active: boolean): void {
    if (this.transferActive && !active) this.generationValue++;
    this.transferActive = active;
    for (const control of [
      this.scaleInput,
      this.detectionInput,
      this.labelInput,
      this.txInput,
      this.profileInput,
      this.prefilterInput,
      this.distanceInput,
      this.angleInput,
      this.brightnessInput,
    ]) control.disabled = active;
    if (!active) {
      this.latest = undefined;
      this.cancelSnapshot("Camera stopped. No debug images were retained.");
    }
    this.applyVisibility();
  }

  handleFrame(frame: Color4DebugFrame): void {
    if (!this.transferActive) return;
    if (frame.snapshot) void this.downloadSnapshot(frame, this.snapshotEpoch);
    if (frame.generation !== this.generationValue) return;
    if (!this.enabled) return;
    this.latest = frame;
    this.renderOverlay();
    // Geometry overlays may follow every processed frame, but copying a full
    // stage plane to the visible canvas is deliberately capped by the
    // worker-request cadence (two updates per second).
    if (frame.planeRequested) this.renderSelectedView(frame);
    this.latest = this.overlayOnly(frame);
  }

  failSnapshot(message: string): void {
    if (!this.snapshotBusy && !this.snapshotArmed) return;
    this.snapshotEpoch++;
    this.snapshotBusy = false;
    this.snapshotArmed = false;
    this.snapshotStatus.textContent = message;
    this.applyVisibility();
  }

  dispose(): void {
    this.resizeObserver.disconnect();
    this.latest = undefined;
    this.cancelSnapshot("Debug Vision disposed.");
    this.clearCanvases();
  }

  private applyVisibility(): void {
    const visible = this.enabled && this.transferActive;
    this.overlayWrap.hidden = !visible;
    this.output.hidden = !visible;
    this.snapshotButton.disabled = !this.transferActive || this.snapshotBusy || this.snapshotArmed;
    if (!visible) this.clearCanvases();
  }

  private cancelSnapshot(message: string): void {
    this.snapshotEpoch++;
    this.snapshotArmed = false;
    this.snapshotBusy = false;
    this.snapshotStatus.textContent = message;
    this.snapshotButton.disabled = !this.transferActive;
  }

  private clearCanvases(): void {
    for (const canvas of [this.overlay, this.outputCanvas]) {
      const context = canvas.getContext("2d");
      context?.clearRect(0, 0, canvas.width, canvas.height);
    }
  }

  private overlayOnly(frame: Color4DebugFrame): Color4DebugFrame {
    return {
      ...frame,
      artifacts: { ...frame.artifacts, planes: {} },
      classifier: [],
      unwrap: [],
      diagnostics: undefined,
    };
  }

  private renderOverlay(): void {
    if (!this.enabled || !this.transferActive || !this.latest) return;
    const parent = this.overlayWrap.parentElement!;
    const width = Math.max(1, Math.round(parent.clientWidth));
    const height = Math.max(1, Math.round(parent.clientHeight));
    if (this.overlay.width !== width || this.overlay.height !== height) {
      this.overlay.width = width;
      this.overlay.height = height;
    }
    const context = this.overlay.getContext("2d")!;
    context.clearRect(0, 0, width, height);
    const metadata = this.latest.artifacts.metadata;
    const projection = objectFitCoverProjection(
      metadata.sourceWidth,
      metadata.sourceHeight,
      width,
      height,
    );
    for (const trace of this.latest.artifacts.traces) {
      const color = trace.status === "DECODED"
        ? "#27d9d4"
        : trace.status === "DUPLICATE_ID"
          ? "#f2cc52"
          : "#ff716c";
      this.drawQuad(context, trace.quad, projection, color, trace);
    }
    this.drawCornerStates(context, width, height, this.latest.artifacts.traces);
  }

  private drawQuad(
    context: CanvasRenderingContext2D,
    quad: VisionQuad,
    projection: CoverProjection,
    color: string,
    trace: VisionCandidateTrace,
  ): void {
    const point = (value: { x: number; y: number }) => ({
      x: value.x * projection.scale + projection.offsetX,
      y: value.y * projection.scale + projection.offsetY,
    });
    context.save();
    context.strokeStyle = color;
    context.fillStyle = color;
    context.lineWidth = 2;
    context.beginPath();
    quad.forEach((value, index) => {
      const mapped = point(value);
      if (index === 0) context.moveTo(mapped.x, mapped.y);
      else context.lineTo(mapped.x, mapped.y);
    });
    context.closePath();
    context.stroke();
    const center = point(trace.center);
    context.beginPath();
    context.arc(center.x, center.y, 4, 0, Math.PI * 2);
    context.fill();
    const label = trace.best
      ? `${trace.best.id} e=${trace.best.errors} ${trace.thresholdPass}`
      : trace.status.replaceAll("_", " ");
    context.font = "600 12px ui-monospace, monospace";
    context.fillStyle = "#0b0d10";
    const metrics = context.measureText(label);
    context.fillRect(center.x + 6, center.y - 15, metrics.width + 8, 18);
    context.fillStyle = color;
    context.fillText(label, center.x + 10, center.y - 2);
    context.restore();
  }

  private drawCornerStates(
    context: CanvasRenderingContext2D,
    width: number,
    height: number,
    traces: readonly VisionCandidateTrace[],
  ): void {
    const ids = ["TL", "TR", "BR", "BL"] as const;
    const positions = {
      TL: { x: 10, y: 10, align: "left" as const },
      TR: { x: width - 10, y: 10, align: "right" as const },
      BR: { x: width - 10, y: height - 32, align: "right" as const },
      BL: { x: 10, y: height - 32, align: "left" as const },
    };
    context.save();
    context.font = "700 13px ui-monospace, monospace";
    context.textBaseline = "top";
    for (const id of ids) {
      const found = traces
        .filter((trace) => trace.best?.id === id && trace.status === "DECODED")
        .sort((left, right) => left.best!.errors - right.best!.errors)[0];
      const text = found ? `${id} ✓ e=${found.best!.errors}` : `${id} ✕`;
      const position = positions[id];
      const measured = context.measureText(text).width;
      const left = position.align === "left" ? position.x : position.x - measured - 12;
      context.fillStyle = "rgba(11,13,16,.82)";
      context.fillRect(left - 6, position.y - 4, measured + 12, 24);
      context.textAlign = position.align;
      context.fillStyle = found ? "#58d68d" : "#ff716c";
      context.fillText(text, position.x, position.y);
    }
    context.restore();
  }

  private renderSelectedView(frame: Color4DebugFrame): void {
    const plane = this.planeForView(frame);
    this.outputSummary.textContent =
      `${frame.artifacts.metadata.sourceWidth}×${frame.artifacts.metadata.sourceHeight} · ` +
      `${frame.artifacts.traces.length} traced quads · scale ${frame.artifacts.metadata.canonicalScale} · ` +
      `${frame.artifacts.metadata.homographyMethod}`;
    if (!plane) {
      const context = this.outputCanvas.getContext("2d")!;
      this.outputCanvas.width = 640;
      this.outputCanvas.height = 180;
      context.fillStyle = "#080a0d";
      context.fillRect(0, 0, 640, 180);
      context.fillStyle = "#f4f1ea";
      context.font = "16px system-ui, sans-serif";
      context.fillText("This stage was unavailable for the latest processed frame.", 24, 92);
      return;
    }
    this.drawPlane(this.outputCanvas, plane);
    if (frame.view === "contours" || frame.view === "fiducials") {
      this.drawStageTraces(frame, plane);
    } else if (frame.view === "calibration") this.drawCalibration(frame);
  }

  private planeForView(frame: Color4DebugFrame): VisionPlane | undefined {
    const planes = frame.artifacts.planes;
    if (frame.view === "grayscale") return planes.grayscale;
    if (frame.view === "threshold") return planes.threshold;
    if (frame.view === "warped" || frame.view === "calibration") return planes.warped;
    return planes.raw ?? planes.threshold;
  }

  private drawPlane(canvas: HTMLCanvasElement, plane: VisionPlane): void {
    canvas.width = plane.width;
    canvas.height = plane.height;
    const context = canvas.getContext("2d")!;
    context.imageSmoothingEnabled = false;
    context.putImageData(this.imageData(plane), 0, 0);
  }

  private imageData(plane: VisionPlane): ImageData {
    if (plane.channels === 4) {
      const pixels: Uint8ClampedArray<ArrayBuffer> = plane.pixels.buffer instanceof ArrayBuffer
        ? new Uint8ClampedArray(plane.pixels.buffer, plane.pixels.byteOffset, plane.pixels.byteLength)
        : Uint8ClampedArray.from(plane.pixels);
      return new ImageData(pixels, plane.width, plane.height);
    }
    const rgba = new Uint8ClampedArray(plane.width * plane.height * 4);
    for (let index = 0; index < plane.pixels.length; index++) {
      const value = plane.pixels[index]!;
      const offset = index * 4;
      rgba[offset] = value;
      rgba[offset + 1] = value;
      rgba[offset + 2] = value;
      rgba[offset + 3] = 255;
    }
    return new ImageData(rgba, plane.width, plane.height);
  }

  private drawStageTraces(frame: Color4DebugFrame, plane: VisionPlane): void {
    const context = this.outputCanvas.getContext("2d")!;
    const thresholdCoordinates = plane === frame.artifacts.planes.threshold;
    const scale = thresholdCoordinates ? 1 : plane.width / frame.artifacts.metadata.sourceWidth;
    const projection = { scale, offsetX: 0, offsetY: 0 };
    for (const trace of frame.artifacts.traces) {
      const stageTrace = thresholdCoordinates
        ? {
            ...trace,
            center: {
              x: trace.center.x * frame.artifacts.metadata.detectionScale,
              y: trace.center.y * frame.artifacts.metadata.detectionScale,
            },
          }
        : trace;
      this.drawQuad(
        context,
        thresholdCoordinates ? trace.detectionQuad : trace.quad,
        projection,
        trace.status === "DECODED" ? "#27d9d4" : "#ff716c",
        stageTrace,
      );
    }
  }

  private drawCalibration(frame: Color4DebugFrame): void {
    if (!frame.profileId) return;
    const profile = getColor4Profile(frame.profileId);
    if (!profile) return;
    const layout = createPhysicalLayout(profile);
    const scale = frame.artifacts.metadata.canonicalScale;
    const context = this.outputCanvas.getContext("2d")!;
    context.save();
    context.strokeStyle = "#f2cc52";
    context.fillStyle = "#f2cc52";
    context.lineWidth = Math.max(1, scale / 2);
    context.font = "600 11px ui-monospace, monospace";
    for (const bank of [layout.calibration.left, layout.calibration.right]) {
      for (const swatch of bank) {
        const x = (QUIET_MODULES + swatch.x) * scale;
        const y = (QUIET_MODULES + swatch.y) * scale;
        context.strokeRect(x, y, swatch.width * scale, swatch.height * scale);
        context.fillText(swatch.name, x, Math.max(10, y - 2));
      }
    }
    context.restore();
  }

  private async downloadSnapshot(frame: Color4DebugFrame, snapshotEpoch: number): Promise<void> {
    try {
      const generatedAt = new Date();
      const id = String(frame.frameId).padStart(6, "0");
      const base = `capture-${id}`;
      const entries: Array<{ name: string; data: Blob | Uint8Array; modifiedAt: Date }> = [];
      const raw = frame.artifacts.planes.raw;
      const threshold = frame.artifacts.planes.threshold;
      const warped = frame.artifacts.planes.warped;
      const rgbaSha256 = raw ? await sha256Hex(raw.pixels) : undefined;
      const camera = this.options.snapshotContext();
      const observedProfile = frame.profileId === undefined
        ? undefined
        : getColor4Profile(frame.profileId)?.name;
      if (raw) entries.push({ name: `${base}-raw.png`, data: await this.planePng(raw), modifiedAt: generatedAt });
      if (threshold) entries.push({ name: `${base}-threshold.png`, data: await this.planePng(threshold), modifiedAt: generatedAt });
      if (warped) entries.push({ name: `${base}-warped.png`, data: await this.planePng(warped), modifiedAt: generatedAt });
      const { planes: _, ...artifactTrace } = frame.artifacts;
      const record = {
        schema: "cvtp-color4-vision-snapshot",
        version: 1,
        captureId: frame.frameId,
        capturedAtMonotonicMs: frame.capturedAt,
        bundleGeneratedAt: generatedAt.toISOString(),
        browser: navigator.userAgent,
        build: document.querySelector(".footer-build")?.textContent?.trim(),
        configuration: {
          carrier: "COLOR_4",
          view: frame.view,
          canonicalScale: frame.artifacts.metadata.canonicalScale,
          maxDetectionDimension: frame.maxDetectionDimension,
          paletteId: frame.paletteId,
          palette: frame.paletteId === 0 ? "KCMY" : "KRGB",
          prefilterMode: this.prefilterMode,
          expectedProfile: this.conditions().expectedProfile,
          observedProfile,
          declaredTxFps: this.conditions().expectedTxFps,
          requestedCamera: camera.requested,
          actualCamera: camera.actual,
        },
        conditions: this.conditions(),
        artifacts: {
          raw: {
            available: raw !== undefined,
            width: raw?.width,
            height: raw?.height,
            rgbaRowStride: raw === undefined ? undefined : raw.width * 4,
            rgbaSha256,
          },
          threshold: { available: threshold !== undefined, width: threshold?.width, height: threshold?.height },
          warped: { available: warped !== undefined, width: warped?.width, height: warped?.height },
        },
        vision: artifactTrace,
        diagnostics: frame.diagnostics,
        experiment: this.options.currentExperiment(),
      };
      entries.push({
        name: `${base}.json`,
        data: new TextEncoder().encode(`${JSON.stringify(record, null, 2)}\n`),
        modifiedAt: generatedAt,
      });
      const archive = await createStoredZip(entries);
      if (snapshotEpoch !== this.snapshotEpoch) return;
      const url = URL.createObjectURL(archive);
      const link = document.createElement("a");
      link.hidden = true;
      link.href = url;
      link.download = `cvtp-vision-${generatedAt.toISOString().replace(/[:.]/g, "-")}-${base}.zip`;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 0);
      if (snapshotEpoch === this.snapshotEpoch) {
        this.snapshotStatus.textContent = warped
          ? "Snapshot ZIP downloaded. No camera images were retained."
          : "Snapshot ZIP downloaded without a warped image; the JSON records why it was unavailable.";
      }
    } catch (error) {
      if (snapshotEpoch === this.snapshotEpoch) {
        this.snapshotStatus.textContent = `Snapshot failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    } finally {
      if (this.latest?.frameId === frame.frameId) {
        // Canvas drawing and the ZIP writer have copied what they need. Keep
        // only lightweight overlay metadata; never retain snapshot pixels or
        // per-shard/cell traces as the controller's latest frame.
        this.latest = this.overlayOnly(frame);
      }
      if (snapshotEpoch === this.snapshotEpoch) {
        this.snapshotBusy = false;
        this.applyVisibility();
      }
    }
  }

  private async planePng(plane: VisionPlane): Promise<Blob> {
    const canvas = document.createElement("canvas");
    this.drawPlane(canvas, plane);
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        canvas.width = 0;
        canvas.height = 0;
        if (blob) resolve(blob);
        else reject(new Error("The browser could not encode a diagnostic PNG."));
      }, "image/png");
    });
  }
}

export function createVisionDebugController(options: DebugControllerOptions): VisionDebugController {
  return new VisionDebugController(options);
}
