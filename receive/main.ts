// Receiver: camera → WASM QR decode in workers → fountain decoder → file.
//
// Field lessons baked in:
// - iOS may treat an ideal frame rate as a suggestion. Demand the selected
//   rate as `exact` first, then fall back to `ideal`.
// - requestVideoFrameCallback chains survive a stopped stream and resume on
//   the next one — a generation counter prevents zombie capture loops.
// - Progress must track frames COLLECTED: LT peeling back-loads its solve
//   cascade, so blocks-solved looks stalled and then teleports to done.
// - Android Chrome exposes torch / camera modes / frameRate.max through
//   getCapabilities; iOS Safari may expose none of them. shared/platform.ts
//   owns the probing, so everything here is capability-gated rather than
//   UA-gated.

import { LTDecoder } from "../shared/fountain";
import {
  estimateTransferProgress,
  expectedFountainOverhead,
  formatDuration,
} from "../shared/progress";
import { NoSignalHintTimer } from "../shared/no-signal";
import { isSnippet, snippetText } from "../shared/snippet";
import {
  fnv1a,
  parseFrame,
  streamIdentity,
  unpackFile,
  verifyFile,
  type OpticalFile,
} from "../shared/protocol";
import { NO_SIGNAL_HINT_FRAME_BYTES, NO_SIGNAL_HINT_TX_FPS } from "../shared/send-settings";
import { statusLine } from "../shared/status-line";
import { releaseScreenWakeLock, requestScreenWakeLock } from "../shared/wake-lock";
import { applyContinuousCameraModes, probeCameraCapabilities } from "../shared/platform";
import {
  applyMaximumSupportedWidth,
  cameraConstraintLadder,
  type CaptureWidthChoice,
} from "../shared/camera-negotiation";
import {
  DEFAULT_COLOR4_CANONICAL_SCALE,
  DEFAULT_COLOR4_DETECTION_DIMENSION,
  defaultCaptureFps,
  defaultCaptureWidth,
} from "../shared/receiver-defaults";
import { closeOnBackdropClick } from "../shared/dialog";
import { loadColor4Receiver } from "../shared/color-loader";
import {
  carrierId,
  type BrowserCarrierDiagnostics,
  type CarrierChoice,
} from "../shared/carrier";
import {
  ExperimentMetrics,
  clearExperiments,
  downloadExperimentExport,
  listExperiments,
  loadPreference,
  makeExperimentExport,
  saveExperiment,
  savePreference,
  type ExperimentSummary,
} from "../shared/experiments";
import type { Color4CameraDecoder } from "./color4-carrier";
import type { VisionDebugController } from "./color4-debug-ui";
import type { QrLegacyCameraDecoder } from "./qr-carrier";
import {
  COLOR4_CAPTURE_FINGERPRINT_HEIGHT,
  COLOR4_CAPTURE_FINGERPRINT_WIDTH,
  CaptureStabilityTracker,
  createCaptureLumaFingerprint,
  type CaptureStabilityResult,
} from "./color4-capture-stability";
import { classifyColor4CaptureQuality } from "./color4-capture-quality";
import { Color4FramingAdviceTracker } from "./color4-framing-advice";

const startBtn = document.getElementById("start") as HTMLButtonElement;
const video = document.getElementById("video") as HTMLVideoElement;
const preview = document.getElementById("preview")!;
const stats = document.getElementById("stats")!;
const progressEl = document.getElementById("progress")!;
const bar = document.getElementById("bar")!;
const progressStatus = document.getElementById("progress-status")!;
const progressLabel = document.getElementById("progress-label")!;
const etaLabel = document.getElementById("eta-label")!;
const result = document.getElementById("result")!;
const metricsEl = document.getElementById("metrics")!;
const diagnosticsEl = document.getElementById("diagnostics") as HTMLDetailsElement | null;
const settingsEl = document.getElementById("settings")!;
const cfgWidth = document.getElementById("cfg-width") as HTMLSelectElement;
const cfgCapFps = document.getElementById("cfg-capfps") as HTMLSelectElement;
const cfgWorkers = document.getElementById("cfg-workers") as HTMLSelectElement;
const cfgColorPalette = __COLOR4_ENABLED__
  ? document.getElementById("cfg-color-palette") as HTMLSelectElement | null
  : null;
const cfgVisionDebug = __COLOR4_ENABLED__
  ? document.getElementById("cfg-vision-debug") as HTMLInputElement | null
  : null;
const carrierPicker = document.getElementById("carrier-picker")!;
const carrierColorOption = __COLOR4_ENABLED__
  ? document.getElementById("carrier-color-option")
  : null;
const carrierInputs = __COLOR4_ENABLED__
  ? Array.from(document.querySelectorAll<HTMLInputElement>('input[name="carrier"]'))
  : [];
const qrSettings = Array.from(document.querySelectorAll<HTMLElement>("[data-qr-setting]"));
const colorSettings = __COLOR4_ENABLED__
  ? Array.from(document.querySelectorAll<HTMLElement>("[data-color-setting]"))
  : [];
const exportMetricsBtn = document.getElementById("export-metrics") as HTMLButtonElement;
const clearMetricsBtn = document.getElementById("clear-metrics") as HTMLButtonElement;
const cameraActual = document.getElementById("camera-actual")!;
const noSignalToast = document.getElementById("no-signal")!;
const noSignalHeadline = document.getElementById("no-signal-headline")!;
const noSignalDialog = document.getElementById("no-signal-dialog") as HTMLDialogElement;
const noSignalTips = document.getElementById("no-signal-tips")!;
const NO_SIGNAL_DEFAULT_HEADLINE = noSignalHeadline.textContent ?? "Nothing happening?";
const metric = (id: string) => document.getElementById(id)!;

// Nothing has decoded in this long → the sender is almost certainly too dense
// for this camera. The first nudge comes quickly (a dead link is dead within
// seconds); a dismissed one comes back on a longer leash, because dismissing
// it doesn't make the transfer start working but the advice has been seen.
const NO_SIGNAL_FIRST_MS = 8_000;
const NO_SIGNAL_DISMISSED_MS = 15_000;

// Sliding window for the capture/decode fps metrics — the per-second rates in
// updateStats() are derived from this, so the window and the divisor can't
// drift apart.
const STATS_WINDOW_MS = 2000;

