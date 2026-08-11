import type { BrowserVisionDiagnostics } from "../shared/carrier";
import type { CaptureQualityClass } from "../shared/experiments";
import type { CaptureStabilityState } from "./color4-capture-stability";

export const COLOR4_UNUSABLE_PIXELS_PER_MODULE = 4;
export const COLOR4_GOOD_PIXELS_PER_MODULE = 6;
export const COLOR4_MINIMUM_FIDUCIAL_CONTRAST = 30;

/**
 * Shadow-only acquisition classification. Blur/clipping are intentionally
 * excluded until physical captures calibrate meaningful device thresholds.
 */
export function classifyColor4CaptureQuality(
  stability: CaptureStabilityState | undefined,
  vision: BrowserVisionDiagnostics | undefined,
): CaptureQualityClass {
  if (stability === undefined || stability === "warmup") return "UNKNOWN";
  if (stability === "unstable") return "UNUSABLE";
  const found = vision?.fiducials === undefined
    ? undefined
    : (["TL", "TR", "BR", "BL"] as const).filter((id) => vision.fiducials?.[id]?.found).length;
  if (found !== undefined && found < 4) return "UNUSABLE";
  const optical = vision?.optical;
  if (!optical) return "UNKNOWN";
  if (
    optical.minimumPixelsPerModule < COLOR4_UNUSABLE_PIXELS_PER_MODULE ||
    optical.fiducialContrast < COLOR4_MINIMUM_FIDUCIAL_CONTRAST
  ) return "UNUSABLE";
  if (optical.minimumPixelsPerModule < COLOR4_GOOD_PIXELS_PER_MODULE) return "BORDERLINE";
  return "GOOD";
}
