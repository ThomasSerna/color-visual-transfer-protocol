import {
  decodeCanonicalColor4Raster,
  guardCanonicalColor4Samples,
  type CanonicalColor4GuardResult,
  type CanonicalRasterObservation,
  type CanonicalRasterResult,
  type RejectReason,
  type Color4UnwrapObservation,
} from "../shared/color4";
import {
  decodeCanonicalColor4Samples,
  type CanonicalModuleSamples,
  type CanonicalRasterImage,
} from "../shared/color4/classifier";
import type {
  BrowserCarrierDiagnostics,
  BrowserVisionDiagnostics,
  Color4DiagnosticReason,
  VisionTimingKey,
} from "../shared/carrier";
import {
  Color4CompactSamplerWithOpenCv,
  acquireColor4TemporalGeometryWithOpenCv,
  createVisionGrayscaleFrameWithOpenCv,
  normalizeColor4WithOpenCv,
  supportsCompactColor4Sampling,
  trackVisionTemporalHintWithOpenCv,
  type OpenCvRuntime,
  type VisionGrayscaleFrame,
  type VisionResult,
  type VisionTemporalAcquisitionResult,
  type VisionTemporalHint,
} from "./color4-vision";
import { color4SequencePhaseMatches } from "./color4-binding";
import { canonicalDiagnosticReason, fecDiagnosticReason } from "./color4-diagnostic-reason";
import {
  runColor4ErasurePolicy,
  type Color4ErasurePolicyResult,
} from "./color4-erasure-policy";
import type {
  Color4WorkerDebugFrame,
  Color4ClassifyRequest,
  Color4WorkerDecodeRequest,
  Color4WorkerDiagnostics,
  Color4GeometryRequest,
  Color4GeometrySnapshot,
  Color4WorkerRequest,
  Color4WorkerResponse,
} from "./color4-worker-protocol";

type RequiredStage = Exclude<BrowserCarrierDiagnostics["stage"], undefined>;
type MutableDiagnostics = {
  -readonly [Key in keyof Color4WorkerDiagnostics]: Color4WorkerDiagnostics[Key];
};
type DecodeMetadataRequest =
  | Color4WorkerDecodeRequest
  | Color4GeometryRequest
  | Color4ClassifyRequest;
type GeometryFrameRequest = Color4WorkerDecodeRequest | Color4GeometryRequest;
type WorkerVisionResult =
  | VisionResult
  | VisionTemporalAcquisitionResult
  | (Color4GeometrySnapshot & { readonly status: "valid" });
type CanonicalInput = CanonicalRasterImage | CanonicalModuleSamples;
type CanonicalDiagnosticResult = CanonicalRasterResult | CanonicalColor4GuardResult;

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<Color4WorkerRequest>) => void) | null;
  postMessage(message: Color4WorkerResponse, transfer?: Transferable[]): void;
};

let openCvPromise: Promise<OpenCvRuntime> | undefined;
let openCvInitMs = 0;

/**
 * Where this worker last located a frame, in source pixels.
 *
 * Thresholding and contour extraction are the bulk of cold acquisition and cost
 * whatever the searched area costs. Two devices held still put the code in the
 * same place frame after frame. The sole OpenCV geometry worker owns this state;
 * classifier workers never import OpenCV or retain temporal photometry. The
 * hint is dropped as soon as geometry or the structural guard proves it stale.
 */
let searchRegion: import("./color4-vision").VisionSearchRegion | undefined;
let previousTrackingGray: VisionGrayscaleFrame | undefined;
let temporalHint: VisionTemporalHint | undefined;
let compactSampler: Color4CompactSamplerWithOpenCv | undefined;

function clearTemporalTracking(): void {
  previousTrackingGray = undefined;
  temporalHint = undefined;
  // `searchRegion` deliberately survives. It answers "roughly where was the
  // code", which a failed track does not invalidate, and acquisition clears it
  // itself when it cannot find the code at all. Dropping it here made every
  // cold and fallback frame re-threshold the whole camera plane.
}

async function loadOpenCv(): Promise<OpenCvRuntime> {
  if (openCvPromise) return openCvPromise;
  const started = performance.now();
  openCvPromise = (async () => {
    const imported = (await import("@techstark/opencv-js")) as unknown as Record<string, unknown>;
    const candidate = (imported.default ?? imported) as
      | Record<string, unknown>
      | Promise<Record<string, unknown>>;
    const runtime: Record<string, unknown> = await Promise.resolve(candidate);
    if (runtime.Mat === undefined) {
      await new Promise<void>((resolve) => {
        runtime.onRuntimeInitialized = resolve;
      });
    }
    return runtime as unknown as OpenCvRuntime;
  })();
  try {
    return await openCvPromise;
  } finally {
    openCvInitMs = Math.max(0, performance.now() - started);
  }
}

function classifierStage(reason: string): RequiredStage {
  if (reason === "invalid_geometry" || reason === "invalid_dimensions") return "geometry";
  if (reason === "calibration_failed") return "calibration";
  if (
    reason === "invalid_bootstrap" ||
    reason === "unsupported_version" ||
    reason === "unsupported_profile" ||
    reason === "unsupported_palette" ||
    reason === "phase_mismatch"
  ) return "bootstrap";
  return "classification";
}