let stream: MediaStream | null = null;
let decoder: LTDecoder | null = null;
let streamKey = "";
let startTs = 0;
let captureGen = 0;
let done = false;
let settingsWired = false;
const manualCaptureWidths = new Map<CarrierChoice, string>();
const manualCaptureFps = new Map<CarrierChoice, string>();
let statsTimer: ReturnType<typeof setInterval> | undefined;
let activeCarrier: CarrierChoice | null = null;
let colorDecoder: Color4CameraDecoder | null = null;
let qrDecoder: QrLegacyCameraDecoder | null = null;
let visionDebugController: VisionDebugController | null = null;
let visionDebugPromise: Promise<VisionDebugController> | null = null;
let experiment: ExperimentMetrics | null = null;
let latestExperiment: ExperimentSummary | undefined;
let experimentSave: Promise<void> = Promise.resolve();
type RequestedCameraSettings = Readonly<{
  width: CaptureWidthChoice;
  height?: number;
  fps: number;
}>;
let negotiatedCamera:
  | { cameraWidth?: number; cameraHeight?: number; cameraFps?: number }
  | undefined;
let requestedCamera: RequestedCameraSettings = { width: 1280, height: 960, fps: 60 };
let receiveSettingsQueue: Promise<void> = Promise.resolve();
let captureStability: CaptureStabilityTracker | null = null;
let stableIntervalEpoch = 0;
let lastSubmittedStableIntervalEpoch: number | undefined;

const COLOR4_STABILITY_THRESHOLD = 0.025;

const noSignal = new NoSignalHintTimer(NO_SIGNAL_FIRST_MS, NO_SIGNAL_DISMISSED_MS);
/** Why recent COLOR_4 captures were unreadable, once enough of them agree. */
const framingAdvice = new Color4FramingAdviceTracker();
const captureTimes: number[] = [];
const decodeTimes: number[] = [];
let latestCarrierDiagnostics: BrowserCarrierDiagnostics | undefined;
startBtn.disabled = true;
startBtn.onclick = () => void start();

// The header nav markup is shared verbatim between both tool pages; each page
// marks its own link. Optional because the standalone build swaps the nav for
// a badge. Same story on the sender.
document.querySelector('.mode-nav a[href="../receive/"]')?.setAttribute("aria-current", "page");

const { setStatus, showError } = statusLine(stats);

function currentCarrier(): CarrierChoice {
  if (!__COLOR4_ENABLED__) return "qr";
  return carrierInputs.find((input) => input.checked)?.value === "color4" ? "color4" : "qr";
}

function applyCarrierControls(): void {
  if (!__COLOR4_ENABLED__) {
    qrSettings.forEach((element) => { element.hidden = false; });
    return;
  }
  const carrier = currentCarrier();
  const maxOption = Array.from(cfgWidth.options).find((option) => option.value === "max");
  if (maxOption) maxOption.hidden = carrier !== "color4";
  for (const option of Array.from(cfgCapFps.options)) {
    const fps = Number(option.value);
    option.hidden = carrier === "color4" ? fps === 60 : fps === 15;
  }
  cfgWidth.value = manualCaptureWidths.get(carrier) ?? String(defaultCaptureWidth(carrier));
  cfgCapFps.value = manualCaptureFps.get(carrier) ?? String(defaultCaptureFps(carrier));
  qrSettings.forEach((element) => { element.hidden = carrier !== "qr"; });
  colorSettings.forEach((element) => { element.hidden = carrier !== "color4"; });
}

if (__COLOR4_ENABLED__) {
  if (!Array.from(cfgWidth.options).some((option) => option.value === "max")) {
    const option = document.createElement("option");
    option.value = "max";
    option.textContent = "max supported";
    cfgWidth.append(option);
  }
  if (!Array.from(cfgCapFps.options).some((option) => option.value === "15")) {
    const option = document.createElement("option");
    option.value = "15";
    option.textContent = "15";
    cfgCapFps.insertBefore(option, cfgCapFps.firstChild);
  }
}

cfgWidth.addEventListener("change", () => {
  manualCaptureWidths.set(currentCarrier(), cfgWidth.value);
});

cfgCapFps.addEventListener("change", () => {
  manualCaptureFps.set(currentCarrier(), cfgCapFps.value);
});

function captureWidthChoice(): CaptureWidthChoice {
  if (cfgWidth.value === "max") return "max";
  const width = Number(cfgWidth.value);
  return width === 960 || width === 1920 ? width : 1280;
}

function requestedCameraFromControls(): RequestedCameraSettings {
  const width = captureWidthChoice();
  const fps = Number(cfgCapFps.value);
  return {
    width,
    ...(width === "max" ? {} : { height: Math.round((width * 3) / 4) }),
    fps,
  };
}

function resetStableIntervalDedupe(): void {
  stableIntervalEpoch = 0;
  lastSubmittedStableIntervalEpoch = undefined;
}

async function ensureVisionDebugController(): Promise<VisionDebugController> {
  if (!__COLOR4_ENABLED__) throw new Error("Debug Vision is unavailable in this build.");
  if (visionDebugController) return visionDebugController;
  visionDebugPromise ??= import("./color4-debug-ui").then((module) =>
    module.createVisionDebugController({
      currentExperiment: () => experimentSnapshot(false),
      snapshotContext: () => {
        // Read the track at capture time. The cached UI summary can lag while
        // a live applyConstraints call is settling; getSettings() is the
        // authoritative negotiated state for snapshot evidence.
        const settings = stream?.getVideoTracks()[0]?.getSettings();
        return {
          requested: requestedCamera,
          actual: settings === undefined
            ? undefined
            : {
                width: settings.width,
                height: settings.height,
                fps: settings.frameRate,
              },
        };
      },
    }),
  );
  try {
    visionDebugController = await visionDebugPromise;
    return visionDebugController;
  } catch (error) {
    visionDebugPromise = null;
    throw error;
  }
}

function deactivateVisionDebug(): void {
  visionDebugController?.setTransferActive(false);
  latestCarrierDiagnostics = undefined;
}

function experimentSnapshot(
  success: boolean,
  failureReason?: string,
  payloadBytes?: number,
  fileBytes?: number,
): ExperimentSummary | undefined {
  if (!experiment) return undefined;
  return experiment.snapshot({
    success,
    payloadBytes: payloadBytes ?? decoder?.totalLen,
    fileBytes,
    newFrames: decoder?.framesNew,
    duplicateFrames: decoder?.framesDup,
    resolvedBlocks: decoder?.solvedCount,
    failureReason,
    ...negotiatedCamera,
  });
}

function persistExperiment(
  success: boolean,
  failureReason?: string,
  payloadBytes?: number,
  fileBytes?: number,
): void {
  const summary = experimentSnapshot(success, failureReason, payloadBytes, fileBytes);
  if (!summary) return;
  latestExperiment = summary;
  experiment = null;
  experimentSave = experimentSave.then(() => saveExperiment(summary));
}

