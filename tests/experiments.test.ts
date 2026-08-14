import assert from "node:assert/strict";
import test from "node:test";
import {
  ExperimentMetrics,
  makeExperimentExport,
  workerP95ExceedsTxFrameInterval,
  type ExperimentSummary,
  type VisionExperimentSummary,
} from "../shared/experiments.ts";
import type { BrowserCarrierDiagnostics } from "../shared/carrier.ts";

test("experiment summaries contain measurements but no payload identity", () => {
  const metrics = new ExperimentMetrics("receive", "COLOR_4", "ROBUST", 1_000);
  metrics.recordCapture();
  metrics.recordCapture();
  metrics.recordCapture();
  metrics.recordStabilityWarmupCapture();
  metrics.recordStableCapture(0.01);
  metrics.recordUnstableCapture(0.25);
  metrics.recordVisionSubmission();
  metrics.recordSkippedUnstable();
  metrics.recordSkippedRedundantStable();
  metrics.recordQualityClass("UNKNOWN");
  metrics.recordQualityClass("GOOD");
  metrics.recordQualityClass("BORDERLINE");
  metrics.recordQualityClass("UNUSABLE");
  metrics.recordAttempt("valid", { rsCorrectedSymbols: 3, erasureBytes: 5, decodeMs: 9 });
  metrics.setVisionContext({
    debugEnabled: true,
    canonicalScale: 4,
    detectionDimension: 960,
    conditions: {
      expectedTxFps: 5,
      expectedProfile: "ROBUST",
      prefilterMode: "observe",
      distanceM: 0.5,
      angleDeg: 0,
      brightness: "maximum",
    },
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
      diagnosticReason: "CRC_FAILED",
      warnings: ["CANDIDATE_BUDGET_RANKED"],
      timings: { capture: 2, rs: 3, crc: 1, workerTotal: 10 },
      detection: {
        contours: 12,
        quads: 4,
        mergedCandidates: 4,
        candidateCountRaw: 300,
        candidateCountRanked: 256,
        decodedMarkers: 4,
        lowContrastCandidates: 7,
        uniqueFiducials: 4,
        decodeFailures: 2,
      },
      fiducials: { TL: { found: true, errors: 1 }, TR: { found: false } },
      optical: {
        apparentFrameWidthPx: 1032,
        apparentFrameHeightPx: 860,
        pixelsPerModuleX: 6,
        pixelsPerModuleY: 5,
        minimumPixelsPerModule: 4.5,
        fiducialWidthPx: 52,
        fiducialHeightPx: 48,
        fiducialContrast: 35,
        blurMetric: 120,
        clippedPixelFraction: 0.02,
      },
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
  assert.equal(summary.captures, 3);
  assert.equal(summary.stableCaptures, 1);
  assert.equal(summary.unstableCaptures, 1);
  assert.equal(summary.stabilityWarmupCaptures, 1);
  assert.equal(summary.visionSubmissions, 1);
  assert.equal(summary.skippedUnstable, 1);
  assert.equal(summary.skippedRedundantStable, 1);
  assert.deepEqual(summary.stabilityScore, {
    count: 2,
    average: 0.13,
    min: 0.01,
    max: 0.25,
    p50: 0.01,
    p95: 0.01,
  });
  assert.deepEqual(summary.qualityClassCounts, {
    UNKNOWN: 1,
    UNUSABLE: 1,
    BORDERLINE: 1,
    GOOD: 1,
  });
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
  assert.deepEqual(summary.vision?.rejectReasons, { CRC_FAILED: 1 });
  assert.deepEqual(summary.vision?.stageRejections, { crc: 1 });
  assert.equal(summary.vision?.detection.contours, 12);
  assert.equal(summary.vision?.detection.mergedCandidates, 4);
  assert.equal(summary.vision?.detection.candidateCountRaw, 300);
  assert.equal(summary.vision?.detection.candidateCountRanked, 256);
  assert.equal(summary.vision?.detection.lowContrastCandidates, 7);
  assert.equal(summary.vision?.detection.decodeFailures, 2);
  assert.equal(summary.vision?.fiducials.TL.averageErrors, 2);
  assert.equal(summary.vision?.fiducials.TL.maximumErrors, 2);
  assert.equal(summary.vision?.fiducials.TR.found, 1);
  assert.equal(summary.vision?.timingsMs.rs?.p95, 3);
  assert.deepEqual(summary.vision?.warnings, { CANDIDATE_BUDGET_RANKED: 1 });
  assert.equal(summary.vision?.optical?.minimumPixelsPerModule?.p50, 4.5);
  assert.equal(summary.vision?.optical?.fiducialContrast?.p95, 35);
  assert.equal(summary.vision?.workerP95ExceedsTxFrameInterval, false);
  assert.equal(summary.vision?.conditions?.distanceM, 0.5);
  assert.equal(summary.vision?.conditions?.expectedProfile, "ROBUST");
  assert.equal(summary.vision?.conditions?.prefilterMode, "observe");
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
  assert.equal(legacy.stableCaptures, undefined);
  assert.equal(legacy.stabilityScore, undefined);
  assert.equal(legacy.qualityClassCounts, undefined);
});

test("aggregated optical diagnostics permit a genuinely partial metric set", () => {
  const sample = {
    count: 1,
    average: 4.5,
    min: 4.5,
    max: 4.5,
    p50: 4.5,
    p95: 4.5,
  };
  const optical: NonNullable<VisionExperimentSummary["optical"]> = {
    minimumPixelsPerModule: sample,
  };

  assert.deepEqual(optical, { minimumPixelsPerModule: sample });
  assert.equal("clippedPixelFraction" in optical, false);
});

test("photometric canonical diagnostics aggregate as optional schema-v1 distributions", () => {
  const metrics = new ExperimentMetrics("receive", "COLOR_4", "ROBUST", 0);
  const rail = (
    valid: boolean,
    contrastLuma: number,
    errors = 0,
    uncertainModules = 0,
    modules = 79,
  ) => ({
    valid,
    blackLuma: 50,
    whiteLuma: 50 + contrastLuma,
    thresholdLuma: 50 + contrastLuma / 2,
    contrastLuma,
    errors,
    uncertainModules,
    modules,
  });
  const firstBootstrap = {
    doubleVoteColumns: 20,
    singleVoteColumns: 4,
    uncertainColumns: 0,
    contradictoryColumns: 0,
    minimumDifferentialLuma: 16,
    medianDifferentialLuma: 24,
    // Runtime debug detail must never leak into persisted experiment exports.
    bootstrapBytes: [0xd5, 0x24, 0x07],
    expectedCrc: 0x07,
  };
  metrics.recordAttempt("valid", {
    vision: {
      canonical: {
        bootstrapSampling: firstBootstrap,
        timingUncertainModules: 1,
        timingRails: {
          top: rail(true, 40),
          right: rail(true, 44, 0, 1, 78),
          bottom: rail(true, 48),
          left: rail(true, 52, 0, 0, 78),
        },
      },
    },
  });
  metrics.recordAttempt("rejected", {
    stage: "bootstrap",
    vision: {
      canonical: {
        bootstrapSampling: {
          doubleVoteColumns: 18,
          singleVoteColumns: 3,
          uncertainColumns: 3,
          contradictoryColumns: 1,
          minimumDifferentialLuma: 20,
          medianDifferentialLuma: 28,
        },
        timingUncertainModules: 3,
        timingRails: {
          top: rail(false, -40, 79, 79),
          right: rail(true, 40, 2, 1, 78),
          bottom: rail(true, 42, 1),
          left: rail(true, 46, 1, 0, 78),
        },
      },
    },
  });
  metrics.recordAttempt("rejected", {
    stage: "classification",
    vision: {
      canonical: {
        bestDeltaE: { count: 12, min: 5, p50: 4, p95: 3, max: 2 },
        deltaEGap: { count: 0, min: 1, p50: 1, p95: 1, max: 1 },
        erasuresByShard: Array.from({ length: 257 }, () => 0),
        uncertainCellsByRow: Array.from({ length: 257 }, () => 0),
      },
    },
  });

  const summary = metrics.snapshot({ success: false, now: 1 });
  const canonical = summary.vision?.canonical;
  assert.equal(summary.schemaVersion, 1);
  assert.equal(canonical?.bootstrapSampling?.doubleVoteColumns?.count, 2);
  assert.equal(canonical?.bootstrapSampling?.doubleVoteColumns?.average, 19);
  assert.equal(canonical?.bootstrapSampling?.minimumDifferentialLuma?.min, 16);
  assert.equal(canonical?.bootstrapSampling?.medianDifferentialLuma?.max, 28);
  assert.equal(canonical?.timingUncertainModules?.average, 2);
  assert.equal(canonical?.timingRails?.top?.valid?.average, 0.5);
  assert.equal(canonical?.timingRails?.top?.contrastLuma?.min, -40);
  assert.equal(canonical?.timingRails?.top?.contrastLuma?.average, 0);
  assert.equal(canonical?.timingRails?.right?.uncertainModules?.max, 1);
  assert.equal(canonical?.timingRails?.left?.modules?.p50, 78);
  assert.equal(JSON.stringify(summary).includes("bootstrapBytes"), false);
  assert.equal(JSON.stringify(summary).includes("expectedCrc"), false);
  assert.deepEqual(structuredClone(summary), summary);
});

test("classifier confidence telemetry persists bounded aggregates without payload traces", () => {
  const metrics = new ExperimentMetrics("receive", "COLOR_4", "ROBUST", 0);
  const firstVision = {
    canonical: {
      distanceRejectedCells: 10,
      gapRejectedCells: 12,
      bothRejectedCells: 4,
      erasuresByShard: [2, 3],
      parityByShard: 4,
      remainingErasureBudgetByShard: [2, 1],
      uncertainCellsByRow: [1, 2, 0],
      uncertainCellsByColumn: [1, 2],
      effectiveMaximumDeltaE: 45,
      effectiveMinimumDeltaEGap: 18,
      bestDeltaE: { count: 12, min: 1, p50: 2, p95: 3, max: 4 },
      deltaEGap: { count: 12, min: 0.5, p50: 5, p95: 8, max: 9 },
      // Unknown fields model an accidental rich diagnostic object crossing the
      // browser boundary. ExperimentMetrics must only select its safe contract.
      codedBytes: [0xde, 0xad],
      byteErasures: [1, 7],
      cellIndices: [4, 8],
      payload: [0xbe, 0xef],
      cells: [{ cellIndex: 4, byteIndex: 1, dibit: 3 }],
    },
  } as unknown as NonNullable<BrowserCarrierDiagnostics["vision"]>;
  metrics.recordAttempt("rejected", { stage: "classification", vision: firstVision });
  metrics.recordAttempt("rejected", {
    stage: "classification",
    vision: {
      canonical: {
        distanceRejectedCells: 6,
        gapRejectedCells: 8,
        bothRejectedCells: 2,
        erasuresByShard: [1, 5],
        parityByShard: 4,
        remainingErasureBudgetByShard: [3, -1],
        uncertainCellsByRow: [0, 3, 1],
        uncertainCellsByColumn: [2, 2],
        effectiveMaximumDeltaE: 40,
        effectiveMinimumDeltaEGap: 12,
        bestDeltaE: { count: 12, min: 0.5, p50: 3, p95: 5, max: 6 },
        deltaEGap: { count: 12, min: 1, p50: 6, p95: 9, max: 10 },
      },
    },
  });

  const summary = metrics.snapshot({ success: false, now: 1 });
  const classification = summary.vision?.canonical?.classification;
  assert.equal(summary.schemaVersion, 1);
  assert.deepEqual(classification?.distanceRejectedCells, {
    count: 2,
    average: 8,
    min: 6,
    max: 10,
    p50: 6,
    p95: 6,
  });
  assert.equal(classification?.gapRejectedCells?.average, 10);
  assert.equal(classification?.bothRejectedCells?.max, 4);
  assert.equal(classification?.effectiveMaximumDeltaE?.min, 40);
  assert.equal(classification?.effectiveMinimumDeltaEGap?.max, 18);
  assert.equal(classification?.bestDeltaE?.count?.average, 12);
  assert.equal(classification?.bestDeltaE?.p50?.p50, 2);
  assert.equal(classification?.deltaEGap?.max?.p95, 9);
  assert.equal(classification?.erasuresByShard?.length, 2);
  assert.deepEqual(classification?.erasuresByShard?.[0], {
    count: 2,
    average: 1.5,
    min: 1,
    max: 2,
    p50: 1,
    p95: 1,
  });
  assert.equal(classification?.erasuresByShard?.[1]?.max, 5);
  assert.equal(classification?.remainingErasureBudgetByShard?.[1]?.min, -1);
  assert.equal(classification?.uncertainCellsByRow?.[1]?.average, 2.5);
  assert.equal(classification?.uncertainCellsByColumn?.[0]?.max, 2);
  const serialized = JSON.stringify(summary);
  for (const forbidden of ["codedBytes", "byteErasures", "cellIndices", "payload", "cells"]) {
    assert.equal(serialized.includes(`\"${forbidden}\"`), false);
  }
  assert.deepEqual(structuredClone(summary), summary);
});

test("classifier confidence aggregates reset when the observed profile changes", () => {
  const metrics = new ExperimentMetrics("receive", "COLOR_4", undefined, 0);
  const classification = (
    parityByShard: number,
    erasuresByShard: readonly number[],
    rows: number,
  ): NonNullable<BrowserCarrierDiagnostics["vision"]> => ({
    canonical: {
      parityByShard,
      erasuresByShard,
      remainingErasureBudgetByShard: erasuresByShard.map(
        (count) => parityByShard - count,
      ),
      uncertainCellsByRow: Array.from({ length: rows }, () => 0),
      uncertainCellsByColumn: [0],
      bestDeltaE: { count: rows, min: 1, p50: 2, p95: 3, max: 4 },
      deltaEGap: { count: rows, min: 1, p50: 2, p95: 3, max: 4 },
    },
  });

  metrics.setProfile("ROBUST");
  metrics.recordAttempt("valid", {
    profile: "ROBUST",
    vision: classification(32, [1, 2, 3, 4, 5, 6], 85),
  });
  metrics.setProfile("EXPERIMENTAL");
  metrics.recordAttempt("valid", {
    profile: "EXPERIMENTAL",
    vision: classification(16, Array.from({ length: 14 }, () => 1), 119),
  });

  const summary = metrics.snapshot({ success: false, now: 1 });
  const observed = summary.vision?.canonical?.classification;
  assert.equal(summary.profile, "EXPERIMENTAL");
  assert.deepEqual(observed?.parityByShard, {
    count: 1,
    average: 16,
    min: 16,
    max: 16,
    p50: 16,
    p95: 16,
  });
  assert.equal(observed?.erasuresByShard?.length, 14);
  assert.equal(observed?.erasuresByShard?.every((entry) => entry.count === 1), true);
  assert.equal(observed?.uncertainCellsByRow?.length, 119);
  assert.equal(observed?.uncertainCellsByRow?.every((entry) => entry.count === 1), true);
});

test("capture stability telemetry is bounded and normalized", () => {
  const metrics = new ExperimentMetrics("receive", "COLOR_4", "ROBUST", 0);
  for (let index = 0; index < 300; index++) {
    metrics.recordCapture();
    if (index === 0) metrics.recordStabilityWarmupCapture();
    else if ((index & 1) === 0) metrics.recordStableCapture(index / 1_000);
    else metrics.recordUnstableCapture(index / 1_000);
  }
  metrics.recordCapture();
  metrics.recordStableCapture(Number.NaN);
  metrics.recordCapture();
  metrics.recordUnstableCapture(-1);
  metrics.recordCapture();
  metrics.recordStableCapture(2);
  metrics.recordQualityClass("GOOD");
  metrics.recordQualityClass("GOOD");

  const summary = metrics.snapshot({ success: false, now: 1 });
  assert.equal(summary.stableCaptures, 151);
  assert.equal(summary.unstableCaptures, 151);
  assert.equal(summary.stabilityWarmupCaptures, 1);
  assert.equal(summary.stabilityScore?.count, 256);
  assert.equal(summary.stabilityScore?.min, 0);
  assert.equal(summary.stabilityScore?.max, 1);
  assert.deepEqual(summary.qualityClassCounts, {
    UNKNOWN: 0,
    UNUSABLE: 0,
    BORDERLINE: 0,
    GOOD: 2,
  });
});

test("every capture-first entrypoint activates telemetry without inspecting the carrier", () => {
  const activators: ReadonlyArray<readonly [string, (metrics: ExperimentMetrics) => void]> = [
    ["stable capture", (metrics) => metrics.recordStableCapture()],
    ["unstable capture", (metrics) => metrics.recordUnstableCapture()],
    ["stability warm-up", (metrics) => metrics.recordStabilityWarmupCapture()],
    ["vision submission", (metrics) => metrics.recordVisionSubmission()],
    ["skipped unstable", (metrics) => metrics.recordSkippedUnstable()],
    ["skipped redundant stable", (metrics) => metrics.recordSkippedRedundantStable()],
    ["quality class", (metrics) => metrics.recordQualityClass("UNKNOWN")],
    ["vision context", (metrics) => metrics.setVisionContext({
      debugEnabled: false,
      canonicalScale: 6,
      detectionDimension: 1280,
    })],
  ];

  for (const [name, activate] of activators) {
    const metrics = new ExperimentMetrics("receive", "QR_LEGACY", undefined, 0);
    activate(metrics);
    const summary = metrics.snapshot({ success: false, now: 1 });

    assert.equal("stableCaptures" in summary, true, name);
    assert.equal("unstableCaptures" in summary, true, name);
    assert.equal("stabilityWarmupCaptures" in summary, true, name);
    assert.equal("visionSubmissions" in summary, true, name);
    assert.equal("skippedUnstable" in summary, true, name);
    assert.equal("skippedRedundantStable" in summary, true, name);
    assert.equal("stabilityScore" in summary, true, name);
    assert.equal("qualityClassCounts" in summary, true, name);
  }

  const initialized = new ExperimentMetrics("receive", "COLOR_4", "ROBUST", 0);
  initialized.setVisionContext({
    debugEnabled: false,
    canonicalScale: 6,
    detectionDimension: 1280,
  });
  const summary = initialized.snapshot({ success: false, now: 1 });
  assert.equal(summary.stableCaptures, 0);
  assert.equal(summary.unstableCaptures, 0);
  assert.equal(summary.stabilityWarmupCaptures, 0);
  assert.equal(summary.visionSubmissions, 0);
  assert.equal(summary.skippedUnstable, 0);
  assert.equal(summary.skippedRedundantStable, 0);
  assert.equal(summary.stabilityScore?.count, 0);
  assert.deepEqual(summary.qualityClassCounts, {
    UNKNOWN: 0,
    UNUSABLE: 0,
    BORDERLINE: 0,
    GOOD: 0,
  });
});

test("worker p95 warning uses the expected transmitter-frame interval", () => {
  assert.equal(workerP95ExceedsTxFrameInterval(undefined, 5), false);
  assert.equal(workerP95ExceedsTxFrameInterval(201, undefined), false);
  assert.equal(workerP95ExceedsTxFrameInterval(200, 5), false);
  assert.equal(workerP95ExceedsTxFrameInterval(200.001, 5), true);
  assert.equal(workerP95ExceedsTxFrameInterval(1, 0), false);
  assert.equal(workerP95ExceedsTxFrameInterval(Number.NaN, 5), false);

  const metrics = new ExperimentMetrics("receive", "COLOR_4", "ROBUST", 0);
  metrics.setVisionContext({
    debugEnabled: false,
    canonicalScale: 6,
    detectionDimension: 1280,
    conditions: { expectedTxFps: 5 },
  });
  metrics.recordAttempt("rejected", {
    stage: "geometry",
    vision: { timings: { workerTotal: 201 } },
  });
  assert.equal(
    metrics.snapshot({ success: false, now: 1 }).vision?.workerP95ExceedsTxFrameInterval,
    true,
  );
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
  assert.equal("stableCaptures" in exported.history[0]!, false);
  assert.equal("stabilityScore" in exported.history[0]!, false);
  assert.equal("qualityClassCounts" in exported.history[0]!, false);
  assert.equal("p95" in exported.history[0]!.decodeLatencyMs, false);
  assert.deepEqual(JSON.parse(JSON.stringify(exported)).history[0], storedLegacyRecord);
});
