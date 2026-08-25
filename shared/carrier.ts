/**
 * Public carrier contracts live with the COLOR_4 codec because both QR and
 * COLOR_4 must return the exact same legacy packFrame bytes. This module is the
 * browser-facing entry point and adds only UI/worker diagnostics.
 */
import type { CarrierId, RejectReason } from "./color4/types";

export type {
  CarrierId,
  CapturedFrame,
  Color4FrameContext,
  DecodeResult,
  FrameContext,
  FrameDiagnostics,
  RejectReason,
  RenderedFrame,
  VisualDecoder,
  VisualEncoder,
} from "./color4/types";

export type CarrierChoice = "qr" | "color4";

/** Persistence-safe names used by the bounded COLOR_4 unwrap-policy telemetry. */
export type BrowserColor4ErasurePolicy = "classifier-budgeted" | "hard-decision";
export type BrowserColor4ErasureBudgetFraction = 1 | 0.75 | 0.5 | 0;

/** Persistence-safe labels for the temporal receiver's bounded counters. */
export type BrowserCapturePath = "bitmap" | "rgba";
export type BrowserCaptureDropReason =
  | "reservation-unavailable"
  | "geometry-busy"
  | "classifier-busy"
  | "prefilter-unstable"
  | "prefilter-redundant"
  | "bitmap-failed"
  | "capture-failed"
  | "stale-session"
  | "watchdog";
/** `legacy` is the full-warp pipeline, entered by probe or hold, not a per-frame fallback. */
export type BrowserGeometryPath = "cold" | "tracked" | "fallback" | "legacy";
export type BrowserWorkerKind = "geometry" | "classifier";

/**
 * Aggregate-only worker contract. It deliberately exposes counts by shard,
 * never erased-byte positions, ranked candidates, coded bytes or payload data.
 */
export interface BrowserColor4UnwrapAttemptDiagnostics {
  readonly policy: BrowserColor4ErasurePolicy;
  readonly budgetFraction: BrowserColor4ErasureBudgetFraction;
  readonly maxErasuresPerShard: number;
  readonly erasures: number;
  readonly erasuresByShard: readonly number[];
  readonly phaseMatched?: boolean;
  readonly durationMs: number;
  readonly status: "valid" | "rejected";
  readonly reason?: RejectReason;
}

export type VisionTimingKey =
  | "capture"
  | "grayscale"
  | "resize"
  | "threshold"
  | "contours"
  | "fiducialDecode"
  | "homography"
  | "refinement"
  | "tracking"
  | "sampling"
  | "guard"
  | "geometryTotal"
  | "canonicalGeometry"
  | "bootstrapPhase"
  | "calibration"
  | "classification"
  | "classifier"
  | "rs"
  | "crc"
  | "wire"
  | "workerTotal"
  | "roundTripTotal"
  | "opencvInit";

export interface VisionDetectionDiagnostics {
  readonly inputWidth?: number;
  readonly inputHeight?: number;
  readonly detectionWidth?: number;
  readonly detectionHeight?: number;
  readonly resizeScale?: number;
  readonly adaptiveBlockSize?: number;
  readonly adaptiveConstant?: number;
  readonly thresholdPasses?: readonly string[];
  readonly minimumAreaFraction?: number;
  readonly maximumAreaFraction?: number;
  readonly polygonEpsilonFraction?: number;
  readonly maximumContoursPerPass?: number;
  readonly maximumQuadProposals?: number;
  readonly maximumFiducialErrors?: number;
  readonly contours?: number;
  readonly areaTooSmall?: number;
  readonly areaTooLarge?: number;
  readonly nonQuads?: number;
  readonly nonConvex?: number;
  readonly quads?: number;
  readonly mergedCandidates?: number;
  readonly candidateCountRaw?: number;
  readonly candidateCountRanked?: number;
  readonly decodedMarkers?: number;
  readonly lowContrastCandidates?: number;
  readonly uniqueFiducials?: number;
  readonly duplicateIds?: number;
  readonly ambiguousCandidates?: number;
  readonly tooManyErrorCandidates?: number;
  readonly decodeFailures?: number;
}

export interface VisionFiducialNumericDiagnostic {
  readonly found: boolean;
  readonly errors?: number;
}

export interface VisionBootstrapSamplingDiagnostics {
  readonly doubleVoteColumns: number;
  readonly singleVoteColumns: number;
  readonly uncertainColumns: number;
  readonly contradictoryColumns: number;
  readonly minimumDifferentialLuma: number;
  readonly medianDifferentialLuma: number;
}

export type VisionTimingRailName = "top" | "right" | "bottom" | "left";

export interface VisionTimingRailDiagnostics {
  readonly valid: boolean;
  readonly blackLuma: number;
  readonly whiteLuma: number;
  readonly thresholdLuma: number;
  readonly contrastLuma: number;
  readonly errors: number;
  readonly uncertainModules: number;
  readonly modules: number;
}

/** Persistence-safe classifier summary; it never contains samples, payload bytes or indices. */
export interface VisionClassifierDistributionDiagnostics {
  readonly count: number;
  readonly min: number;
  readonly p50: number;
  readonly p95: number;
  readonly max: number;
}

/**
 * Small, persistence-safe COLOR_4 diagnostics. Pixel planes, quads, cell
 * traces and camera imagery deliberately stay in the receiver's ephemeral
 * debug channel and never enter this browser-wide carrier contract.
 */
