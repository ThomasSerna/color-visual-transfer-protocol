import assert from "node:assert/strict";
import test from "node:test";
import {
  ExperimentMetrics,
  makeExperimentExport,
  type ExperimentSummary,
} from "../shared/experiments.ts";

test("experiment summaries contain measurements but no payload identity", () => {
  const metrics = new ExperimentMetrics("receive", "COLOR_4", "ROBUST", 1_000);
  metrics.recordCapture();
  metrics.recordCapture();
  metrics.recordAttempt("valid", { rsCorrectedSymbols: 3, erasureBytes: 5, decodeMs: 9 });
  metrics.setVisionContext({
    debugEnabled: true,
    canonicalScale: 4,
    detectionDimension: 960,
    conditions: { expectedTxFps: 5, distanceM: 0.5, angleDeg: 0, brightness: "maximum" },
  });
  metrics.recordAttempt("rejected", {
    stage: "crc",
    rejectReason: "crc",
    crcFailures: 1,
    erasureBytes: 1,
    decodeMs: 11,
    vision: {
      debugEnabled: true,
      canonicalScale: 4,
      detectionDimension: 960,
      rejectReason: "CRC_MISMATCH",
      timings: { capture: 2, rs: 3, crc: 1, workerTotal: 10 },
      detection: {
        contours: 12,
        quads: 4,
        mergedCandidates: 4,
        decodedMarkers: 4,
        uniqueFiducials: 4,
        decodeFailures: 2,
      },
      fiducials: { TL: { found: true, errors: 1 }, TR: { found: false } },
      canonical: {
        fiducialErrorsById: { TL: 2, TR: 1, BR: 0, BL: 1 },
        fiducialErrorMax: 2,
      },
      homography: {
        method: "corners-16",
        residualRmsModules: 0.4,
        residualMaxModules: 0.7,
        refinementResidualBeforeRmsModules: 0.6,
        refinementResidualAfterRmsModules: 0.3,
        refinementAttempted: true,
        refinementApplied: false,
      },
    },
  });
  const summary = metrics.snapshot({
    success: true,
    now: 3_500,
    payloadBytes: 1_048_576,
    newFrames: 42,
    duplicateFrames: 2,
  });

  assert.equal(summary.elapsedMs, 2_500);
  assert.equal(summary.captures, 2);
  assert.equal(summary.validFrames, 1);
  assert.equal(summary.carrierRejected, 1);
  assert.equal(summary.rsCorrectedSymbols, 3);
  assert.equal(summary.erasureBytes, 6);
  assert.deepEqual(summary.erasureBytesPerAttempt, {
    count: 2,
    average: 3,
    min: 1,
    max: 5,
    p50: 1,
    p95: 1,
  });
  assert.equal(summary.crcFailures, 1);
  assert.equal(summary.decodeLatencyMs.p50, 9);
  assert.equal(summary.decodeLatencyMs.p95, 9);
  assert.equal(summary.vision?.debugEnabled, true);
  assert.deepEqual(summary.vision?.rejectReasons, { CRC_MISMATCH: 1 });
  assert.deepEqual(summary.vision?.stageRejections, { crc: 1 });
  assert.equal(summary.vision?.detection.contours, 12);
  assert.equal(summary.vision?.detection.mergedCandidates, 4);
  assert.equal(summary.vision?.detection.decodeFailures, 2);
  assert.equal(summary.vision?.fiducials.TL.averageErrors, 2);
  assert.equal(summary.vision?.fiducials.TL.maximumErrors, 2);
  assert.equal(summary.vision?.fiducials.TR.found, 1);
  assert.equal(summary.vision?.timingsMs.rs?.p95, 3);
  assert.equal(summary.vision?.conditions?.distanceM, 0.5);
  assert.deepEqual(summary.vision?.homography?.methods, { "corners-16": 1 });
  assert.equal(summary.vision?.homography?.refinementAttempts, 1);
  assert.equal(summary.vision?.homography?.refinementsApplied, 0);
  assert.equal(summary.vision?.homography?.residualRmsModules.p50, 0.4);
  assert.equal(summary.vision?.homography?.residualMaxModules.p95, 0.7);
  assert.equal(summary.vision?.homography?.refinementResidualBeforeRmsModules.p50, 0.6);
  assert.equal(summary.vision?.homography?.refinementResidualAfterRmsModules.p50, 0.3);
  assert.equal("fileName" in summary, false);
  assert.equal("hash" in summary, false);
});

test("vision timing reservoirs stay bounded and legacy summaries remain optional", () => {
  const metrics = new ExperimentMetrics("receive", "COLOR_4", "ROBUST", 0);
  for (let index = 0; index < 300; index++) {
    metrics.recordAttempt("rejected", {
      stage: "geometry",
      vision: {
        rejectReason: "ONLY_3_FIDUCIALS",
        timings: { contours: index },
      },
    });
  }
  const vision = metrics.snapshot({ success: false, now: 1 }).vision!;
  assert.equal(vision.timingsMs.contours?.count, 256);
  assert.equal(vision.timingsMs.contours?.min, 44);
  assert.equal(vision.timingsMs.contours?.max, 299);
  assert.equal(vision.rejectReasons.ONLY_3_FIDUCIALS, 300);
  assert.equal(metrics.snapshot({ success: false, now: 1 }).erasureBytesPerAttempt?.count, 256);

  const legacy = new ExperimentMetrics("receive", "QR_LEGACY", undefined, 0)
    .snapshot({ success: false, now: 1 });
  assert.equal(legacy.vision, undefined);
});

test("experiment export has a pinned, portable envelope", () => {
  const exported = makeExperimentExport([], undefined, new Date("2026-08-08T12:00:00Z"));
  assert.deepEqual(exported, {
    schema: "decimen-experiment-export",
    version: 1,
    exportedAt: "2026-08-08T12:00:00.000Z",
    current: undefined,
    history: [],
  });
});

test("schema-v1 IndexedDB summaries without vision remain export compatible", () => {
  // Records written before Debug Vision have neither `vision` nor the newly
  // calculated p95 value. IndexedDB stays at version 1, so reads and exports
  // must tolerate that exact stored shape without rewriting it.
  const storedLegacyRecord = {
    schemaVersion: 1,
    startedAt: "2026-08-01T12:00:00.000Z",
    finishedAt: "2026-08-01T12:00:02.000Z",
    direction: "receive",
    carrier: "QR_LEGACY",
    success: true,
    elapsedMs: 2_000,
    captures: 20,
    skippedWhileBusy: 1,
    carrierAttempts: 19,
    candidates: 19,
    geometryRejections: 0,
    bootstrapRejections: 0,
    calibrationRejections: 0,
    uncertainCells: 0,
    rsCorrectedSymbols: 0,
    rsFailures: 0,
    crcFailures: 0,
    validFrames: 12,
    newFrames: 10,
    duplicateFrames: 2,
    resolvedBlocks: 4,
    carrierRejected: 7,
    erasureBytes: 0,
    decodeLatencyMs: { count: 19, average: 8, min: 5, max: 12, p50: 8 },
  };
  const legacy = storedLegacyRecord as unknown as ExperimentSummary;
  const exported = makeExperimentExport(
    [legacy],
    undefined,
    new Date("2026-08-08T12:00:00Z"),
  );

  assert.equal(exported.version, 1);
  assert.equal(exported.history[0], legacy);
  assert.equal("vision" in exported.history[0]!, false);
  assert.equal("p95" in exported.history[0]!.decodeLatencyMs, false);
  assert.deepEqual(JSON.parse(JSON.stringify(exported)).history[0], storedLegacyRecord);
});
