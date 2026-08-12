import {
  decodeCanonicalColor4Raster,
  unwrapColor4Frame,
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
): Color4DiagnosticReason | undefined {
  const fec = fecDiagnosticReason(
    rejectReason ?? "",
    unwrap.flatMap((observation) =>
      observation.stage === "rs" ? observation.shards.map((shard) => shard.reason) : []
    ),
  );
  if (fec !== undefined) return fec;
  const rejectedStage = classifier.find((observation) => observation.outcome === "rejected")?.stage;
  return canonicalDiagnosticReason(
    rejectReason ?? "",
    raster?.diagnostics,
    rejectedStage,
  );
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
): BrowserVisionDiagnostics {
  const geometry = normalized?.diagnostics;
  const fiducials = geometry?.fiducials;
  const diagnosticReason = actionableDiagnosticReason(raster, classifier, unwrap, rejectReason);
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
    erasures: raster?.diagnostics.erasureBytes ?? 0,
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

async function decode(request: Color4WorkerDecodeRequest): Promise<void> {
  const started = performance.now();
  const pixels = new Uint8ClampedArray(request.rgba);
  const classifierObservations: CanonicalRasterObservation[] = [];
  const unwrapObservations: Color4UnwrapObservation[] = [];
  let normalized: VisionResult | undefined;
  let raster: CanonicalRasterResult | undefined;
  const observerDetail = request.debug.snapshot ||
    (request.debug.emitPlane && request.debug.view === "calibration");
  try {
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
    });
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
    const unwrapped = unwrapColor4Frame(raster.codedBytes, {
      profileId: raster.profile.id,
      paletteId: request.paletteId,
      erasures: raster.byteErasures,
      observer: (observation) => unwrapObservations.push(observation),
    });
    const diagnostics = baseDiagnostics(
      request,
      raster,
      normalized,
      classifierObservations,
      unwrapObservations,
      started,
      unwrapped.status === "rejected" ? unwrapped.reason : undefined,
    );
    diagnostics.erasures = Math.max(raster.diagnostics.erasureBytes, unwrapped.diagnostics.erasures);
    diagnostics.erasureBytes = diagnostics.erasures;
    diagnostics.correctedErrors = unwrapped.diagnostics.correctedErrors;
    diagnostics.correctedBytes = unwrapped.diagnostics.correctedBytes;
    diagnostics.correctedShards = unwrapped.diagnostics.correctedShards;
    diagnostics.rsCorrectedSymbols = unwrapped.diagnostics.correctedBytes;
    diagnostics.profile = raster.profile.name;
    if (unwrapped.status === "rejected") {
      if (unwrapped.reason === "fec-uncorrectable") {
        updateReject(
          diagnostics,
          "rs",
          unwrapped.reason,
          actionableDiagnosticReason(raster, classifierObservations, unwrapObservations, unwrapped.reason),
        );
        diagnostics.rsFailures = 1;
      } else if (unwrapped.reason === "crc-mismatch") {
        updateReject(diagnostics, "crc", unwrapped.reason, "CRC_FAILED");
        diagnostics.crcFailures = 1;
      } else updateReject(diagnostics, "wire", unwrapped.reason);
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