function cancelActiveReceiver(message: string): void {
  if (!startBtn.disabled && !stream && !colorDecoder && !qrDecoder) return;
  persistExperiment(false, "configuration-changed");
  document.body.classList.remove("transfer-active");
  captureGen++;
  stream?.getTracks().forEach((track) => track.stop());
  stream = null;
  video.srcObject = null;
  clearInterval(statsTimer);
  statsTimer = undefined;
  qrDecoder?.dispose();
  qrDecoder = null;
  colorDecoder?.dispose();
  colorDecoder = null;
  captureStability = null;
  resetStableIntervalDedupe();
  deactivateVisionDebug();
  void releaseScreenWakeLock();
  activeCarrier = null;
  decoder = null;
  streamKey = "";
  startTs = 0;
  done = false;
  negotiatedCamera = undefined;
  preview.style.display = "none";
  metricsEl.style.display = "none";
  if (diagnosticsEl) diagnosticsEl.style.display = "none";
  progressEl.style.display = "none";
  progressStatus.style.display = "none";
  startBtn.style.display = "";
  startBtn.disabled = false;
  startBtn.textContent = "Start camera";
  setStatus(message);
}

async function initialiseReceiverControls(): Promise<void> {
  if (!__COLOR4_ENABLED__) {
    if (carrierColorOption) carrierColorOption.hidden = true;
    carrierPicker.hidden = true;
  } else {
    const preferredPalette = await loadPreference("receive.color4Palette", 0);
    cfgColorPalette!.value = preferredPalette === 1 ? "1" : "0";
    const preferredCarrier = await loadPreference<CarrierChoice>("receive.carrier", "qr");
    carrierInputs.find((input) => input.value === preferredCarrier)?.click();
    for (const input of carrierInputs) {
      input.addEventListener("change", () => {
        cancelActiveReceiver("Carrier changed — tap Start camera for a new session.");
        applyCarrierControls();
        void savePreference("receive.carrier", currentCarrier());
      });
    }
    cfgColorPalette!.addEventListener("change", () => {
      cancelActiveReceiver("Palette changed — tap Start camera for a new session.");
      void savePreference("receive.color4Palette", Number(cfgColorPalette!.value));
    });
    cfgVisionDebug?.addEventListener("change", () => {
      if (!cfgVisionDebug.checked) return;
      void ensureVisionDebugController().then((controller) => {
        if (!cfgVisionDebug.checked || !controller.enabled) return;
        if (activeCarrier !== "color4" || !stream || done) return;
        controller.setTransferActive(true);
        experiment?.setVisionContext({
          debugEnabled: true,
          canonicalScale: controller.canonicalScale,
          detectionDimension: controller.maxDetectionDimension,
          conditions: controller.conditions(),
        });
      }).catch((error) => {
        cfgVisionDebug.checked = false;
        showError(error instanceof Error ? error.message : String(error));
      });
    });
  }
  applyCarrierControls();
  startBtn.disabled = false;
}

exportMetricsBtn.addEventListener("click", async () => {
  await experimentSave;
  const history = await listExperiments();
  const current = experimentSnapshot(false);
  downloadExperimentExport(makeExperimentExport(history, current));
});
clearMetricsBtn.addEventListener("click", async () => {
  clearMetricsBtn.disabled = true;
  await experimentSave;
  await clearExperiments();
  latestExperiment = undefined;
  clearMetricsBtn.textContent = "History cleared";
  setTimeout(() => {
    clearMetricsBtn.textContent = "Clear history";
    clearMetricsBtn.disabled = false;
  }, 1500);
});

void initialiseReceiverControls();

function renderNoSignalTips(): void {
  const carrierTips = __COLOR4_ENABLED__ && currentCarrier() === "color4"
    ? [
        "Use the ROBUST profile with the stable KCMY palette on both devices.",
        "Set the sender to 5 fps and keep every colored cell sharp and fully visible.",
      ]
    : [
        `On the sender, open Transfer settings and drop bytes / frame to ${NO_SIGNAL_HINT_FRAME_BYTES}.`,
        `Still nothing? Drop the sender's tx fps to ${NO_SIGNAL_HINT_TX_FPS} as well.`,
      ];
  const commonTips = [
    "Fill this camera's view with the code, and prop the phone against something — autofocus hunting from hand tremor is the usual culprit.",
    "Turn the sending screen's brightness all the way up.",
  ];
  // Measured advice goes first: generic troubleshooting is a guess, and this is
  // the one thing the receiver actually knows about the frames it is seeing.
  const measuredTips = measuredFramingAdvice()?.tips ?? [];
  const lines = [...measuredTips, ...carrierTips, ...commonTips];
  noSignalTips.replaceChildren(
    ...lines.map((line) => {
      const item = document.createElement("li");
      item.textContent = line;
      return item;
    }),
  );
}

/** Framing advice is COLOR_4-only: the QR path measures none of these inputs. */
function measuredFramingAdvice() {
  if (!__COLOR4_ENABLED__ || currentCarrier() !== "color4") return undefined;
  return framingAdvice.advice;
}

document.getElementById("no-signal-help")!.addEventListener("click", () => {
  renderNoSignalTips();
  noSignalDialog.showModal();
});
document.getElementById("no-signal-dismiss")!.addEventListener("click", dismissNoSignal);
document.getElementById("no-signal-close")!.addEventListener("click", () => noSignalDialog.close());
// A tap on the backdrop closes too — geometry-tested, see shared/dialog.ts.
closeOnBackdropClick(noSignalDialog);
// close fires on the button, Esc, the backdrop, and the programmatic close
// when a frame finally decodes — all of them mean the advice has been seen.
noSignalDialog.addEventListener("close", dismissNoSignal);

function dismissNoSignal() {
  noSignalToast.hidden = true;
  noSignal.dismiss(performance.now());
}

/** By the time a transfer ends the camera, worker pool and stats timer are all
 *  torn down and `done` is latched, so a reload is the honest way back to a
 *  live receiver — and it drops the recovered bytes from memory on the way. */
function restartButton(label: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "secondary-button";
  button.textContent = label;
  button.addEventListener("click", () => window.location.reload());
  return button;
}

/** Put the page back the way it was so a refused camera can be retried without
 *  a reload. Tapping "Block" by accident on the permission prompt is easy, and
 *  a dead page with no button is a bad answer to it. */
function offerRetry(message: string) {
  document.body.classList.remove("transfer-active");
  stream?.getTracks().forEach((track) => track.stop());
  stream = null;
  video.srcObject = null;
  qrDecoder?.dispose();
  qrDecoder = null;
  colorDecoder?.dispose();
  colorDecoder = null;
  captureStability = null;
  resetStableIntervalDedupe();
  deactivateVisionDebug();
  void releaseScreenWakeLock();
  activeCarrier = null;
  startBtn.disabled = false;
  startBtn.style.display = "";
  startBtn.textContent = "Start camera";
  preview.style.display = "none";
  metricsEl.style.display = "none";
  if (diagnosticsEl) diagnosticsEl.style.display = "none";
  showError(message);
}

