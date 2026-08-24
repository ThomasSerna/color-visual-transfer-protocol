/**
 * The detection search region: a hint, never a constraint.
 *
 * Thresholding and contour extraction dominate cold acquisition and cost
 * whatever the searched area costs, so a receiver that already knows where the
 * code is can pay for a fraction of the pixels. That is only safe if three
 * things hold, and this file pins all three against the real camera fixture:
 *
 * 1. A frame decoded through a search region recovers the same payload bytes as
 *    the same frame decoded over the whole image.
 * 2. A stale region does not lose the frame — the search falls back to the full
 *    image inside the same call and says so.
 * 3. Debug and snapshot passes never crop, because their traces and planes
 *    describe the whole frame.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";
import { decodeCanonicalColor4Raster } from "../shared/color4/index.ts";
import {
  normalizeColor4WithOpenCv,
  type VisionSearchRegion,
} from "../receive/color4-vision.ts";
import { runColor4ErasurePolicy } from "../receive/color4-erasure-policy.ts";
import { color4SequencePhaseMatches } from "../receive/color4-binding.ts";
import { loadOpenCvRuntime } from "./helpers/opencv-runtime.ts";

const FIXTURE = fileURLToPath(
  new URL("./fixtures/color4/physical/capture-000017/raw-frame.png", import.meta.url),
);
/** Pinned by the canonical and physical replays; this file must not move it. */
const INNER_FRAME_SHA256 = "a5dcecd1058c25b13c5076e9f7d7e2617af3c830823c33831180d6a4f9976a84";

interface Outcome {
  readonly warnings: readonly string[];
  readonly uncertainCells: number;
  readonly erasureBytes: number;
  readonly worstShardErasures: number;
  readonly innerFrameSha256: string;
  readonly frameRegion?: VisionSearchRegion;
}

async function loadFrame(): Promise<{ width: number; height: number; pixels: Uint8ClampedArray }> {
  const png = PNG.sync.read(await readFile(FIXTURE));
  return { width: png.width, height: png.height, pixels: Uint8ClampedArray.from(png.data) };
}

function decodeFrame(
  cv: Awaited<ReturnType<typeof loadOpenCvRuntime>>,
  frame: { width: number; height: number; pixels: Uint8ClampedArray },
  searchRegion?: VisionSearchRegion,
  extra: { debug?: boolean } = {},
): Outcome {
  const vision = normalizeColor4WithOpenCv(
    cv,
    frame.width,
    frame.height,
    // OpenCV takes ownership of the buffer it is given.
    Uint8ClampedArray.from(frame.pixels),
    {
      canonicalScale: 6,
      maxDetectionDimension: 1280,
      ...(searchRegion === undefined ? {} : { searchRegion }),
      ...extra,
    },
  );
  assert.equal(vision.status, "valid", "the physical fixture must locate its frame");
  if (vision.status !== "valid") throw new Error("unreachable");

  const classified = decodeCanonicalColor4Raster(vision.image);
  assert.equal(classified.status, "valid");
  if (classified.status !== "valid") throw new Error("unreachable");

  const policy = runColor4ErasurePolicy({
    codedBytes: classified.codedBytes,
    profile: classified.profile,
    paletteId: classified.paletteId,
    erasureCandidates: classified.byteErasureCandidates,
    expectedSequencePhase: classified.sequencePhase,
  });
  assert.equal(policy.result.status, "valid");
  if (policy.result.status !== "valid") throw new Error("unreachable");
  assert.ok(
    color4SequencePhaseMatches(policy.result.header.sequence, classified.sequencePhase),
    "the recovered sequence must agree with the physical phase",
  );

  return {
    warnings: vision.diagnostics.warnings,
    uncertainCells: classified.diagnostics.uncertainCells,
    erasureBytes: classified.diagnostics.erasureBytes,
    worstShardErasures: Math.max(...classified.diagnostics.erasuresByShard),
    innerFrameSha256: createHash("sha256")
      .update(Uint8Array.from(policy.result.innerFrame))
      .digest("hex"),
    ...(vision.frameRegion === undefined ? {} : { frameRegion: vision.frameRegion }),
  };
}

