/**
 * Public carrier contracts live with the COLOR_4 codec because both QR and
 * COLOR_4 must return the exact same legacy packFrame bytes. This module is the
 * browser-facing entry point and adds only UI/worker diagnostics.
 */
import type { CarrierId } from "./color4/types";

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

export type VisionTimingKey =
  | "capture"
  | "grayscale"
  | "resize"
  | "threshold"
  | "contours"
  | "fiducialDecode"
  | "homography"
  | "refinement"
  | "canonicalGeometry"
  | "bootstrapPhase"
  | "calibration"
  | "classification"
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
  readonly decodedMarkers?: number;
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
  readonly timings?: Readonly<Partial<Record<VisionTimingKey, number>>>;
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
  readonly canonical?: Readonly<{
    fiducialErrors?: number;
    fiducialErrorsById?: Readonly<Record<"TL" | "TR" | "BR" | "BL", number>>;
    fiducialErrorMax?: number;
    quietZoneErrors?: number;
    timingErrors?: number;
    timingModules?: number;
    calibrationMad?: number;
    observedContrast?: number;
    minimumPaletteDistance?: number;
    uncertainCells?: number;
    erasureBytes?: number;
    meanBestDeltaE?: number;
    maximumBestDeltaE?: number;
  }>;
}

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
  vision?: BrowserVisionDiagnostics;
}
