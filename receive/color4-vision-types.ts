import type { CanonicalRasterImage } from "../shared/color4/classifier";
import type { FiducialId } from "../shared/color4/physical";

export type VisionDebugView =
  | "raw"
  | "grayscale"
  | "threshold"
  | "contours"
  | "fiducials"
  | "warped"
  | "calibration";

export type VisionCanonicalScale = 4 | 6 | 8;
export type VisionDetectionLimit = 960 | 1280 | "source";

export interface VisionOptions {
  /** Defaults to the normative sampling scale of four pixels per module. */
  readonly canonicalScale?: VisionCanonicalScale;
  /** Defaults to 960. `source` disables the detection downscale. */
  readonly maxDetectionDimension?: VisionDetectionLimit;
  /** Enables bounded geometric traces and the plane needed by `debugView`. */
  readonly debug?: boolean;
  /** Captures raw, threshold and (when available) warped planes. */
  readonly snapshot?: boolean;
  readonly debugView?: VisionDebugView;
  /** Injectable monotonic clock for deterministic instrumentation tests. */
  readonly now?: () => number;
}

export interface VisionPoint {
  readonly x: number;
  readonly y: number;
}

export type VisionQuad = readonly [VisionPoint, VisionPoint, VisionPoint, VisionPoint];

export interface VisionFiducialMatch {
  readonly id: FiducialId;
  readonly errors: number;
  readonly rotation: 0 | 1 | 2 | 3;
}

export type VisionCandidateStatus =
  | "DECODED"
  | "DUPLICATE_ID"
  | "FIDUCIAL_AMBIGUOUS"
  | "FIDUCIAL_TOO_MANY_ERRORS"
  | "FIDUCIAL_DECODE_FAILED";

export interface VisionCandidateTrace {
  readonly contourIndex: number;
  /** Area in pixels in the (possibly downscaled) detection plane. */
  readonly area: number;
  /** Coordinates in the original source image, suitable for the video overlay. */
  readonly quad: VisionQuad;
  readonly center: VisionPoint;
  /** Coordinates in the threshold/detection plane. */
  readonly detectionQuad: VisionQuad;
  readonly best?: VisionFiducialMatch;
  readonly second?: VisionFiducialMatch;
  readonly status: VisionCandidateStatus;
}

export interface VisionStageTimings {
  readonly grayscaleMs: number;
  readonly resizeMs: number;
  readonly thresholdMs: number;
  readonly contoursMs: number;
  readonly fiducialDecodeMs: number;
  readonly homographyMs: number;
  readonly totalMs: number;
}

export interface VisionContourCounters {
  readonly contoursTotal: number;
  readonly areaTooSmall: number;
  readonly areaTooLarge: number;
  readonly nonQuad: number;
  readonly nonConvex: number;
  readonly quads: number;
  readonly decoded: number;
  readonly duplicateIds: number;
  readonly ambiguous: number;
  readonly tooManyErrors: number;
  readonly decodeFailures: number;
}

export interface VisionEffectiveConfig {
  readonly canonicalScale: VisionCanonicalScale;
  readonly maxDetectionDimension: VisionDetectionLimit;
  readonly sourceWidth: number;
  readonly sourceHeight: number;
  readonly detectionWidth: number;
  readonly detectionHeight: number;
  readonly detectionScale: number;
  readonly adaptiveBlockSize: 31;
  readonly adaptiveConstant: 7;
  readonly minimumAreaFraction: 0.00008;
  readonly maximumAreaFraction: 0.08;
  readonly polygonEpsilonFraction: 0.045;
  readonly maximumFiducialErrors: 4;
}

export interface VisionDiagnostics {
  readonly config: VisionEffectiveConfig;
  readonly timings: VisionStageTimings;
  readonly counters: VisionContourCounters;
  /** IDs retained for homography after duplicate resolution. */
  readonly fiducials: Readonly<Partial<Record<FiducialId, VisionFiducialMatch>>>;
}

export type VisionPlaneId = "raw" | "grayscale" | "threshold" | "warped";

export interface VisionPlane {
  readonly width: number;
  readonly height: number;
  readonly channels: 1 | 4;
  readonly pixels: Uint8ClampedArray;
}

export interface VisionDebugMetadata {
  readonly sourceWidth: number;
  readonly sourceHeight: number;
  readonly detectionWidth: number;
  readonly detectionHeight: number;
  readonly detectionScale: number;
  readonly canonicalScale: VisionCanonicalScale;
  readonly warpedAvailable: boolean;
  readonly traceLimit: 64;
  readonly tracesTruncated: boolean;
}

export interface VisionDebugArtifacts {
  readonly metadata: VisionDebugMetadata;
  readonly traces: readonly VisionCandidateTrace[];
  readonly planes: Readonly<Partial<Record<VisionPlaneId, VisionPlane>>>;
}

export type VisionRejectReason =
  | "NO_CONTOUR_CANDIDATES"
  | "DUPLICATE_IDS"
  | "ONLY_1_FIDUCIAL"
  | "ONLY_2_FIDUCIALS"
  | "ONLY_3_FIDUCIALS"
  | "FIDUCIAL_AMBIGUOUS"
  | "FIDUCIAL_TOO_MANY_ERRORS"
  | "QUADS_FOUND_NO_MARKERS"
  | "HOMOGRAPHY_FAILED";

interface VisionResultBase {
  /** Backward-compatible count of quadrilateral candidates. */
  readonly candidates: number;
  readonly diagnostics: VisionDiagnostics;
  /** Present only when `debug` or `snapshot` was requested. */
  readonly debug?: VisionDebugArtifacts;
}

export interface ValidVisionResult extends VisionResultBase {
  readonly status: "valid";
  readonly image: CanonicalRasterImage;
}

export interface RejectedVisionResult extends VisionResultBase {
  readonly status: "rejected";
  readonly reason: VisionRejectReason;
}

export type VisionResult = ValidVisionResult | RejectedVisionResult;
