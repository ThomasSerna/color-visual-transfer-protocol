import {
  decodeCanonicalColor4Raster,
  type CanonicalRasterObservation,
  type CanonicalRasterResult,
  type RejectReason,
  type Color4UnwrapObservation,
} from "../shared/color4";
import type {
  BrowserCarrierDiagnostics,
  BrowserVisionDiagnostics,
  Color4DiagnosticReason,
  VisionTimingKey,
} from "../shared/carrier";
import {
  normalizeColor4WithOpenCv,
  type OpenCvRuntime,
  type VisionResult,
} from "./color4-vision";
import { color4SequencePhaseMatches } from "./color4-binding";
import { canonicalDiagnosticReason, fecDiagnosticReason } from "./color4-diagnostic-reason";
import {
  runColor4ErasurePolicy,
  type Color4ErasurePolicyResult,
} from "./color4-erasure-policy";
import type {
  Color4WorkerDebugFrame,
  Color4WorkerDecodeRequest,
  Color4WorkerDiagnostics,
  Color4WorkerRequest,
  Color4WorkerResponse,
} from "./color4-worker-protocol";

type RequiredStage = Exclude<BrowserCarrierDiagnostics["stage"], undefined>;
type MutableDiagnostics = {
  -readonly [Key in keyof Color4WorkerDiagnostics]: Color4WorkerDiagnostics[Key];
};

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
 * same place frame after frame, so remembering it turns most frames into a
 * search over a fraction of the pixels. The hint is dropped as soon as a frame
 * fails to locate the code — the scene has changed, and the next frame should
 * look everywhere. Each worker in the pool keeps its own hint and converges
 * independently.
 */
let searchRegion: import("./color4-vision").VisionSearchRegion | undefined;

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
  raster: CanonicalRasterResult | undefined,
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
  request: Color4WorkerDecodeRequest,
  normalized: VisionResult | undefined,
  classifier: readonly CanonicalRasterObservation[],
  unwrap: readonly Color4UnwrapObservation[],
  workerTotal: number,
): Partial<Record<VisionTimingKey, number>> {
  const timings: Partial<Record<VisionTimingKey, number>> = {
    capture: request.captureMs,
    workerTotal,
  };
  if (normalized) {
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
  request: Color4WorkerDecodeRequest,
  normalized: VisionResult | undefined,
  raster: CanonicalRasterResult | undefined,
  classifier: readonly CanonicalRasterObservation[],
  unwrap: readonly Color4UnwrapObservation[],
  workerTotal: number,
  rejectReason?: string,
  diagnosticUnwrap: readonly Color4UnwrapObservation[] = unwrap,
  saturatedErasureShards: readonly number[] = [],
): BrowserVisionDiagnostics {
  const geometry = normalized?.diagnostics;
  const fiducials = geometry?.fiducials;
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
  request: Color4WorkerDecodeRequest,
  raster: CanonicalRasterResult | undefined,
  normalized: VisionResult | undefined,
  classifier: readonly CanonicalRasterObservation[],
  unwrap: readonly Color4UnwrapObservation[],
  started: number,
  rejectReason?: string,
  diagnosticUnwrap: readonly Color4UnwrapObservation[] = unwrap,
  saturatedErasureShards: readonly number[] = [],
): MutableDiagnostics {
  const elapsed = Math.max(0, performance.now() - started);
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
      elapsed,
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
  request: Color4WorkerDecodeRequest,
  normalized: VisionResult | undefined,
  raster: CanonicalRasterResult | undefined,
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
  request: Color4WorkerDecodeRequest,
  reason: RejectReason,
  diagnostics: MutableDiagnostics,
  debug: Color4WorkerDebugFrame | undefined,
): void {
  scope.postMessage(
    { kind: "result", id: request.id, status: "rejected", reason, diagnostics, ...(debug ? { debug } : {}) },
    transferables(debug),
  );
}

/**
 * Reused between frames: allocating an OffscreenCanvas per capture would give
 * back most of what the bitmap path saves.
 */
let bitmapCanvas: OffscreenCanvas | undefined;
let bitmapContext: OffscreenCanvasRenderingContext2D | undefined;

function pixelsFromRequest(request: Color4WorkerDecodeRequest): Uint8ClampedArray {
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

async function decode(request: Color4WorkerDecodeRequest): Promise<void> {
  const started = performance.now();
  const classifierObservations: CanonicalRasterObservation[] = [];
  const unwrapObservations: Color4UnwrapObservation[] = [];
  let normalized: VisionResult | undefined;
  let raster: CanonicalRasterResult | undefined;
  const observerDetail = request.debug.snapshot ||
    (request.debug.emitPlane && request.debug.view === "calibration");
  try {
    // Inside the try: a canvas that refuses a 2D context is a rejected frame,
    // not a dead worker that tears the whole receiver down.
    const pixels = pixelsFromRequest(request);
    // Camera input always traverses geometry. Inferring a canonical fixture
    // from square dimensions could bypass homography on a legitimate square
    // camera mode whose width happened to be a multiple of 172.
    const cv = await loadOpenCv();
    normalized = normalizeColor4WithOpenCv(cv, request.width, request.height, pixels, {
      canonicalScale: request.debug.canonicalScale,
      maxDetectionDimension: request.debug.maxDetectionDimension,
      debug: request.debug.enabled,
      snapshot: request.debug.snapshot,
      ...(request.debug.emitPlane ? { debugView: request.debug.view } : {}),
      ...(searchRegion === undefined ? {} : { searchRegion }),
    });
    searchRegion = normalized.status === "valid" ? normalized.frameRegion : undefined;
    if (normalized.status === "rejected") {
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
      postRejected(
        request,
        "invalid-inner-frame",
        diagnostics,
        debugFrame(request, normalized, undefined, classifierObservations, unwrapObservations),
      );
      return;
    }
    raster = decodeCanonicalColor4Raster(normalized.image, {
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

scope.onmessage = (event) => {
  if (event.data.kind === "init") {
    const { id } = event.data;
    void loadOpenCv().then(
      () => scope.postMessage({ kind: "ready", id, opencvInitMs: openCvInitMs }),
      (error) => {
        throw error;
      },
    );
    return;
  }
  void decode(event.data);
};