async function start() {
  if (!navigator.mediaDevices?.getUserMedia) {
    // On insecure origins the API doesn't exist AT ALL — this is the plain-
    // http-over-LAN case. localhost is exempt; other hosts need https.
    showError(
      "camera needs a secure context — this page must be served over https to " +
        "use the camera from another device. `npm run dev` already is.",
    );
    return;
  }
  const startGeneration = ++captureGen;
  const requestedCarrier = currentCarrier();
  activeCarrier = requestedCarrier;
  done = false;
  decoder = null;
  streamKey = "";
  startTs = 0;
  if (__COLOR4_ENABLED__ && requestedCarrier === "color4") {
    startBtn.disabled = true;
    startBtn.textContent = "Loading COLOR_4…";
    try {
      const [module] = await Promise.all([
        loadColor4Receiver(),
        // The controller also owns the experiment settings lock. Create it for
        // every COLOR_4 session even while live debug remains opt-in/off.
        ensureVisionDebugController(),
      ]);
      if (startGeneration !== captureGen) return;
      const paletteId = Number(cfgColorPalette!.value) === 1 ? 1 : 0;
      colorDecoder = module.createColor4Decoder(paletteId);
      startBtn.textContent = "Initializing COLOR_4 vision…";
      await colorDecoder.ready;
      if (startGeneration !== captureGen) {
        colorDecoder?.dispose();
        colorDecoder = null;
        return;
      }
    } catch (error) {
      if (startGeneration !== captureGen) return;
      offerRetry(error instanceof Error ? error.message : String(error));
      return;
    }
  } else {
    startBtn.disabled = true;
    startBtn.textContent = "Loading QR decoder…";
    try {
      // Keep ZXing and its pool out of COLOR_4 sessions. The QR adapter is
      // fetched only after the user starts the explicitly selected carrier.
      const module = await import("./qr-carrier");
      if (startGeneration !== captureGen) return;
      qrDecoder = module.createQrLegacyDecoder({
        workerCount: Number(cfgWorkers.value),
        onFatal: () =>
          cancelActiveReceiver("The QR decoder worker stopped — tap Start camera to retry."),
      });
    } catch (error) {
      if (startGeneration !== captureGen) return;
      offerRetry(error instanceof Error ? error.message : String(error));
      return;
    }
  }
  requestedCamera = requestedCameraFromControls();
  const captureWidth = requestedCamera.width;
  const captureFps = requestedCamera.fps;
  // Nothing on the page changes until the camera is actually running: the
  // error paths below all have to leave a usable Start button behind.
  startBtn.disabled = true;
  startBtn.textContent = "Starting…";
  const attempts = cameraConstraintLadder(requestedCarrier, captureWidth, captureFps);
  let cameraError: unknown;
  try {
    for (const attempt of attempts) {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: attempt.constraints,
        });
        break;
      } catch (error) {
        cameraError = error;
      }
    }
    if (!stream) throw cameraError ?? new Error("No camera constraint attempt succeeded.");
    if (__COLOR4_ENABLED__ && requestedCarrier === "color4" && captureWidth === "max") {
      const track = stream.getVideoTracks()[0];
      if (track) await applyMaximumSupportedWidth(track, captureFps);
    }
  } catch (err) {
    if (startGeneration !== captureGen) return;
    const denied = err instanceof DOMException && err.name === "NotAllowedError";
    offerRetry(
      denied
        ? "camera permission denied — allow it, then tap Start camera again."
        : `camera: ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }
  if (startGeneration !== captureGen) {
    stream?.getTracks().forEach((track) => track.stop());
    stream = null;
    return;
  }

  startBtn.style.display = "none";
  // "": back to the stylesheet's flex — the zone centers the camera box.
  preview.style.display = "";
  metricsEl.style.display = "grid";
  if (diagnosticsEl) diagnosticsEl.style.display = "block";
  video.srcObject = stream;
  await video.play().catch(() => undefined);
  if (startGeneration !== captureGen) {
    stream?.getTracks().forEach((track) => track.stop());
    stream = null;
    video.srcObject = null;
    return;
  }
  document.body.classList.add("transfer-active");
  const settings = stream.getVideoTracks()[0]?.getSettings();
  negotiatedCamera = {
    cameraWidth: settings?.width,
    cameraHeight: settings?.height,
    cameraFps: settings?.frameRate,
  };
  experiment = new ExperimentMetrics(
    "receive",
    __COLOR4_ENABLED__ ? carrierId(requestedCarrier) : "QR_LEGACY",
  );
  latestCarrierDiagnostics = undefined;
  if (__COLOR4_ENABLED__ && requestedCarrier === "color4") {
    visionDebugController?.setTransferActive(true);
    captureStability = new CaptureStabilityTracker(
      visionDebugController?.prefilterMode ?? "observe",
      COLOR4_STABILITY_THRESHOLD,
    );
    resetStableIntervalDedupe();
    experiment.setVisionContext({
      debugEnabled: visionDebugController?.enabled ?? false,
      canonicalScale: visionDebugController?.canonicalScale ?? DEFAULT_COLOR4_CANONICAL_SCALE,
      detectionDimension:
        visionDebugController?.maxDetectionDimension ?? DEFAULT_COLOR4_DETECTION_DIMENSION,
      conditions: visionDebugController?.conditions(),
    });
  }
  setStatus(
    `camera ${settings?.width}×${settings?.height}@${settings?.frameRate} — searching for a stream…`,
  );

  await applyCameraExtras();
  reportCameraSettings();
  if (!settingsWired) {
    settingsWired = true;
    for (const el of [cfgWidth, cfgCapFps, cfgWorkers]) {
      el.addEventListener("change", queueReceiveSettingsApply);
    }
  }

  noSignal.cameraStarted(performance.now());
  scheduleFrame(startGeneration);
  statsTimer = setInterval(updateStats, 500);
  await requestScreenWakeLock();
}

/** Report what the camera actually negotiated — iOS in particular will happily
 *  hand back 30 fps after accepting a request for 60. */
function reportCameraSettings(note?: string) {
  const track = stream?.getVideoTracks()[0];
  if (!track) return;
  const s = track.getSettings();
  const askedFps = requestedCamera.fps;
  const gotFps = Math.round(s.frameRate ?? 0);
  negotiatedCamera = {
    cameraWidth: s.width,
    cameraHeight: s.height,
    cameraFps: s.frameRate,
  };
  const fpsNote = gotFps && gotFps !== askedFps ? ` (asked ${askedFps})` : "";
  const askedWidth = requestedCamera.width;
  const widthNote = askedWidth === "max"
    ? " (asked max supported)"
    : s.width !== undefined && s.width !== askedWidth
      ? ` (asked ${askedWidth})`
      : "";
  const workers = __COLOR4_ENABLED__ && activeCarrier === "color4"
    ? "1 COLOR_4 vision worker"
    : `${qrDecoder?.size ?? 0} QR decode worker${qrDecoder?.size === 1 ? "" : "s"}`;
  cameraActual.textContent =
    `camera ${s.width}×${s.height}${widthNote} @ ${gotFps} fps${fpsNote} · ${workers} · ` +
    (note ?? "changes apply live");
}

/** Use what this camera can actually do, probed rather than UA-sniffed.
 *  Continuous camera modes are applied individually and silently; unsupported
 *  or refused modes leave that camera setting unchanged. Frame rates the
 *  current mode can't reach are grayed out. */
async function applyCameraExtras(track: MediaStreamTrack | undefined = stream?.getVideoTracks()[0]) {
  if (!track) return;
  const caps = probeCameraCapabilities(track);
  await applyContinuousCameraModes(track, caps);
  if (caps.maxFrameRate) {
    for (const option of Array.from(cfgCapFps.options)) {
      option.disabled = Number(option.value) > caps.maxFrameRate;
    }
  }
}

function queueReceiveSettingsApply(): void {
  const camera = requestedCameraFromControls();
  const workerCount = Number(cfgWorkers.value);
  const generation = captureGen;
  // Publish the complete atomic request immediately. The actual values remain
  // the last getSettings() observation until this queued request settles.
  requestedCamera = camera;
  receiveSettingsQueue = receiveSettingsQueue
    .then(() => applyReceiveSettings(camera, workerCount, generation))
    .catch((error: unknown) => {
      if (generation !== captureGen || camera !== requestedCamera) return;
      reportCameraSettings(
        `live change failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
}

async function applyReceiveSettings(
  camera: RequestedCameraSettings,
  workerCount: number,
  generation: number,
): Promise<void> {
  // finish() has already torn the pool down — don't resurrect it.
  if (done || generation !== captureGen) return;
  if (activeCarrier === "qr") qrDecoder?.resize(workerCount);
  const track = stream?.getVideoTracks()[0];
  if (!track) return;
  try {
    if (__COLOR4_ENABLED__ && activeCarrier === "color4" && camera.width === "max") {
      const result = await applyMaximumSupportedWidth(track, camera.fps);
      if (!result.applied) {
        if (generation !== captureGen || track !== stream?.getVideoTracks()[0]) return;
        reportCameraSettings(
          camera === requestedCamera
            ? "this camera refused the live change — restart to apply"
            : undefined,
        );
        return;
      }
    } else {
      const numericWidth = camera.width === "max" ? 1280 : camera.width;
      await track.applyConstraints({
        width: { ideal: numericWidth },
        height: { ideal: Math.round((numericWidth * 3) / 4) },
        frameRate: { ideal: camera.fps },
      });
    }
  } catch {
    if (generation !== captureGen || track !== stream?.getVideoTracks()[0]) return;
    // Refresh actual settings even on refusal. Only the newest queued request
    // owns the refusal annotation; an older refusal must not overwrite it.
    reportCameraSettings(
      camera === requestedCamera
        ? "this camera refused the live change — restart to apply"
        : undefined,
    );
    // Some devices (notably iOS) refuse a live reconfigure. Keep the stream we
    // have rather than tearing down a transfer in progress.
    return;
  }
  if (generation !== captureGen || track !== stream?.getVideoTracks()[0]) return;
  await applyCameraExtras(track);
  if (generation !== captureGen || track !== stream?.getVideoTracks()[0]) return;
  reportCameraSettings();
}

type VideoRVFC = HTMLVideoElement & { requestVideoFrameCallback?: (cb: () => void) => number };

function scheduleFrame(gen: number) {
  if (done || gen !== captureGen) return;
  const v = video as VideoRVFC;
  const next = () => {
    if (done || gen !== captureGen) return;
    captureFrame();
    scheduleFrame(gen);
  };
  if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(next);
  else requestAnimationFrame(next);
}

const grab = document.createElement("canvas");
const stabilityGrab = document.createElement("canvas");
stabilityGrab.width = COLOR4_CAPTURE_FINGERPRINT_WIDTH;
stabilityGrab.height = COLOR4_CAPTURE_FINGERPRINT_HEIGHT;

function measureColor4Stability(): CaptureStabilityResult {
  const context = stabilityGrab.getContext("2d", { willReadFrequently: true })!;
  context.drawImage(
    video,
    0,
    0,
    COLOR4_CAPTURE_FINGERPRINT_WIDTH,
    COLOR4_CAPTURE_FINGERPRINT_HEIGHT,
  );
  const pixels = context.getImageData(
    0,
    0,
    COLOR4_CAPTURE_FINGERPRINT_WIDTH,
    COLOR4_CAPTURE_FINGERPRINT_HEIGHT,
  );
  const fingerprint = createCaptureLumaFingerprint(
    pixels.data,
    COLOR4_CAPTURE_FINGERPRINT_WIDTH,
    COLOR4_CAPTURE_FINGERPRINT_HEIGHT,
  );
  return captureStability!.observe(fingerprint);
}

function captureFrame() {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) return;
  captureTimes.push(performance.now());
  experiment?.recordCapture();
  let stability: CaptureStabilityResult | undefined;
  let qualityRecorded = false;
  if (__COLOR4_ENABLED__ && activeCarrier === "color4") {
    if (!colorDecoder) return;
    if (!captureStability) return;
    stability = measureColor4Stability();
    if (stability.state === "warmup") {
      experiment?.recordStabilityWarmupCapture();
      experiment?.recordQualityClass("UNKNOWN");
      qualityRecorded = true;
    } else if (stability.state === "stable") {
      experiment?.recordStableCapture(stability.p90MaeNormalized);
    } else {
      experiment?.recordUnstableCapture(stability.p90MaeNormalized);
      experiment?.recordQualityClass("UNUSABLE");
      qualityRecorded = true;
      stableIntervalEpoch++;
      lastSubmittedStableIntervalEpoch = undefined;
    }
    if (!stability.shouldSubmit) {
      if (stability.state === "unstable") experiment?.recordSkippedUnstable();
      // A capture dropped before decoding never reaches the worker callback, so
      // record it here or a receiver that gates on stability would collect no
      // evidence at all about why it is stuck.
      framingAdvice.observe({ stability: stability.state, vision: undefined });
      return;
    }
    if (
      captureStability.mode === "enabled" &&
      stability.state === "stable" &&
      lastSubmittedStableIntervalEpoch === stableIntervalEpoch &&
      !visionDebugController?.snapshotPending
    ) {
      experiment?.recordSkippedRedundantStable();
      experiment?.recordQualityClass("UNKNOWN");
      qualityRecorded = true;
      return;
    }
    if (colorDecoder.busy) {
      experiment?.recordSkippedWhileBusy();
      if (!qualityRecorded) experiment?.recordQualityClass("UNKNOWN");
      return;
    }
  } else {
    if (!qrDecoder) return;
    if (qrDecoder.busy) {
      experiment?.recordSkippedWhileBusy();
      return; // all QR workers busy — drop it, no harm done
    }
  }
  if (grab.width !== vw || grab.height !== vh) {
    grab.width = vw;
    grab.height = vh;
  }
  const captureStarted = performance.now();
  const ctx = grab.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(video, 0, 0);
  const img = ctx.getImageData(0, 0, vw, vh);
  const capturedAt = performance.now();
  const captureMs = Math.max(0, capturedAt - captureStarted);
  if (__COLOR4_ENABLED__ && activeCarrier === "color4" && colorDecoder) {
    const decoderGeneration = captureGen;
    // Claim the stable interval when the frame is dispatched, not when its
    // asynchronous result arrives. A rejection still consumes the interval;
    // an explicitly armed snapshot remains the sole dedupe bypass so it can
    // capture the next frame. Transitions increment the epoch before another
    // submission, so an older callback cannot consume the new interval.
    if (captureStability?.mode === "enabled" && stability?.state === "stable") {
      lastSubmittedStableIntervalEpoch = stableIntervalEpoch;
    }
    // Count the submission before snapshot metadata is frozen so the capture's
    // experiment view is coherent with the frame being handed to the worker.
    experiment?.recordVisionSubmission();
    const debugOptions = visionDebugController?.decodeOptions(capturedAt);
    void colorDecoder.decode(
      { source: img, timestamp: capturedAt },
      { captureMs, ...(debugOptions ? { debug: debugOptions } : {}) },
    ).then(
      (decoded) => {
        if (done || decoderGeneration !== captureGen || activeCarrier !== "color4") return;
        decodeTimes.push(performance.now());
        const diagnostics = decoded.diagnostics as BrowserCarrierDiagnostics;
        latestCarrierDiagnostics = diagnostics;
        if (!qualityRecorded) {
          experiment?.recordQualityClass(classifyColor4CaptureQuality(stability?.state, diagnostics.vision));
          qualityRecorded = true;
        }
        // The same measurements that feed the experiment counters are the only
        // evidence the user has for why nothing is decoding, so keep a rolling
        // verdict ready for the hint.
        framingAdvice.observe({ stability: stability?.state, vision: diagnostics.vision });
        if (decoded.debug && visionDebugController) {
          visionDebugController.handleFrame({
            ...decoded.debug,
            diagnostics: {
              carrier: diagnostics,
              classifier: decoded.debug.classifier,
              unwrap: decoded.debug.unwrap,
            },
          });
        }
        experiment?.setProfile(diagnostics.profile);
        experiment?.recordAttempt(decoded.status, diagnostics);
        if (decoded.status === "valid") {
          onDecoded(decoded.innerFrame);
        }
      },
      (error) => {
        if (done || decoderGeneration !== captureGen || activeCarrier !== "color4") return;
        decodeTimes.push(performance.now());
        if (!qualityRecorded) experiment?.recordQualityClass("UNKNOWN");
        visionDebugController?.failSnapshot("Snapshot failed because the vision worker stopped.");
        experiment?.recordAttempt("rejected", { stage: "wire" });
        const failureReason =
          error instanceof Error ? error.message : "The COLOR_4 vision worker stopped.";
        persistExperiment(false, failureReason);
        cancelActiveReceiver(failureReason);
      },
    );
    return;
  }
  if (activeCarrier === "qr" && qrDecoder) {
    const decoderGeneration = captureGen;
    void qrDecoder.decode({ source: img, timestamp: performance.now() }).then(
      (decoded) => {
        if (done || decoderGeneration !== captureGen || activeCarrier !== "qr") return;
        decodeTimes.push(performance.now());
        const diagnostics = decoded.diagnostics as BrowserCarrierDiagnostics;
        experiment?.recordAttempt(decoded.status, diagnostics);
        if (decoded.status === "valid") onDecoded(decoded.innerFrame);
      },
      (error) => {
        // A worker crash invokes the adapter's fatal callback synchronously;
        // that bumps captureGen, so this rejection becomes stale and harmless.
        if (done || decoderGeneration !== captureGen || activeCarrier !== "qr") return;
        decodeTimes.push(performance.now());
        experiment?.recordAttempt("rejected", { stage: "wire" });
        const failureReason =
          error instanceof Error ? error.message : "The QR decoder worker stopped.";
        persistExperiment(false, failureReason);
        cancelActiveReceiver(failureReason);
      },
    );
  }
}