function actionableDiagnosticReason(
  raster: CanonicalDiagnosticResult | undefined,
  classifier: readonly CanonicalRasterObservation[],
  unwrap: readonly Color4UnwrapObservation[],
  rejectReason: string | undefined,
  saturatedErasureShards: readonly number[] = [],
): Color4DiagnosticReason | undefined {
  const fec = color4FecDiagnosticReason(
    rejectReason ?? "",
    unwrap,
    saturatedErasureShards,
  );
  if (fec !== undefined) return fec;
  const rejectedStage = classifier.find((observation) => observation.outcome === "rejected")?.stage;
  return canonicalDiagnosticReason(
    rejectReason ?? "",
    raster?.diagnostics,
    rejectedStage,
  );
}

export function color4FecDiagnosticReason(
  reason: string,
  unwrap: readonly Color4UnwrapObservation[],
  saturatedErasureShards: readonly number[] = [],
): Color4DiagnosticReason | undefined {
  const shardReasons = unwrap.flatMap((observation) =>
    observation.stage === "rs" ? observation.shards.map((shard) => shard.reason) : []
  );
  return fecDiagnosticReason(reason, shardReasons, saturatedErasureShards.length > 0);
}

export function color4ErasurePolicyDiagnostics(policy: Color4ErasurePolicyResult): Pick<
  Color4WorkerDiagnostics,
  | "erasurePolicy"
  | "selectedBudgetFraction"
  | "selectedMaxErasuresPerShard"
  | "selectedErasuresByShard"
  | "suggestedErasuresByShard"
  | "saturatedErasureShards"
  | "unwrapAttempts"
> {
  return Object.freeze({
    erasurePolicy: policy.selectedPolicy,
    selectedBudgetFraction: policy.selectedBudgetFraction,
    selectedMaxErasuresPerShard: policy.selectedMaxErasuresPerShard,
    selectedErasuresByShard: policy.attempts.find((attempt) =>
      attempt.policy === policy.selectedPolicy &&
      attempt.budgetFraction === policy.selectedBudgetFraction &&
      attempt.maxErasuresPerShard === policy.selectedMaxErasuresPerShard &&
      attempt.erasures.length === policy.selectedErasures.length &&
      attempt.erasures.every((index, position) => index === policy.selectedErasures[position])
    )?.erasuresByShard ?? Object.freeze([]),
    suggestedErasuresByShard: policy.suggestedErasuresByShard,
    saturatedErasureShards: policy.saturatedErasureShards,
    unwrapAttempts: Object.freeze(policy.attempts.map((attempt) => Object.freeze({
      policy: attempt.policy,
      budgetFraction: attempt.budgetFraction,
      maxErasuresPerShard: attempt.maxErasuresPerShard,
      erasures: attempt.erasures.length,
      erasuresByShard: attempt.erasuresByShard,
      ...(attempt.phaseMatched === undefined ? {} : { phaseMatched: attempt.phaseMatched }),
      durationMs: attempt.durationMs,
      status: attempt.result.status,
      ...(attempt.result.status === "rejected" ? { reason: attempt.result.reason } : {}),
    }))),
  });
}

function stageTimings(
  request: DecodeMetadataRequest,
  normalized: WorkerVisionResult | undefined,
  classifier: readonly CanonicalRasterObservation[],
  unwrap: readonly Color4UnwrapObservation[],
  workerTotal: number,
): Partial<Record<VisionTimingKey, number>> {
  const localWorkerTotal = workerTotal;
  const totalWorker = localWorkerTotal + (request.kind === "classify" ? request.geometryMs : 0);
  const timings: Partial<Record<VisionTimingKey, number>> = {
    capture: request.captureMs,
    workerTotal: totalWorker,
    ...(request.kind === "classify"
      ? {
          geometryTotal: request.geometryMs,
          tracking: request.trackingMs,
          sampling: request.samplingMs,
          guard: request.guardMs,
          classifier: localWorkerTotal,
        }
      : { geometryTotal: localWorkerTotal }),
  };
  if (normalized?.diagnostics) {
    const observed = normalized.diagnostics.timings;
    timings.grayscale = observed.grayscaleMs;
    timings.resize = observed.resizeMs;
    timings.threshold = observed.thresholdMs;
    timings.contours = observed.contoursMs;
    timings.fiducialDecode = observed.fiducialDecodeMs;
    timings.homography = observed.homographyMs;
    timings.refinement = observed.refinementMs;
  }
  for (const observation of classifier) {
    timings[observation.stage] = (timings[observation.stage] ?? 0) + observation.durationMs;
  }
  for (const observation of unwrap) {
    timings[observation.stage] = (timings[observation.stage] ?? 0) + observation.durationMs;
  }
  return timings;
}