test("a tracked search region recovers the same payload as a full-frame search", {
  timeout: 300_000,
}, async () => {
  const cv = await loadOpenCvRuntime();
  const frame = await loadFrame();

  const cold = decodeFrame(cv, frame);
  assert.equal(cold.innerFrameSha256, INNER_FRAME_SHA256);
  assert.deepEqual(cold.warnings, [], "a cold pass searches the whole frame");
  assert.ok(cold.frameRegion, "a located frame must report a region to track");

  const tracked = decodeFrame(cv, frame, cold.frameRegion);
  assert.ok(
    tracked.warnings.includes("GEOMETRY_SEARCH_REGION_APPLIED"),
    `the region should have held, got ${JSON.stringify(tracked.warnings)}`,
  );

  // The payload is the contract. Sub-pixel differences in where the corners
  // land are expected — the crop changes what INTER_AREA averages — but they
  // must never change the bytes that reach the fountain decoder.
  assert.equal(
    tracked.innerFrameSha256,
    INNER_FRAME_SHA256,
    "a tracked frame must recover the same inner frame as a cold one",
  );

  // On this capture the crop is also measurably cleaner, because the downscale
  // no longer averages in the surrounding scene: 95 uncertain cells become 49
  // and the worst shard falls from 18 erasures to 12 against a 32-symbol
  // budget. Asserting "no worse" rather than the exact figures keeps this a
  // guard against a harmful crop without pinning one machine's arithmetic.
  assert.ok(
    tracked.uncertainCells <= cold.uncertainCells,
    `tracking raised uncertain cells from ${cold.uncertainCells} to ${tracked.uncertainCells}`,
  );
  assert.ok(
    tracked.worstShardErasures <= cold.worstShardErasures,
    `tracking raised the worst shard from ${cold.worstShardErasures} to ` +
      `${tracked.worstShardErasures} erasures`,
  );
});

test("a stale search region falls back to the full frame inside the same call", {
  timeout: 300_000,
}, async () => {
  const cv = await loadOpenCvRuntime();
  const frame = await loadFrame();

  // A corner of the image that cannot contain all four fiducials.
  const stale = decodeFrame(cv, frame, { x: 0, y: 0, width: 400, height: 400 });
  assert.ok(
    stale.warnings.includes("GEOMETRY_SEARCH_REGION_MISSED"),
    `a missed region must be reported, got ${JSON.stringify(stale.warnings)}`,
  );
  assert.ok(
    !stale.warnings.includes("GEOMETRY_SEARCH_REGION_APPLIED"),
    "a missed region must not also report as applied",
  );
  assert.equal(
    stale.innerFrameSha256,
    INNER_FRAME_SHA256,
    "a stale hint must cost latency, never the frame",
  );
});

test("a whole-frame region is not worth cropping to, and debug never crops", {
  timeout: 300_000,
}, async () => {
  const cv = await loadOpenCvRuntime();
  const frame = await loadFrame();

  // Cropping to (almost) the whole image would copy every pixel to save
  // nothing, so the region is declined rather than honoured.
  const whole = decodeFrame(cv, frame, {
    x: 0,
    y: 0,
    width: frame.width,
    height: frame.height,
  });
  assert.deepEqual(whole.warnings, []);

  // Debug traces and planes describe the whole frame; a crop would silently
  // narrow what the operator is shown.
  const cold = decodeFrame(cv, frame);
  const debugged = decodeFrame(cv, frame, cold.frameRegion, { debug: true });
  assert.ok(
    !debugged.warnings.includes("GEOMETRY_SEARCH_REGION_APPLIED"),
    "a debug pass must search the whole frame",
  );
  assert.equal(debugged.innerFrameSha256, INNER_FRAME_SHA256);
});