function onDecoded(bytes: Uint8Array) {
  const parsed = parseFrame(bytes);
  if (!parsed || done) return;
  const { header, block } = parsed;
  if (header.k !== Math.ceil(header.totalLen / header.blockLen)) return;
  // The link demonstrably works, so whatever the earlier captures were
  // complaining about is history and must not resurface later in the transfer.
  framingAdvice.reset();
  if (noSignal.frameDecoded()) {
    noSignalToast.hidden = true;
    // The dialog's premise ("nothing decoded") just became false mid-read.
    if (noSignalDialog.open) noSignalDialog.close();
  }
  // streamIdentity() covers every header field that has to hold constant, not
  // just the session id — see the note on it in protocol.ts.
  const identity = streamIdentity(header);
  if (!decoder || streamKey !== identity) {
    decoder = new LTDecoder(header.k, header.blockLen, header.sessionId, header.totalLen);
    streamKey = identity;
    startTs = performance.now();
    progressEl.style.display = "block";
    progressStatus.style.display = "flex";
  }
  decoder.addFrame(header.seq, block);
  updateProgressEstimate();

  if (decoder.isComplete) {
    const payload = decoder.assemble()!;
    const seconds = (performance.now() - startTs) / 1000;
    const ok = fnv1a(payload) === header.payloadFnv;
    void finish(payload, ok, seconds);
  }
}