export function canonicalVisionDiagnostics(
  diagnostics: CanonicalRasterResult["diagnostics"],
): NonNullable<BrowserVisionDiagnostics["canonical"]> {
  const bootstrap = diagnostics.bootstrapSampling;
  const rails = diagnostics.timingRails;
  const classificationCompleted = diagnostics.bestDeltaE.count > 0;
  return {
    fiducialErrors: diagnostics.fiducialErrors,
    fiducialErrorsById: diagnostics.fiducialErrorsById,
    fiducialErrorMax: diagnostics.fiducialErrorMax,
    quietZoneErrors: diagnostics.quietZoneErrors,
    quietZoneLumaErrors: diagnostics.quietZoneLumaErrors,
    quietZoneRgbErrors: diagnostics.quietZoneRgbErrors,
    timingErrors: diagnostics.timingErrors,
    timingModules: diagnostics.timingModules,
    ...(bootstrap === undefined
      ? {}
      : {
          bootstrapSampling: {
            doubleVoteColumns: bootstrap.doubleVoteColumns,
            singleVoteColumns: bootstrap.singleVoteColumns,
            uncertainColumns: bootstrap.uncertainColumns,
            contradictoryColumns: bootstrap.contradictoryColumns,
            minimumDifferentialLuma: bootstrap.minimumDifferentialLuma,
            medianDifferentialLuma: bootstrap.medianDifferentialLuma,
          },
        }),
    ...(rails === undefined
      ? {}
      : {
          timingUncertainModules: diagnostics.timingUncertainModules,
          timingRails: {
            top: { ...rails.top },
            right: { ...rails.right },
            bottom: { ...rails.bottom },
            left: { ...rails.left },
          },
        }),
    calibrationMad: diagnostics.calibrationMad,
    observedContrast: diagnostics.observedContrast,
    minimumPaletteDistance: diagnostics.minimumPaletteDistance,
    uncertainCells: diagnostics.uncertainCells,
    erasureBytes: diagnostics.erasureBytes,
    ...(classificationCompleted
      ? {
          distanceRejectedCells: diagnostics.distanceRejectedCells,
          gapRejectedCells: diagnostics.gapRejectedCells,
          bothRejectedCells: diagnostics.bothRejectedCells,
          erasuresByShard: [...diagnostics.erasuresByShard],
          parityByShard: diagnostics.parityByShard,
          remainingErasureBudgetByShard: [...diagnostics.remainingErasureBudgetByShard],
          uncertainCellsByRow: [...diagnostics.uncertainCellsByRow],
          uncertainCellsByColumn: [...diagnostics.uncertainCellsByColumn],
          effectiveMaximumDeltaE: diagnostics.effectiveMaximumDeltaE,
          effectiveMinimumDeltaEGap: diagnostics.effectiveMinimumDeltaEGap,
          bestDeltaE: { ...diagnostics.bestDeltaE },
          deltaEGap: { ...diagnostics.deltaEGap },
          erasureCandidateScore: { ...diagnostics.erasureCandidateScore },
        }
      : {}),
    meanBestDeltaE: diagnostics.meanBestDeltaE,
    maximumBestDeltaE: diagnostics.maximumBestDeltaE,
  };
}

function visionDiagnostics(
  request: DecodeMetadataRequest,
  normalized: WorkerVisionResult | undefined,
  raster: CanonicalDiagnosticResult | undefined,
  classifier: readonly CanonicalRasterObservation[],
  unwrap: readonly Color4UnwrapObservation[],
  workerTotal: number,
  rejectReason?: string,
  diagnosticUnwrap: readonly Color4UnwrapObservation[] = unwrap,
  saturatedErasureShards: readonly number[] = [],
): BrowserVisionDiagnostics {
  const geometry = normalized?.diagnostics;
  const fiducials = geometry?.fiducials;
  // Only the geometry worker's tracked snapshot carries this; the legacy and
  // acquisition results in this union never do.
  const tracking = normalized !== undefined && "tracking" in normalized
    ? normalized.tracking
    : undefined;
  const diagnosticReason = actionableDiagnosticReason(
    raster,
    classifier,
    diagnosticUnwrap,
    rejectReason,
    saturatedErasureShards,
  );
  return {
    debugEnabled: request.debug.enabled,
    canonicalScale: request.debug.canonicalScale,
    detectionDimension: request.debug.maxDetectionDimension,
    ...(rejectReason === undefined ? {} : { rejectReason }),
    ...(diagnosticReason === undefined ? {} : { diagnosticReason }),
    timings: stageTimings(request, normalized, classifier, unwrap, workerTotal),
    ...(tracking === undefined ? {} : { tracking }),
    ...(geometry === undefined
      ? {}
      : {
          detection: {
            inputWidth: geometry.config.sourceWidth,
            inputHeight: geometry.config.sourceHeight,
            detectionWidth: geometry.config.detectionWidth,
            detectionHeight: geometry.config.detectionHeight,
            resizeScale: geometry.config.detectionScale,
            adaptiveBlockSize: geometry.config.adaptiveBlockSize,
            adaptiveConstant: geometry.config.adaptiveConstant,
            thresholdPasses: geometry.config.thresholdPasses,
            minimumAreaFraction: geometry.config.minimumAreaFraction,
            maximumAreaFraction: geometry.config.maximumAreaFraction,
            polygonEpsilonFraction: geometry.config.polygonEpsilonFraction,
            maximumContoursPerPass: geometry.config.maximumContoursPerPass,
            maximumQuadProposals: geometry.config.maximumQuadProposals,
            maximumFiducialErrors: geometry.config.maximumFiducialErrors,
            contours: geometry.counters.contoursTotal,
            areaTooSmall: geometry.counters.areaTooSmall,
            areaTooLarge: geometry.counters.areaTooLarge,
            nonQuads: geometry.counters.nonQuad,
            nonConvex: geometry.counters.nonConvex,
            quads: geometry.counters.quads,
            mergedCandidates: geometry.counters.mergedCandidates,
            candidateCountRaw: geometry.counters.candidateCountRaw,
            candidateCountRanked: geometry.counters.candidateCountRanked,
            decodedMarkers: geometry.counters.decoded,
            lowContrastCandidates: geometry.counters.lowContrast,
            uniqueFiducials: Object.keys(geometry.fiducials).length,
            duplicateIds: geometry.counters.duplicateIds,
            ambiguousCandidates: geometry.counters.ambiguous,
            tooManyErrorCandidates: geometry.counters.tooManyErrors,
            decodeFailures: geometry.counters.decodeFailures,
          },
          fiducials: {
            TL: { found: fiducials?.TL !== undefined, errors: fiducials?.TL?.errors },
            TR: { found: fiducials?.TR !== undefined, errors: fiducials?.TR?.errors },
            BR: { found: fiducials?.BR !== undefined, errors: fiducials?.BR?.errors },
            BL: { found: fiducials?.BL !== undefined, errors: fiducials?.BL?.errors },
          },
          warnings: geometry.warnings,
          ...(geometry.optical === undefined ? {} : { optical: geometry.optical }),
          homography: geometry.homography,
        }),
    ...(raster === undefined
      ? {}
      : {
          canonical: canonicalVisionDiagnostics(raster.diagnostics),
        }),
  };
}

