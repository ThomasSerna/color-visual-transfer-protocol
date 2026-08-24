/**
 * How each COLOR_4 profile behaves as optical resolution falls.
 *
 * The physical export that motivated this work reported a median of 5.1 camera
 * pixels per module and an EXPERIMENTAL frame whose classifier flagged roughly
 * 50 erasure bytes per shard against a 16-symbol parity budget. That reads like
 * a profile too dense for the channel — but the same export shows one frame
 * flagging only 102 erasure bytes in total, well inside budget, which decoded.
 * The two readings imply very different fixes: a lower code rate, or a receiver
 * that sees more sharp frames.
 *
 * This sweep separates them. It holds everything except pixels-per-module still
 * and records what the classifier actually produces at each step, so the
 * question of whether EXPERIMENTAL's code rate needs to change is answered with
 * a measurement rather than an inference from one bad capture.
 *
 * The `OPTICAL_SWEEP` record it prints is the artifact; the assertions below
 * pin only the properties that must never regress.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  EXPERIMENTAL_PROFILE,
  ROBUST_PROFILE,
  decodeCanonicalColor4Raster,
  type Color4Profile,
} from "../shared/color4/index.ts";
import { normalizeColor4WithOpenCv } from "../receive/color4-vision.ts";
import { runColor4ErasurePolicy } from "../receive/color4-erasure-policy.ts";
import { color4SequencePhaseMatches } from "../receive/color4-binding.ts";
import { loadOpenCvRuntime } from "./helpers/opencv-runtime.ts";
import {
  renderSyntheticCameraFrame,
  type SyntheticCameraCv,
} from "./helpers/color4-synthetic-camera.ts";

/** The interpretation bands named in the COLOR_4 vision specification. */
const SWEEP_PIXELS_PER_MODULE = Object.freeze([3.5, 4.5, 5.5, 7]);
const MINIMUM_FIDUCIAL_CONTRAST = 30;

interface SweepOutcome {
  readonly profile: string;
  readonly pixelsPerModule: number;
  readonly blurKernel: number;
  readonly vision: string;
  readonly classifier: string;
  readonly unwrap: string;
  /** True only when the recovered inner frame matched the transmitted bytes. */
  readonly exact: boolean;
  readonly fiducialContrast?: number;
  readonly uncertainCells?: number;
  readonly erasureBytes?: number;
  readonly parityByShard?: number;
  readonly worstShardErasures?: number;
  readonly selectedBudgetFraction?: number;
}

function sweepOnce(
  cv: Awaited<ReturnType<typeof loadOpenCvRuntime>>,
  profile: Color4Profile,
  pixelsPerModule: number,
  blurKernel: 3 | 5 | undefined,
): SweepOutcome {
  const frame = renderSyntheticCameraFrame(cv as unknown as SyntheticCameraCv, {
    profile,
    paletteId: 0,
    sequence: 1,
    pixelsPerModule,
    // A camera never sees the ideal 0-255 span. Without this the frame carries
    // roughly 250 luma of fiducial contrast where physical exports report
    // 40-115, and every contrast-sensitive gate passes for the wrong reason.
    capturePhotometry: true,
    angleDeg: 8,
    ...(blurKernel === undefined ? {} : { blurKernel }),
  });
  const base = {
    profile: profile.name,
    pixelsPerModule: Math.round(pixelsPerModule * 100) / 100,
    blurKernel: blurKernel ?? 0,
  };

  const vision = normalizeColor4WithOpenCv(
    cv,
    frame.width,
    frame.height,
    Uint8ClampedArray.from(frame.pixels),
    { canonicalScale: 6, maxDetectionDimension: 1280 },
  );
  if (vision.status !== "valid") {
    return { ...base, vision: vision.reason, classifier: "-", unwrap: "-", exact: false };
  }
  const fiducialContrast = vision.diagnostics.optical?.fiducialContrast;

  const classified = decodeCanonicalColor4Raster(vision.image);
  if (classified.status !== "valid") {
    return {
      ...base,
      vision: "valid",
      classifier: classified.reason,
      unwrap: "-",
      exact: false,
      ...(fiducialContrast === undefined ? {} : { fiducialContrast }),
    };
  }

  const policy = runColor4ErasurePolicy({
    codedBytes: classified.codedBytes,
    profile: classified.profile,
    paletteId: classified.paletteId,
    erasureCandidates: classified.byteErasureCandidates,
    expectedSequencePhase: classified.sequencePhase,
  });
  const result = policy.result;
  const accepted = result.status === "valid" &&
    color4SequencePhaseMatches(result.header.sequence, classified.sequencePhase);
  const exact = accepted &&
    result.status === "valid" &&
    result.innerFrame.length === frame.innerFrame.length &&
    result.innerFrame.every((byte, index) => byte === frame.innerFrame[index]);

  return {
    ...base,
    vision: "valid",
    classifier: "valid",
    unwrap: result.status === "valid" ? (accepted ? "valid" : "phase-mismatch") : result.reason,
    exact,
    ...(fiducialContrast === undefined ? {} : { fiducialContrast }),
    uncertainCells: classified.diagnostics.uncertainCells,
    erasureBytes: classified.diagnostics.erasureBytes,
    parityByShard: classified.diagnostics.parityByShard,
    worstShardErasures: Math.max(...classified.diagnostics.erasuresByShard),
    selectedBudgetFraction: policy.selectedBudgetFraction,
  };
}