function updateProgressEstimate() {
  if (!decoder) return;
  const elapsed = Math.max(0, (performance.now() - startTs) / 1000);
  const estimate = estimateTransferProgress(
    decoder.k,
    decoder.framesNew,
    elapsed,
    decoder.solvedCount,
  );
  const percent = estimate.fraction * 100;
  const shownPercent = percent < 10 ? percent.toFixed(1) : percent.toFixed(0);
  bar.style.width = `${percent.toFixed(1)}%`;
  progressEl.setAttribute("aria-valuenow", String(Math.floor(percent)));
  progressLabel.textContent =
    `${shownPercent}% · ${decoder.solvedCount}/${decoder.k} blocks`;
  // Held back for the first few frames — a two-frame sample reads wildly wrong.
  const rate = decoder.framesNew >= 4 ? ` · ${goodputKbs(elapsed).toFixed(1)} KB/s` : "";
  etaLabel.textContent =
    (estimate.etaSeconds === undefined
      ? estimate.phase === "decoding"
        ? `${decoder.framesNew} frames · decoding`
        : "Estimating time…"
      : `About ${formatDuration(estimate.etaSeconds)} · ${decoder.framesNew} frames`) + rate;
}

/** Payload KB/s, discounting the frames the fountain spends on overhead. That
 *  discount is k-dependent — assuming a flat 1.18 over-reported small transfers
 *  by up to 2×, because a short stream needs far more redundancy per block. */