function baseDiagnostics(
  request: DecodeMetadataRequest,
  raster: CanonicalDiagnosticResult | undefined,
  normalized: WorkerVisionResult | undefined,
  classifier: readonly CanonicalRasterObservation[],
  unwrap: readonly Color4UnwrapObservation[],
  started: number,
  rejectReason?: string,
  diagnosticUnwrap: readonly Color4UnwrapObservation[] = unwrap,
  saturatedErasureShards: readonly number[] = [],
): MutableDiagnostics {
  const localElapsed = Math.max(0, performance.now() - started);
  const elapsed = localElapsed + (request.kind === "classify" ? request.geometryMs : 0);
  return {
    profile: raster?.status === "valid" ? raster.profile.name : undefined,
    stage: raster?.status === "rejected" ? classifierStage(raster.reason) : "wire",
    candidates: normalized?.candidates ?? 0,
    uncertainCells: raster?.diagnostics.uncertainCells ?? 0,
    erasureBytes: raster?.diagnostics.erasureBytes ?? 0,
    rsCorrectedSymbols: 0,
    rsFailures: 0,
    crcFailures: 0,
    decodeMs: elapsed,
    ...(rejectReason === undefined ? {} : { rejectReason }),
    // No erasures have been consumed until an unwrap attempt is selected.
    // Successful classification overwrites this with that attempt's decoder
    // diagnostics; erasureBytes above always retains the optical hint count.
    erasures: 0,
    correctedErrors: 0,
    correctedBytes: 0,
    correctedShards: 0,
    vision: visionDiagnostics(
      request,
      normalized,
      raster,
      classifier,
      unwrap,
      localElapsed,
      rejectReason,
      diagnosticUnwrap,
      saturatedErasureShards,
    ),
  };
}

function updateReject(
  diagnostics: MutableDiagnostics,
  stage: RequiredStage,
  reason: string,
  diagnosticReason?: Color4DiagnosticReason,
): void {
  diagnostics.stage = stage;
  diagnostics.rejectReason = reason;
  diagnostics.vision = {
    ...diagnostics.vision,
    rejectReason: reason,
    ...(diagnosticReason === undefined ? {} : { diagnosticReason }),
  };
}

function debugFrame(
  request: DecodeMetadataRequest,
  normalized: WorkerVisionResult | undefined,
  raster: CanonicalDiagnosticResult | undefined,
  classifier: readonly CanonicalRasterObservation[],
  unwrap: readonly Color4UnwrapObservation[],
): Color4WorkerDebugFrame | undefined {
  if (!normalized?.debug) return undefined;
  const observedProfileId = raster?.status === "valid"
    ? raster.profile.id
    : classifier.find((observation) => observation.stage === "bootstrapPhase")?.bootstrap?.profileId;
  const profileId = observedProfileId === 1 || observedProfileId === 2
    ? observedProfileId
    : undefined;
  return {
    frameId: request.id,
    capturedAt: request.capturedAt,
    generation: request.debug.generation,
    view: request.debug.view,
    maxDetectionDimension: request.debug.maxDetectionDimension,
    paletteId: request.paletteId,
    planeRequested: request.debug.emitPlane,
    snapshot: request.debug.snapshot,
    ...(profileId === undefined ? {} : { profileId }),
    artifacts: normalized.debug,
    classifier,
    unwrap,
  };
}

function transferables(
  debug: Color4WorkerDebugFrame | undefined,
  innerFrame?: ArrayBuffer,
): Transferable[] {
  const values = new Set<ArrayBuffer>();
  if (innerFrame) values.add(innerFrame);
  if (debug) {
    for (const plane of Object.values(debug.artifacts.planes)) {
      if (plane?.pixels.buffer instanceof ArrayBuffer) values.add(plane.pixels.buffer);
    }
  }
  return [...values];
}

function postRejected(
  request: DecodeMetadataRequest,
  reason: RejectReason,
  diagnostics: MutableDiagnostics,
  debug: Color4WorkerDebugFrame | undefined,
): void {
  scope.postMessage(
    {
      kind: "result",
      id: request.id,
      status: "rejected",
      reason,
      diagnostics,
      ...(request.kind === "classify"
        ? {
            captureSequence: request.captureSequence,
            trackingGeneration: request.trackingGeneration,
            classifierSlot: request.classifierSlot,
            geometryPath: request.geometryPath,
          }
        : {}),
      ...(debug ? { debug } : {}),
    },
    transferables(debug),
  );
}

/**
 * Reused between frames: allocating an OffscreenCanvas per capture would give
 * back most of what the bitmap path saves.
 */