test("COLOR_4 profiles degrade predictably as pixels per module fall", {
  timeout: 600_000,
}, async () => {
  const cv = await loadOpenCvRuntime();
  const outcomes: SweepOutcome[] = [];
  for (const profile of [ROBUST_PROFILE, EXPERIMENTAL_PROFILE]) {
    for (const pixelsPerModule of SWEEP_PIXELS_PER_MODULE) {
      for (const blurKernel of [undefined, 3] as const) {
        outcomes.push(sweepOnce(cv, profile, pixelsPerModule, blurKernel));
      }
    }
  }

  console.log(`OPTICAL_SWEEP ${JSON.stringify({ outcomes })}`);

  // The safety property, and the only one that is absolute: an accepted frame
  // carries the transmitted bytes. Reed-Solomon solving against more damage
  // than it can locate must be caught by CRC32C, the outer header and the
  // physical sequence phase, never delivered to the fountain decoder.
  for (const outcome of outcomes) {
    if (outcome.unwrap === "valid") {
      assert.ok(
        outcome.exact,
        `${outcome.profile} at ${outcome.pixelsPerModule} px/module accepted inexact bytes`,
      );
    }
  }

  // At the specification's "preferred" band both profiles must round-trip, sharp
  // or mildly blurred. A regression that breaks this is a receiver bug, not an
  // argument about the physical layer.
  for (const outcome of outcomes.filter((entry) => entry.pixelsPerModule >= 7)) {
    assert.equal(
      outcome.unwrap,
      "valid",
      `${outcome.profile} must decode at ${outcome.pixelsPerModule} px/module ` +
        `(blur ${outcome.blurKernel}), got ${outcome.vision}/${outcome.classifier}/${outcome.unwrap}`,
    );
  }

  // Fiducial identity is read from the full-resolution image rather than the
  // downscaled detection pass, which is what keeps the weakest accepted marker
  // clear of the 30-luma detection gate down into the risky band.
  for (const outcome of outcomes.filter((entry) => entry.pixelsPerModule >= 4.5)) {
    assert.ok(
      (outcome.fiducialContrast ?? 0) > MINIMUM_FIDUCIAL_CONTRAST,
      `${outcome.profile} at ${outcome.pixelsPerModule} px/module (blur ${outcome.blurKernel}) ` +
        `reported ${outcome.fiducialContrast} luma of fiducial contrast`,
    );
  }

  // Denser data cannot be more robust than sparser data at the same optics: if
  // this inverts, the sweep is measuring something other than what it claims.
  for (const pixelsPerModule of SWEEP_PIXELS_PER_MODULE) {
    for (const blurKernel of [0, 3]) {
      const robust = outcomes.find((entry) =>
        entry.profile === "ROBUST" && entry.pixelsPerModule === pixelsPerModule &&
        entry.blurKernel === blurKernel);
      const experimental = outcomes.find((entry) =>
        entry.profile === "EXPERIMENTAL" && entry.pixelsPerModule === pixelsPerModule &&
        entry.blurKernel === blurKernel);
      if (robust?.uncertainCells === undefined || experimental?.uncertainCells === undefined) {
        continue;
      }
      const robustRate = robust.uncertainCells / (ROBUST_PROFILE.columns * ROBUST_PROFILE.rows);
      const experimentalRate = experimental.uncertainCells /
        (EXPERIMENTAL_PROFILE.columns * EXPERIMENTAL_PROFILE.rows);
      assert.ok(
        experimentalRate >= robustRate - 0.02,
        `EXPERIMENTAL was unexpectedly cleaner than ROBUST at ${pixelsPerModule} px/module: ` +
          `${experimentalRate.toFixed(4)} vs ${robustRate.toFixed(4)}`,
      );
    }
  }
});