function goodputKbs(elapsed: number): number {
  if (!decoder) return 0;
  return (
    (decoder.framesNew * decoder.blockLen) /
    expectedFountainOverhead(decoder.k) /
    1024 /
    Math.max(0.1, elapsed)
  );
}

async function finish(container: Uint8Array, hashOk: boolean, seconds: number) {
  done = true;
  captureGen++;
  captureStability = null;
  resetStableIntervalDedupe();
  // Tear the whole capture pipeline down: the camera, the stats timer, and the
  // decode pool. Each worker holds its own ~940 KB zxing WASM instance, which
  // is worth reclaiming on a phone the moment the last frame is in.
  stream?.getTracks().forEach((t) => t.stop());
  clearInterval(statsTimer);
  statsTimer = undefined;
  qrDecoder?.dispose();
  qrDecoder = null;
  colorDecoder?.dispose();
  colorDecoder = null;
  deactivateVisionDebug();
  void releaseScreenWakeLock();
  preview.style.display = "none";
  // The transfer is over and the pipeline is gone: settings for a camera that
  // no longer exists would just be a dead control panel.
  settingsEl.style.display = "none";
  // The metrics stay, frozen at their last tick — but "Live" is no longer
  // true, so the panel relabels itself as the record of the run it now is.
  const diagnosticsLabel = diagnosticsEl?.querySelector("summary");
  if (diagnosticsLabel) diagnosticsLabel.textContent = "Transfer summary";
  bar.style.width = "100%";
  progressEl.setAttribute("aria-valuenow", "100");
  etaLabel.textContent = `${formatDuration(seconds)} total`;
  try {
    if (!hashOk) throw new Error("The optical stream checksum did not match.");
    const file = await unpackFile(container);
    if (!(await verifyFile(file))) throw new Error("The recovered file failed SHA-256 verification.");
    persistExperiment(true, undefined, container.length, file.bytes.length);

    // The container carries its own media type, so the receiver never has to be
    // told in advance whether a file or a text snippet is coming.
    const rate = (container.length / 1024 / seconds).toFixed(1);
    const gzipNote = file.compression === "gzip" ? "gzip decompressed · " : "";
    if (isSnippet(file)) {
      progressLabel.textContent = "100% · text recovered";
      setStatus("");
      showSnippet(
        snippetText(file),
        `text in ${seconds.toFixed(1)} s · ${rate} KB/s · ${gzipNote}SHA-256 verified ✓`,
      );
      return;
    }

    progressLabel.textContent = "100% · file recovered";
    const kb = Math.round(file.bytes.length / 1024);
    // The run's numbers belong under the heading, not up in the camera status
    // line — which is done for good and goes quiet.
    setStatus("");
    const summary = document.createElement("p");
    summary.className = "hint";
    summary.textContent =
      `${kb} KB in ${seconds.toFixed(1)} s · ${rate} KB/s · ${gzipNote}SHA-256 verified ✓`;
    const heading = document.createElement("div");
    heading.className = "done";
    heading.textContent = "Signal recovered";
    const url = URL.createObjectURL(new Blob([file.bytes as BlobPart], { type: file.type }));
    const download = document.createElement("a");
    download.className = "download";
    download.href = url;
    download.download = file.name;
    download.textContent = `Save ${file.name}`;
    // Reading order of the finished page: heading, the run's numbers, the
    // thing that arrived, Save under it, "Capture another transfer", and the
    // Transfer summary panel last in its natural spot after #result.
    result.replaceChildren(heading, summary);
    if (file.type.startsWith("image/")) {
      const image = document.createElement("img");
      image.className = "received";
      image.alt = `Received file preview: ${file.name}`;
      image.src = url;
      result.append(image);
    } else if (file.type.startsWith("video/") || file.type.startsWith("audio/")) {
      const player = document.createElement(file.type.startsWith("video/") ? "video" : "audio");
      player.className = "received";
      player.controls = true;
      player.preload = "metadata";
      player.setAttribute("aria-label", `Received file: ${file.name}`);
      // Inline, and never autoplay — the user taps play (which is also the
      // gesture that lets it start with sound).
      if (player instanceof HTMLVideoElement) player.playsInline = true;
      const src = await servableMediaUrl(file, url);
      if (src !== url) {
        // AVFoundation has been seen bypassing service workers for media
        // loads; if the cache path 404s, fall back to the blob rather than
        // leaving a dead player.
        player.addEventListener("error", () => { player.src = url; }, { once: true });
      }
      player.src = src;
      result.append(player);
    }
    const actions = document.createElement("div");
    actions.className = "note-actions";
    actions.append(download);
    const endActions = document.createElement("div");
    endActions.className = "note-actions";
    endActions.append(restartButton("Capture another transfer"));
    // The received bytes sit in the Cache API so the media player can range
    // over them (see servableMediaUrl) — which means they outlive the page.
    // Offer the scrub right where the transfer ends.
    if ("caches" in window) endActions.append(clearCacheButton());
    result.append(actions, endActions);
  } catch (error) {
    const failureReason = error instanceof Error ? error.message : String(error);
    persistExperiment(false, failureReason, container.length);
    // Everything is already torn down by this point, so the only way back to a
    // live receiver is a reload. Offer it: a failed checksum used to leave the
    // page dead with nothing but an error string on it.
    bar.classList.add("error");
    etaLabel.textContent = "Transfer failed";
    showError(failureReason);
    const heading = document.createElement("div");
    heading.className = "failed";
    heading.textContent = "Transfer failed";
    const detail = document.createElement("p");
    detail.className = "received-note";
    detail.textContent =
      "Nothing usable came out of that stream. Restart the sender, then scan it again — " +
      "a partial transfer costs nothing but the time.";
    result.replaceChildren(heading, detail, restartButton("Capture again"));
  } finally {
    // A waiting service worker may reload as soon as this class disappears.
    // Keep the lease until SHA verification and the Save/Copy UI are complete.
    document.body.classList.remove("transfer-active");
  }
}