let bitmapCanvas: OffscreenCanvas | undefined;
let bitmapContext: OffscreenCanvasRenderingContext2D | undefined;

function pixelsFromRequest(request: GeometryFrameRequest): Uint8ClampedArray {
  if (request.source.kind === "rgba") return new Uint8ClampedArray(request.source.rgba);
  const { bitmap } = request.source;
  try {
    if (
      bitmapCanvas === undefined ||
      bitmapCanvas.width !== request.width ||
      bitmapCanvas.height !== request.height
    ) {
      bitmapCanvas = new OffscreenCanvas(request.width, request.height);
      bitmapContext = bitmapCanvas.getContext("2d", { willReadFrequently: true }) ?? undefined;
    }
    if (!bitmapContext) throw new Error("This worker cannot open a 2D OffscreenCanvas context.");
    bitmapContext.drawImage(bitmap, 0, 0);
    return bitmapContext.getImageData(0, 0, request.width, request.height).data;
  } finally {
    // The bitmap was transferred here, so this worker owns its release.
    bitmap.close();
  }
}

async function decode(
  request: Color4WorkerDecodeRequest | Color4ClassifyRequest,
): Promise<void> {
  const started = performance.now();
  const classifierObservations: CanonicalRasterObservation[] = [];
  const unwrapObservations: Color4UnwrapObservation[] = [];
  let normalized: WorkerVisionResult | undefined;
  let raster: CanonicalRasterResult | undefined;
  const observerDetail = request.debug.snapshot ||
    (request.debug.emitPlane && request.debug.view === "calibration");
  try {
    let canonical: CanonicalInput;
    if (request.kind === "decode") {
      // Inside the try: a canvas that refuses a 2D context is a rejected frame,
      // not a dead worker that tears the whole receiver down.
      const pixels = pixelsFromRequest(request);
      // The compatibility request remains self-contained for tests and callers
      // that have not adopted the split geometry/classifier protocol.
      const cv = await loadOpenCv();
      const acquired = normalizeColor4WithOpenCv(cv, request.width, request.height, pixels, {
        canonicalScale: request.debug.canonicalScale,
        maxDetectionDimension: request.debug.maxDetectionDimension,
        debug: request.debug.enabled,
        snapshot: request.debug.snapshot,
        ...(request.debug.emitPlane ? { debugView: request.debug.view } : {}),
        ...(searchRegion === undefined ? {} : { searchRegion }),
      });
      normalized = acquired;
      searchRegion = normalized.status === "valid" ? normalized.frameRegion : undefined;
      if (acquired.status === "rejected") {
        const diagnostics = baseDiagnostics(
          request,
          undefined,
          normalized,
          classifierObservations,
          unwrapObservations,
          started,
          acquired.reason,
        );
        updateReject(diagnostics, "geometry", acquired.reason);
        postRejected(
          request,
          "invalid-inner-frame",
          diagnostics,
          debugFrame(request, normalized, undefined, classifierObservations, unwrapObservations),
        );
        return;
      }
      canonical = acquired.image;
    } else {
      normalized = { status: "valid", ...request.geometry };
      canonical = request.canonical.kind === "samples"
        ? {
            width: request.canonical.width,
            height: request.canonical.height,
            rgb: new Float32Array(request.canonical.rgb),
          }
        : {
            width: request.canonical.width,
            height: request.canonical.height,
            pixels: new Uint8ClampedArray(request.canonical.rgba),
          };
    }
    raster = "rgb" in canonical
      ? decodeCanonicalColor4Samples(canonical, {
          observer: (observation) => classifierObservations.push(observation),
          observerDetail,
        })
      : decodeCanonicalColor4Raster(canonical, {
      observer: (observation) => classifierObservations.push(observation),
      observerDetail,
        });
    if (raster.status === "rejected") {
      const diagnostics = baseDiagnostics(
        request,
        raster,
        normalized,
        classifierObservations,
        unwrapObservations,
        started,
        raster.reason,
      );
      updateReject(diagnostics, classifierStage(raster.reason), raster.reason);
      postRejected(
        request,
        "invalid-inner-frame",
        diagnostics,
        debugFrame(request, normalized, raster, classifierObservations, unwrapObservations),
      );
      return;
    }
    if (raster.paletteId !== request.paletteId) {
      const diagnostics = baseDiagnostics(
        request,
        raster,
        normalized,
        classifierObservations,
        unwrapObservations,
        started,
        "palette-selection-mismatch",
      );
      updateReject(diagnostics, "bootstrap", "palette-selection-mismatch", "BOOTSTRAP");
      postRejected(
        request,
        "unsupported-palette",
        diagnostics,
        debugFrame(request, normalized, raster, classifierObservations, unwrapObservations),
      );
      return;
    }
    const erasurePolicy = runColor4ErasurePolicy({
      codedBytes: raster.codedBytes,
      profile: raster.profile,
      paletteId: raster.paletteId,
      erasureCandidates: raster.byteErasureCandidates,
      expectedSequencePhase: raster.sequencePhase,
    });
    for (const attempt of erasurePolicy.attempts) {
      unwrapObservations.push(...attempt.observations);
    }
    const unwrapped = erasurePolicy.result;
    const diagnostics = baseDiagnostics(
      request,
      raster,
      normalized,
      classifierObservations,
      unwrapObservations,
      started,
      unwrapped.status === "rejected" ? unwrapped.reason : undefined,
      erasurePolicy.selectedObservations,
      erasurePolicy.saturatedErasureShards,
    );
    diagnostics.erasures = unwrapped.diagnostics.erasures;
    diagnostics.erasureBytes = raster.diagnostics.erasureBytes;
    diagnostics.correctedErrors = unwrapped.diagnostics.correctedErrors;
    diagnostics.correctedBytes = unwrapped.diagnostics.correctedBytes;
    diagnostics.correctedShards = unwrapped.diagnostics.correctedShards;
    diagnostics.rsCorrectedSymbols = unwrapped.diagnostics.correctedBytes;
    diagnostics.profile = raster.profile.name;
    Object.assign(diagnostics, color4ErasurePolicyDiagnostics(erasurePolicy));
    if (unwrapped.status === "rejected") {
      if (unwrapped.reason === "fec-uncorrectable") {
        updateReject(
          diagnostics,
          "rs",
          unwrapped.reason,
          actionableDiagnosticReason(
            raster,
            classifierObservations,
            erasurePolicy.selectedObservations,
            unwrapped.reason,
            erasurePolicy.saturatedErasureShards,
          ),
        );
        diagnostics.rsFailures = 1;
      } else if (unwrapped.reason === "crc-mismatch") {
        updateReject(diagnostics, "crc", unwrapped.reason, "CRC_FAILED");
        diagnostics.crcFailures = 1;
      } else {
        // A structural rejection after FEC "succeeded" is the signature of a
        // saturated erasure budget: the shards were solved against more damage
        // than they could locate. Attribute it rather than reporting the bare
        // wire reason with no cause.
        updateReject(
          diagnostics,
          "wire",
          unwrapped.reason,
          actionableDiagnosticReason(
            raster,
            classifierObservations,
            erasurePolicy.selectedObservations,
            unwrapped.reason,
            erasurePolicy.saturatedErasureShards,
          ),
        );
      }
      postRejected(
        request,
        unwrapped.reason,
        diagnostics,
        debugFrame(request, normalized, raster, classifierObservations, unwrapObservations),
      );
      return;
    }
    if (!color4SequencePhaseMatches(unwrapped.header.sequence, raster.sequencePhase)) {
      updateReject(diagnostics, "bootstrap", "sequence-phase-mismatch", "PHASE");
      postRejected(
        request,
        "identity-mismatch",
        diagnostics,
        debugFrame(request, normalized, raster, classifierObservations, unwrapObservations),
      );
      return;
    }
    const innerFrame = Uint8Array.from(unwrapped.innerFrame);
    const debug = debugFrame(request, normalized, raster, classifierObservations, unwrapObservations);
    scope.postMessage(
      {
        kind: "result",
        id: request.id,
        status: "valid",
        innerFrame: innerFrame.buffer,
        diagnostics,
        ...(request.kind === "classify"
          ? {
              captureSequence: request.captureSequence,
              trackingGeneration: request.trackingGeneration,
              classifierSlot: request.classifierSlot,
              geometryPath: request.geometryPath,
            }
          : {}),
        ...(debug ? { debug } : {}),
      },
      transferables(debug, innerFrame.buffer),
    );
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const diagnostics = baseDiagnostics(
      request,
      raster,
      normalized,
      classifierObservations,
      unwrapObservations,
      started,
      reason,
    );
    updateReject(diagnostics, "wire", reason);
    postRejected(
      request,
      "invalid-inner-frame",
      diagnostics,
      debugFrame(request, normalized, raster, classifierObservations, unwrapObservations),
    );
  }
}