export interface BrowserVisionDiagnostics {
  readonly debugEnabled?: boolean;
  readonly canonicalScale?: 4 | 6 | 8;
  readonly detectionDimension?: 960 | 1280 | "source";
  readonly rejectReason?: string;
  readonly diagnosticReason?: Color4DiagnosticReason;
  readonly timings?: Readonly<Partial<Record<VisionTimingKey, number>>>;
  readonly warnings?: readonly string[];
  readonly detection?: VisionDetectionDiagnostics;
  readonly fiducials?: Readonly<Partial<Record<"TL" | "TR" | "BR" | "BL", VisionFiducialNumericDiagnostic>>>;
  readonly homography?: Readonly<{
    method: "none" | "corners-16" | "centers-4";
    residualRmsModules?: number;
    residualMaxModules?: number;
    refinementResidualBeforeRmsModules?: number;
    refinementResidualBeforeMaxModules?: number;
    refinementResidualAfterRmsModules?: number;
    refinementResidualAfterMaxModules?: number;
    refinementAttempted: boolean;
    refinementApplied: boolean;
  }>;
  /**
   * Present only on tracked frames, and never together with `detection`,
   * `fiducials`, `optical` or `homography`: those describe an acquisition this
   * frame did not run.
   */
  readonly tracking?: Readonly<{
    trackedCorners: number;
    /** Worst forward/backward error among the corners that tracked. */
    forwardBackwardMaxPx?: number;
    residualRmsModules?: number;
    residualMaxModules?: number;
    areaRatio?: number;
  }>;
  readonly optical?: Readonly<{
    apparentFrameWidthPx: number;
    apparentFrameHeightPx: number;
    pixelsPerModuleX: number;
    pixelsPerModuleY: number;
    minimumPixelsPerModule: number;
    fiducialWidthPx: number;
    fiducialHeightPx: number;
    fiducialContrast: number;
    blurMetric: number;
    clippedPixelFraction?: number;
  }>;
  readonly canonical?: Readonly<{
    fiducialErrors?: number;
    fiducialErrorsById?: Readonly<Record<"TL" | "TR" | "BR" | "BL", number>>;
    fiducialErrorMax?: number;
    quietZoneErrors?: number;
    quietZoneLumaErrors?: number;
    quietZoneRgbErrors?: number;
    timingErrors?: number;
    timingModules?: number;
    timingUncertainModules?: number;
    bootstrapSampling?: Readonly<VisionBootstrapSamplingDiagnostics>;
    timingRails?: Readonly<Record<VisionTimingRailName, Readonly<VisionTimingRailDiagnostics>>>;
    calibrationMad?: number;
    observedContrast?: number;
    minimumPaletteDistance?: number;
    uncertainCells?: number;
    erasureBytes?: number;
    distanceRejectedCells?: number;
    gapRejectedCells?: number;
    bothRejectedCells?: number;
    /** Aggregate counts only; no erased-byte positions are exposed. */
    erasuresByShard?: readonly number[];
    parityByShard?: number;
    remainingErasureBudgetByShard?: readonly number[];
    uncertainCellsByRow?: readonly number[];
    uncertainCellsByColumn?: readonly number[];
    effectiveMaximumDeltaE?: number;
    effectiveMinimumDeltaEGap?: number;
    bestDeltaE?: Readonly<VisionClassifierDistributionDiagnostics>;
    deltaEGap?: Readonly<VisionClassifierDistributionDiagnostics>;
    /** Aggregate heuristic severity for erased-byte candidates; never positions or samples. */
    erasureCandidateScore?: Readonly<VisionClassifierDistributionDiagnostics>;
    meanBestDeltaE?: number;
    maximumBestDeltaE?: number;
  }>;
}

/** Additive, browser-only failure localization; never serialized on the wire. */
export type Color4DiagnosticReason =
  | "CANONICAL_DIMENSIONS"
  | "FIDUCIAL_CANONICAL"
  | "QUIET_ZONE_LUMA"
  | "QUIET_ZONE_RGB"
  | "TIMING"
  | "BOOTSTRAP"
  | "PHASE"
  | "CALIBRATION"
  | "COLOR_CLASSIFICATION_TOO_UNCERTAIN"
  | "RS_FAILED"
  | "CRC_FAILED";

export function carrierId(choice: CarrierChoice): CarrierId {
  return choice === "color4" ? "COLOR_4" : "QR_LEGACY";
}

export interface BrowserCarrierDiagnostics {
  profile?: string;
  stage?:
    | "capture"
    | "geometry"
    | "bootstrap"
    | "calibration"
    | "classification"
    | "rs"
    | "crc"
    | "wire";
  candidates?: number;
  uncertainCells?: number;
  rsCorrectedSymbols?: number;
  rsFailures?: number;
  crcFailures?: number;
  erasureBytes?: number;
  confidence?: number;
  rejectReason?: string;
  decodeMs?: number;
  /** Optional aggregate-only COLOR_4 unwrap-policy telemetry. */
  erasurePolicy?: BrowserColor4ErasurePolicy;
  selectedBudgetFraction?: BrowserColor4ErasureBudgetFraction;
  selectedMaxErasuresPerShard?: number;
  /** Counts by shard only; never erased-byte positions. */
  selectedErasuresByShard?: readonly number[];
  /** At most four ordered attempts; consumers must validate this boundary. */
  unwrapAttempts?: readonly BrowserColor4UnwrapAttemptDiagnostics[];
  vision?: BrowserVisionDiagnostics;
}
