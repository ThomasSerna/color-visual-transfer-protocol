import type { Color4DiagnosticReason } from "../shared/carrier";

export interface CanonicalDiagnosticInputs {
  readonly fiducialErrorMax: number;
  readonly quietZoneErrors: number;
  readonly quietZoneLumaErrors: number;
  readonly quietZoneRgbErrors: number;
}

export function canonicalDiagnosticReason(
  reason: string,
  diagnostic: CanonicalDiagnosticInputs | undefined,
  rejectedStage?: "canonicalGeometry" | "bootstrapPhase" | "calibration" | "classification",
): Color4DiagnosticReason | undefined {
  if (reason === "invalid_dimensions") return "CANONICAL_DIMENSIONS";
  if (reason === "phase_mismatch" || reason === "sequence-phase-mismatch") return "PHASE";
  if (reason === "calibration_failed") return "CALIBRATION";
  if (
    reason === "invalid_bootstrap" ||
    reason === "unsupported_version" ||
    reason === "unsupported_profile" ||
    reason === "unsupported_palette" ||
    reason === "palette-selection-mismatch"
  ) return "BOOTSTRAP";
  if (reason !== "invalid_geometry" || !diagnostic) return undefined;
  if (rejectedStage === "bootstrapPhase") return "TIMING";
  if (diagnostic.fiducialErrorMax > 4) return "FIDUCIAL_CANONICAL";
  if (diagnostic.quietZoneErrors > 2) {
    return diagnostic.quietZoneLumaErrors > 2 ? "QUIET_ZONE_LUMA" : "QUIET_ZONE_RGB";
  }
  return "FIDUCIAL_CANONICAL";
}

/**
 * Post-FEC wire rejections that a saturated classifier can produce.
 *
 * When a shard carries more uncertain bytes than its parity budget, the ladder
 * marks only the worst of them. Reed-Solomon then either fails outright
 * (`fec-uncorrectable`) or, when the marked positions exactly exhaust parity,
 * returns a confidently wrong shard. In the latter case FEC reports success and
 * the frame dies at the first structural check instead, which is why these
 * reasons have to be attributed back to colour classification rather than
 * left unexplained.
 */
const SATURATION_WIRE_REJECTIONS: readonly string[] = Object.freeze([
  "invalid-outer-header",
  "invalid-length",
  "invalid-inner-frame",
]);

export function fecDiagnosticReason(
  reason: string,
  shardReasons: readonly (string | undefined)[] = [],
  classifierHintsSaturated = false,
): Color4DiagnosticReason | undefined {
  if (reason === "crc-mismatch") return "CRC_FAILED";
  if (classifierHintsSaturated && SATURATION_WIRE_REJECTIONS.includes(reason)) {
    return "COLOR_CLASSIFICATION_TOO_UNCERTAIN";
  }
  if (reason !== "fec-uncorrectable") return undefined;
  return classifierHintsSaturated || shardReasons.includes("too-many-erasures")
    ? "COLOR_CLASSIFICATION_TOO_UNCERTAIN"
    : "RS_FAILED";
}