let activeTrackingGeneration = 0;

function geometryTransferables(
  canonical: ArrayBuffer | undefined,
  debug: Color4WorkerDebugFrame | undefined,
): Transferable[] {
  return transferables(debug, canonical);
}

function addGeometryPipelineTimings(
  diagnostics: MutableDiagnostics,
  trackingMs: number,
  samplingMs: number,
  guardMs: number,
): void {
  if (!diagnostics.vision) return;
  diagnostics.vision = {
    ...diagnostics.vision,
    timings: {
      ...diagnostics.vision.timings,
      tracking: trackingMs,
      sampling: samplingMs,
      guard: guardMs,
    },
  };
}

function postGeometryGuardRejection(
  request: Color4GeometryRequest,
  normalized: WorkerVisionResult,
  guard: Exclude<CanonicalColor4GuardResult, { readonly status: "valid" }>,
  geometryPath: "cold" | "tracked" | "fallback" | "legacy",
  started: number,
  classifier: readonly CanonicalRasterObservation[],
  unwrap: readonly Color4UnwrapObservation[],
  trackingMs: number,
  samplingMs: number,
  guardMs: number,
): void {
  const diagnostics = baseDiagnostics(
    request,
    guard,
    normalized,
    classifier,
    unwrap,
    started,
    guard.reason,
  );
  updateReject(diagnostics, classifierStage(guard.reason), guard.reason);
  addGeometryPipelineTimings(diagnostics, trackingMs, samplingMs, guardMs);
  const debug = debugFrame(request, normalized, guard, classifier, unwrap);
  scope.postMessage(
    {
      kind: "geometry-result",
      id: request.id,
      captureSequence: request.captureSequence,
      trackingGeneration: request.trackingGeneration,
      classifierSlot: request.classifierSlot,
      status: "rejected",
      geometryPath,
      reason: "invalid-inner-frame",
      diagnostics,
      ...(debug ? { debug } : {}),
    },
    geometryTransferables(undefined, debug),
  );
}