/** Deletes the received-media runtime cache (see servableMediaUrl). Unlike the
 *  app-shell precache and metrics-only IndexedDB, this cache can contain the
 *  last received audio/video bytes. A player still streaming from it falls
 *  back to its blob URL via the error listener wired in finish(). */
function clearCacheButton(): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "secondary-button";
  button.textContent = "Clear received media";
  button.addEventListener("click", () => {
    button.disabled = true;
    caches.delete("received-media").then(
      () => {
        button.textContent = "Cache cleared";
      },
      () => {
        button.textContent = "Clear failed — try again";
        button.disabled = false;
      },
    );
  });
  return button;
}

/** A playable URL for received media. iOS Safari will not reliably play media
 *  handed to <video>/<audio> as a blob: URL — WebKit's media loader wants real
 *  HTTP semantics, Range requests included (a lesson inherited from the
 *  original demo's range-shim worker). The bytes go into the Cache API and
 *  come back out through the service worker's range-aware route at a real URL
 *  (see runtimeCaching in vite.config.ts). The blob URL stands in when no
 *  worker controls the page: first ever visit, or the standalone file. */
async function servableMediaUrl(file: OpticalFile, blobUrl: string): Promise<string> {
  try {
    if (!navigator.serviceWorker?.controller) return blobUrl;
    // Resolved against the page (one directory deep), landing on the site
    // root — where the worker's route matches under any deploy subpath.
    const target = new URL("../received-media/current", window.location.href).href;
    const cache = await caches.open("received-media");
    await cache.put(
      target,
      new Response(new Blob([file.bytes as BlobPart]), {
        headers: {
          "Content-Type": file.type,
          "Content-Length": String(file.bytes.length),
        },
      }),
    );
    // The query defeats the media element's memory of this URL from an
    // earlier transfer; the worker matches with ignoreSearch.
    return `${target}?v=${Date.now()}`;
  } catch {
    return blobUrl;
  }
}

/**
 * Seconds of camera and not one decoded frame.
 *
 * Both real fixes are on the SENDER, which is the non-obvious part — someone
 * staring at a blank receiver reaches for the phone. The defaults (2953 bytes
 * per frame at 60 fps) are tuned for a close-range phone-to-phone demo and are
 * exactly the combination that fails on an ordinary monitor at arm's length.
 *
 * The toast itself only asks the question; the sender-side advice sits behind
 * its Help button in a modal. It stops for good on the first frame that
 * parses, which is the only thing that actually means it worked.
 */
function showNoSignalHint() {
  // "Nothing happening?" is all we can say when the receiver has no idea why.
  // When the captures agree on a cause, lead with the fix instead.
  noSignalHeadline.textContent =
    measuredFramingAdvice()?.headline ?? NO_SIGNAL_DEFAULT_HEADLINE;
  noSignalToast.hidden = false;
}

/** Nothing is persisted: the text lives here until the page is closed. The
 *  summary line mirrors the file path — run stats under the heading, not up
 *  in the camera status line. */
function showSnippet(text: string, summaryLine: string) {
  const heading = document.createElement("div");
  heading.className = "done";
  heading.textContent = "Text received";

  const summary = document.createElement("p");
  summary.className = "hint";
  summary.textContent = summaryLine;

  const body = document.createElement("p");
  body.className = "received-note";
  body.textContent = text;

  const actions = document.createElement("div");
  actions.className = "note-actions";
  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "text-button";
  copy.textContent = "Copy";
  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(text);
      copy.textContent = "Copied";
      setTimeout(() => { copy.textContent = "Copy"; }, 1500);
    } catch {
      copy.textContent = "Copy failed";
    }
  });
  actions.append(copy, restartButton("Capture another transfer"));

  result.replaceChildren(heading, summary, body, actions);
}

function updateStats() {
  if (done) return;
  const now = performance.now();
  const prune = (a: number[]) => {
    while (a.length > 0 && a[0]! < now - STATS_WINDOW_MS) a.shift();
  };
  prune(captureTimes);
  prune(decodeTimes);
  const perSecond = (a: number[]) => a.length / (STATS_WINDOW_MS / 1000);
  metric("m-cap").textContent = perSecond(captureTimes).toFixed(0);
  metric("m-dec").textContent = perSecond(decodeTimes).toFixed(1);
  const measured = experiment ?? latestExperiment;
  if (measured) {
    metric("m-carrier").textContent = `${measured.validFrames}/${measured.carrierRejected}`;
    metric("m-rs").textContent =
      `${measured.rsCorrectedSymbols}/${measured.erasureBytes}`;
  }
  if (__COLOR4_ENABLED__) {
    metric("m-stage").textContent = latestCarrierDiagnostics?.stage ?? "—";
    metric("m-reason").textContent =
      latestCarrierDiagnostics?.vision?.diagnosticReason ??
      latestCarrierDiagnostics?.vision?.rejectReason ??
      latestCarrierDiagnostics?.rejectReason ??
      "—";
    const fiducials = latestCarrierDiagnostics?.vision?.fiducials;
    metric("m-fiducials").textContent = fiducials
      ? `${(["TL", "TR", "BR", "BL"] as const).filter((id) => fiducials[id]?.found).length}/4`
      : "—";
    const visionSummary = experimentSnapshot(false)?.vision ?? latestExperiment?.vision;
    const workerTiming = visionSummary?.timingsMs.workerTotal;
    metric("m-pipeline").textContent = workerTiming
      ? `${workerTiming.p50.toFixed(0)}/${workerTiming.p95.toFixed(0)} ms${
          visionSummary?.workerP95ExceedsTxFrameInterval ? " ⚠ slower than TX interval" : ""
        }`
      : "—";
  }
  // Evidence keeps arriving while the hint is on screen, so a verdict that only
  // reaches quorum after it appeared still gets to replace the generic line.
  if (noSignal.tick(now) || noSignal.isVisible) showNoSignalHint();
  if (!decoder) return;
  const elapsed = (now - startTs) / 1000;
  updateProgressEstimate();
  metric("m-rate").textContent = `${goodputKbs(elapsed).toFixed(1)} KB/s`;
  metric("m-time").textContent = `${elapsed.toFixed(0)} s`;
  metric("m-frames").textContent = `${decoder.framesNew}/${decoder.framesDup}`;
  metric("m-k").textContent = String(decoder.k);
  metric("m-block").textContent = `${decoder.blockLen} B`;
  metric("m-payload").textContent = `${Math.round(decoder.totalLen / 1024)} KB`;
}
