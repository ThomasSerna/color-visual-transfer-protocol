import assert from "node:assert/strict";
import test from "node:test";
import { classifyColor4CaptureQuality } from "../receive/color4-capture-quality";
import type { BrowserVisionDiagnostics } from "../shared/carrier";

function vision(ppm: number, contrast = 30, found = 4): BrowserVisionDiagnostics {
  const ids = ["TL", "TR", "BR", "BL"] as const;
  return {
    fiducials: Object.fromEntries(ids.map((id, index) => [id, { found: index < found }])),
    optical: {
      apparentFrameWidthPx: ppm * 172,
      apparentFrameHeightPx: ppm * 172,
      pixelsPerModuleX: ppm,
      pixelsPerModuleY: ppm,
      minimumPixelsPerModule: ppm,
      fiducialWidthPx: ppm * 9,
      fiducialHeightPx: ppm * 9,
      fiducialContrast: contrast,
      blurMetric: 0,
      clippedPixelFraction: 0,
    },
  };
}

test("capture quality is UNKNOWN until temporal and optical inputs exist", () => {
  assert.equal(classifyColor4CaptureQuality(undefined, undefined), "UNKNOWN");
  assert.equal(classifyColor4CaptureQuality("warmup", vision(8)), "UNKNOWN");
  assert.equal(classifyColor4CaptureQuality("stable", undefined), "UNKNOWN");
});

test("transitions and incomplete fiducials are UNUSABLE", () => {
  assert.equal(classifyColor4CaptureQuality("unstable", vision(8)), "UNUSABLE");
  assert.equal(classifyColor4CaptureQuality("stable", vision(8, 40, 3)), "UNUSABLE");
});

test("pixels/module and contrast boundaries are deterministic", () => {
  assert.equal(classifyColor4CaptureQuality("stable", vision(3.999, 40)), "UNUSABLE");
  assert.equal(classifyColor4CaptureQuality("stable", vision(4, 40)), "BORDERLINE");
  assert.equal(classifyColor4CaptureQuality("stable", vision(5.999, 40)), "BORDERLINE");
  assert.equal(classifyColor4CaptureQuality("stable", vision(6, 30)), "GOOD");
  assert.equal(classifyColor4CaptureQuality("stable", vision(8, 29.999)), "UNUSABLE");
});

test("blur and clipping remain observational rather than gates", () => {
  const diagnostic = vision(8, 40);
  assert.equal(classifyColor4CaptureQuality("stable", {
    ...diagnostic,
    optical: { ...diagnostic.optical!, blurMetric: 0, clippedPixelFraction: 1 },
  }), "GOOD");
});