/**
 * Own all OpenCV state in one temporal worker and hand only canonical data to
 * the lightweight pool.  A failed hinted acquisition is retried over the full
 * frame before this capture is rejected, so a camera jump does not cost an
 * additional video-frame interval.
 */
async function runGeometry(request: Color4GeometryRequest): Promise<void> {
  const started = performance.now();
  const classifierObservations: CanonicalRasterObservation[] = [];
  const unwrapObservations: Color4UnwrapObservation[] = [];
  let normalized: VisionResult | VisionTemporalAcquisitionResult | undefined;
  let geometryPath: "cold" | "tracked" | "fallback" | "legacy" = "cold";
  let trackingMs = 0;
  let samplingMs = 0;
  let guardMs = 0;
  try {
    if (request.trackingGeneration !== activeTrackingGeneration) {
      activeTrackingGeneration = request.trackingGeneration;
      clearTemporalTracking();
    }
    const pixels = pixelsFromRequest(request);
    const cv = await loadOpenCv();
    compactSampler ??= new Color4CompactSamplerWithOpenCv(cv);
    const forceLegacy = request.mode === "legacy" || request.debug.enabled ||
      request.debug.snapshot || !supportsCompactColor4Sampling(request.debug.canonicalScale);
    let currentGray: VisionGrayscaleFrame | undefined;

    if (
      !forceLegacy &&
      previousTrackingGray !== undefined &&
      temporalHint !== undefined
    ) {
      const trackingStarted = performance.now();
      currentGray = createVisionGrayscaleFrameWithOpenCv(
        cv,
        request.width,
        request.height,
        pixels,
      );
      const tracked = trackVisionTemporalHintWithOpenCv(
        cv,
        previousTrackingGray,
        currentGray,
        temporalHint,
      );
      trackingMs = Math.max(0, performance.now() - trackingStarted);
      if (tracked.status === "tracked") {
        const samplingStarted = performance.now();
        const samples = compactSampler.sample(request.width, request.height, pixels, tracked.hint);
        samplingMs = Math.max(0, performance.now() - samplingStarted);
        const guardStarted = performance.now();
        const guard = guardCanonicalColor4Samples(samples, {
          observer: (observation) => classifierObservations.push(observation),
        });
        guardMs += Math.max(0, performance.now() - guardStarted);
        geometryPath = "tracked";
        const geometryMs = Math.max(0, performance.now() - started);
        // No contour, fiducial or optical measurement exists for a tracked
        // frame, so none is reported. The LK gates that accepted this geometry
        // are the real evidence and travel in their place.
        const geometry: Color4GeometrySnapshot = {
          candidates: 0,
          tracking: tracked.diagnostics,
          ...(tracked.hint.frameRegion ? { frameRegion: tracked.hint.frameRegion } : {}),
        };
        if (guard.status === "valid") {
          previousTrackingGray = currentGray;
          temporalHint = tracked.hint;
          searchRegion = tracked.hint.frameRegion;
          const rgb = samples.rgb.buffer;
          scope.postMessage(
            {
              kind: "geometry-result",
              id: request.id,
              captureSequence: request.captureSequence,
              trackingGeneration: request.trackingGeneration,
              classifierSlot: request.classifierSlot,
              status: "valid",
              geometryPath,
              geometryMs,
              trackingMs,
              samplingMs,
              guardMs,
              geometry,
              canonical: {
                kind: "samples",
                width: samples.width,
                height: samples.height,
                rgb,
              },
            },
            [rgb],
          );
          return;
        }
        if (guard.status === "transition") {
          // A mixed display refresh is not evidence that geometry moved. Keep
          // the last stable gray/homography and simply wait for a new capture.
          postGeometryGuardRejection(
            request,
            { status: "valid", ...geometry },
            guard,
            geometryPath,
            started,
            classifierObservations,
            unwrapObservations,
            trackingMs,
            samplingMs,
            guardMs,
          );
          return;
        }
        // Structural failure may be a bad tracked homography even when LK's
        // geometric gates passed. Reacquire once over these exact same pixels.
        geometryPath = "fallback";
        clearTemporalTracking();
      } else {
        // A failed gate never leaks a doubtful homography. Acquire over the full
        // same camera frame and replace all temporal state below.
        geometryPath = "fallback";
        clearTemporalTracking();
      }
    }

    const previousRegion = searchRegion;
    const options = {
      canonicalScale: request.debug.canonicalScale,
      maxDetectionDimension: request.debug.maxDetectionDimension,
      debug: request.debug.enabled,
      snapshot: request.debug.snapshot,
      temporalGeneration: request.trackingGeneration,
      ...(request.debug.emitPlane ? { debugView: request.debug.view } : {}),
    } as const;
    if (forceLegacy) geometryPath = "legacy";
    else if (geometryPath !== "fallback") geometryPath = "cold";
    normalized = forceLegacy
      ? normalizeColor4WithOpenCv(cv, request.width, request.height, pixels, {
          ...options,
          ...(previousRegion === undefined ? {} : { searchRegion: previousRegion }),
        })
      : acquireColor4TemporalGeometryWithOpenCv(
          cv,
          request.width,
          request.height,
          pixels,
          {
            ...options,
            ...(previousRegion === undefined ? {} : { searchRegion: previousRegion }),
          },
        );
    if (forceLegacy && previousRegion !== undefined && normalized.status === "rejected") {
      geometryPath = "fallback";
      normalized = normalizeColor4WithOpenCv(cv, request.width, request.height, pixels, options);
    }
    searchRegion = normalized.status === "valid" ? normalized.frameRegion : undefined;
    if (normalized.status === "rejected") {
      clearTemporalTracking();
      const diagnostics = baseDiagnostics(
        request,
        undefined,
        normalized,
        classifierObservations,
        unwrapObservations,
        started,
        normalized.reason,
      );
      updateReject(diagnostics, "geometry", normalized.reason);
      addGeometryPipelineTimings(diagnostics, trackingMs, samplingMs, guardMs);
      const debug = debugFrame(
        request,
        normalized,
        undefined,
        classifierObservations,
        unwrapObservations,
      );
      scope.postMessage(
        {
          kind: "geometry-result",
          id: request.id,
          captureSequence: request.captureSequence,
          trackingGeneration: request.trackingGeneration,
          classifierSlot: request.classifierSlot,
          status: "rejected",
          geometryPath,
          reason: "invalid-inner-frame",
          diagnostics,
          ...(debug ? { debug } : {}),
        },
        geometryTransferables(undefined, debug),
      );
      return;
    }

    const geometry: Color4GeometrySnapshot = {
      candidates: normalized.candidates,
      diagnostics: normalized.diagnostics,
      ...(normalized.frameRegion ? { frameRegion: normalized.frameRegion } : {}),
      ...(normalized.debug ? { debug: normalized.debug } : {}),
    };
    let canonical:
      | { kind: "samples"; width: number; height: number; rgb: ArrayBuffer }
      | { kind: "raster"; width: number; height: number; rgba: ArrayBuffer };
    let canonicalBuffer: ArrayBuffer;
    const acquiredTemporalHint = normalized.temporalHint;
    if (!forceLegacy && acquiredTemporalHint !== undefined) {
      const samplingStarted = performance.now();
      const samples = compactSampler.sample(
        request.width,
        request.height,
        pixels,
        acquiredTemporalHint,
      );
      samplingMs = Math.max(0, performance.now() - samplingStarted);
      const guardStarted = performance.now();
      const guard = guardCanonicalColor4Samples(samples, {
        observer: (observation) => classifierObservations.push(observation),
      });
      guardMs += Math.max(0, performance.now() - guardStarted);
      if (guard.status !== "valid") {
        if (guard.status === "rejected") clearTemporalTracking();
        postGeometryGuardRejection(
          request,
          normalized,
          guard,
          geometryPath,
          started,
          classifierObservations,
          unwrapObservations,
          trackingMs,
          samplingMs,
          guardMs,
        );
        return;
      }
      canonicalBuffer = samples.rgb.buffer;
      canonical = {
        kind: "samples",
        width: samples.width,
        height: samples.height,
        rgb: canonicalBuffer,
      };
    } else {
      if (!("image" in normalized)) {
        throw new Error("Legacy COLOR_4 acquisition did not produce a canonical raster.");
      }
      canonicalBuffer = Uint8ClampedArray.from(normalized.image.pixels).buffer;
      canonical = {
        kind: "raster",
        width: normalized.image.width,
        height: normalized.image.height,
        rgba: canonicalBuffer,
      };
    }
    temporalHint = acquiredTemporalHint;
    if (!forceLegacy && temporalHint !== undefined) {
      previousTrackingGray = currentGray ?? createVisionGrayscaleFrameWithOpenCv(
        cv,
        request.width,
        request.height,
        pixels,
      );
    } else if (forceLegacy) {
      previousTrackingGray = undefined;
      temporalHint = undefined;
    }
    const geometryMs = Math.max(0, performance.now() - started);
    scope.postMessage(
      {
        kind: "geometry-result",
        id: request.id,
        captureSequence: request.captureSequence,
        trackingGeneration: request.trackingGeneration,
        classifierSlot: request.classifierSlot,
        status: "valid",
        geometryPath,
        geometryMs,
        trackingMs,
        samplingMs,
        guardMs,
        geometry,
        canonical,
      },
      geometryTransferables(canonicalBuffer, normalized.debug
        ? debugFrame(request, normalized, undefined, classifierObservations, unwrapObservations)
        : undefined),
    );
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    clearTemporalTracking();
    const diagnostics = baseDiagnostics(
      request,
      undefined,
      normalized,
      classifierObservations,
      unwrapObservations,
      started,
      reason,
    );
    updateReject(diagnostics, "geometry", reason);
    addGeometryPipelineTimings(diagnostics, trackingMs, samplingMs, guardMs);
    const debug = debugFrame(
      request,
      normalized,
      undefined,
      classifierObservations,
      unwrapObservations,
    );
    scope.postMessage(
      {
        kind: "geometry-result",
        id: request.id,
        captureSequence: request.captureSequence,
        trackingGeneration: request.trackingGeneration,
        classifierSlot: request.classifierSlot,
        status: "rejected",
        geometryPath,
        reason: "invalid-inner-frame",
        diagnostics,
        ...(debug ? { debug } : {}),
      },
      geometryTransferables(undefined, debug),
    );
  }
}

scope.onmessage = (event) => {
  if (event.data.kind === "init") {
    const { id, role = "combined" } = event.data;
    if (role === "classifier") {
      scope.postMessage({ kind: "ready", id, role, opencvInitMs: 0 });
      return;
    }
    void loadOpenCv().then(
      () => scope.postMessage({ kind: "ready", id, role, opencvInitMs: openCvInitMs }),
      (error) => {
        throw error;
      },
    );
    return;
  }
  if (event.data.kind === "geometry") {
    void runGeometry(event.data);
    return;
  }
  void decode(event.data);
};
