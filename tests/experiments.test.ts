import assert from "node:assert/strict";
import test from "node:test";
import {
  estimatePipelineCapacityFps,
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
        timings: { contours: index, tracking: index, classifier: index },
      },
    });
  }
  const vision = metrics.snapshot({ success: false, now: 1 }).vision!;
  assert.equal(vision.timingsMs.contours?.count, 256);
  assert.equal(vision.timingsMs.contours?.min, 44);
  assert.equal(vision.timingsMs.contours?.max, 299);
  assert.equal(vision.timingsMs.tracking?.count, 256);
  assert.equal(vision.timingsMs.tracking?.min, 44);
  assert.equal(vision.timingsMs.classifier?.p95, 286);
  assert.equal(vision.rejectReasons.ONLY_3_FIDUCIALS, 300);
  assert.equal(metrics.snapshot({ success: false, now: 1 }).erasureBytesPerAttempt?.count, 256);

  const legacy = new ExperimentMetrics("receive", "QR_LEGACY", undefined, 0)
    .snapshot({ success: false, now: 1 });
  assert.equal(legacy.vision, undefined);
  assert.equal(legacy.stableCaptures, undefined);
  assert.equal(legacy.stabilityScore, undefined);
  assert.equal(legacy.qualityClassCounts, undefined);
  assert.equal("color4ErasurePolicy" in legacy, false);
});

test("QR experiments reject policy-shaped optional-carrier diagnostics", () => {
  const metrics = new ExperimentMetrics("receive", "QR_LEGACY", undefined, 0);
  metrics.recordAttempt("valid", {
    erasurePolicy: "hard-decision",
    selectedBudgetFraction: 0,
    selectedMaxErasuresPerShard: 0,
    selectedErasuresByShard: [0],
    unwrapAttempts: [{
      policy: "hard-decision",
      budgetFraction: 0,
      maxErasuresPerShard: 0,
      erasures: 0,
      erasuresByShard: [0],
      phaseMatched: true,
      durationMs: 1,
      status: "valid",
    }],
  });

  const summary = metrics.snapshot({ success: true, now: 1 });
  assert.equal(summary.color4ErasurePolicy, undefined);
  assert.equal(JSON.stringify(summary).includes("hard-decision"), false);
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
        erasureCandidateScore: { count: 2, min: 2, p50: 1, p95: 3, max: 4 },
        erasuresByShard: Array.from({ length: 257 }, () => 0),
        uncertainCellsByRow: Array.from({ length: 257 }, () => 0),
      },
    },
  });

  const summary = metrics.snapshot({ success: false, now: 1 });
  const canonical = summary.vision?.canonical;
  assert.equal(summary.schemaVersion, 2);
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
      erasureCandidateScore: { count: 5, min: 1, p50: 1.2, p95: 2, max: 2.5 },
      // Unknown fields model an accidental rich diagnostic object crossing the
      // browser boundary. ExperimentMetrics must only select its safe contract.
      codedBytes: [0xde, 0xad],
      byteErasures: [1, 7],
      byteErasureCandidates: [{ index: 1, score: 2.5 }],
      erasureCandidates: [{ index: 7, score: 2 }],
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
        erasureCandidateScore: { count: 3, min: 0.8, p50: 1.4, p95: 2.4, max: 3 },
      },
    },
  });

  const summary = metrics.snapshot({ success: false, now: 1 });
  const classification = summary.vision?.canonical?.classification;
  assert.equal(summary.schemaVersion, 2);
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
  assert.deepEqual(classification?.erasureCandidateScore?.count, {
    count: 2,
    average: 4,
    min: 3,
    max: 5,
    p50: 3,
    p95: 3,
  });
  assert.equal(classification?.erasureCandidateScore?.max?.p95, 2.5);
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
  for (const forbidden of [
    "codedBytes",
    "byteErasures",
    "byteErasureCandidates",
    "erasureCandidates",
    "cellIndices",
    "payload",
    "cells",
  ]) {
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
      erasureCandidateScore: { count: 1, min: 1, p50: 1, p95: 1, max: 1 },
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
  assert.equal(observed?.erasureCandidateScore?.count?.count, 1);
});

test("COLOR_4 erasure-policy telemetry persists only bounded aggregate counts", () => {
  const metrics = new ExperimentMetrics("receive", "COLOR_4", "ROBUST", 0);
  metrics.recordAttempt("valid", {
    erasurePolicy: "classifier-budgeted",
    selectedBudgetFraction: 0.75,
    selectedMaxErasuresPerShard: 24,
    selectedErasuresByShard: [24, 0, 1, 2, 3, 4],
    unwrapAttempts: [
      {
        policy: "classifier-budgeted",
        budgetFraction: 1,
        maxErasuresPerShard: 32,
        erasures: 32,
        erasuresByShard: [32, 0, 0, 0, 0, 0],
        phaseMatched: false,
        durationMs: 4,
        status: "valid",
      },
      {
        policy: "classifier-budgeted",
        budgetFraction: 0.75,
        maxErasuresPerShard: 24,
        erasures: 24,
        erasuresByShard: [24, 0, 0, 0, 0, 0],
        durationMs: 3,
        status: "valid",
      },
      {
        policy: "classifier-budgeted",
        budgetFraction: 0.5,
        maxErasuresPerShard: 16,
        erasures: 16,
        erasuresByShard: [16, 0, 0, 0, 0, 0],
        durationMs: 1,
        status: "rejected",
        reason: "fec-uncorrectable",
      },
      {
        policy: "hard-decision",
        budgetFraction: 0,
        maxErasuresPerShard: 0,
        erasures: 0,
        erasuresByShard: [0, 0, 0, 0, 0, 0],
        durationMs: 0,
        status: "rejected",
        reason: "crc-mismatch",
      },
    ],
    // Model accidental worker-private fields crossing the browser boundary.
    erasureCandidates: [{ index: 7, score: 9 }],
    suggestedErasuresByShard: [26, 33, 29, 34, 40, 33],
    selectedErasureIndices: [7],
    codedBytes: [0xde, 0xad],
    payload: "policy-private-payload",
  } as unknown as BrowserCarrierDiagnostics);
  metrics.recordAttempt("rejected", {
    erasurePolicy: "hard-decision",
    selectedBudgetFraction: 0,
    selectedMaxErasuresPerShard: 0,
    selectedErasuresByShard: Array.from({ length: 14 }, () => 0),
    unwrapAttempts: [
      {
        policy: "hard-decision",
        budgetFraction: 0,
        maxErasuresPerShard: 0,
        erasures: 0,
        erasuresByShard: Array.from({ length: 14 }, () => 0),
        phaseMatched: true,
        durationMs: 2,
        status: "rejected",
        reason: "crc-mismatch",
        byteErasures: [11],
        innerFrame: [0xbe, 0xef],
      },
    ],
  } as unknown as BrowserCarrierDiagnostics);

  const summary = metrics.snapshot({ success: false, now: 1 });
  const policy = summary.color4ErasurePolicy;
  assert.equal(summary.schemaVersion, 2);
  assert.deepEqual(policy?.selectedPolicies, {
    "classifier-budgeted": 1,
    "hard-decision": 1,
  });
  assert.deepEqual(policy?.selectedBudgetFraction, {
    count: 2,
    average: 0.375,
    min: 0,
    max: 0.75,
    p50: 0,
    p95: 0,
  });
  assert.equal(policy?.selectedMaxErasuresPerShard?.average, 12);
  assert.equal(policy?.selectedErasuresByShard?.length, 14);
  assert.equal(policy?.selectedErasuresByShard?.[0]?.average, 12);
  assert.equal(policy?.selectedErasuresByShard?.[6]?.count, 1);
  assert.equal(policy?.attemptsPerFrame?.average, 2.5);
  assert.equal(policy?.attempts?.length, 4);
  assert.deepEqual(policy?.attempts?.[0]?.policies, {
    "classifier-budgeted": 1,
    "hard-decision": 1,
  });
  assert.deepEqual(policy?.attempts?.[0]?.statuses, { valid: 1, rejected: 1 });
  assert.deepEqual(policy?.attempts?.[0]?.phases, { mismatched: 1, matched: 1 });
  assert.equal(policy?.attempts?.[0]?.budgetFraction?.average, 0.5);
  assert.equal(policy?.attempts?.[0]?.maxErasuresPerShard?.average, 16);
  assert.equal(policy?.attempts?.[0]?.erasures?.average, 16);
  assert.equal(policy?.attempts?.[0]?.durationMs?.average, 3);
  assert.equal(policy?.attempts?.[0]?.erasuresByShard?.length, 14);
  assert.equal(policy?.attempts?.[0]?.erasuresByShard?.[0]?.average, 16);
  assert.deepEqual(policy?.attempts?.[0]?.rejectReasons, { "crc-mismatch": 1 });
  assert.deepEqual(policy?.attempts?.[1]?.policies, { "classifier-budgeted": 1 });
  assert.deepEqual(policy?.attempts?.[1]?.phases, { unknown: 1 });

  const serialized = JSON.stringify(summary);
  for (const forbidden of [
    "erasureCandidates",
    "suggestedErasuresByShard",
    "selectedErasureIndices",
    "byteErasures",
    "codedBytes",
    "innerFrame",
    "policy-private-payload",
  ]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
  assert.deepEqual(structuredClone(summary), summary);
});

test("COLOR_4 erasure-policy telemetry rejects invalid and over-limit detail", () => {
  const overLimit = new ExperimentMetrics("receive", "COLOR_4", "ROBUST", 0);
  overLimit.recordAttempt("rejected", {
    erasurePolicy: "private-policy",
    selectedBudgetFraction: Number.NaN,
    selectedMaxErasuresPerShard: -1,
    selectedErasuresByShard: Array.from({ length: 15 }, () => 0),
    unwrapAttempts: Array.from({ length: 5 }, () => ({
      policy: "private-policy",
      payload: "private-over-limit-payload",
    })),
  } as unknown as BrowserCarrierDiagnostics);
  const ignored = overLimit.snapshot({ success: false, now: 1 });
  assert.equal(ignored.color4ErasurePolicy, undefined);
  assert.equal(JSON.stringify(ignored).includes("private-over-limit-payload"), false);

  const invalid = new ExperimentMetrics("receive", "COLOR_4", "ROBUST", 0);
  invalid.recordAttempt("rejected", {
    erasurePolicy: "private-policy",
    selectedBudgetFraction: Number.POSITIVE_INFINITY,
    selectedMaxErasuresPerShard: -1,
    selectedErasuresByShard: [0, -1],
    unwrapAttempts: [{
      policy: "private-attempt-policy",
      budgetFraction: Number.NaN,
      maxErasuresPerShard: -1,
      erasures: Number.POSITIVE_INFINITY,
      erasuresByShard: Array.from({ length: 15 }, () => 0),
      phaseMatched: "private-phase",
      durationMs: -1,
      status: "private-status",
      reason: "private-reject-reason",
      candidateIndices: [1, 2, 3],
      payload: "private-attempt-payload",
    }],
  } as unknown as BrowserCarrierDiagnostics);
  const invalidSummary = invalid.snapshot({ success: false, now: 1 });
  const policy = invalidSummary.color4ErasurePolicy;
  assert.equal(policy, undefined);
  const serialized = JSON.stringify(invalidSummary);
  for (const forbidden of [
    "private-policy",
    "private-attempt-policy",
    "private-phase",
    "private-status",
    "private-reject-reason",
    "candidateIndices",
    "private-attempt-payload",
  ]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});

test("COLOR_4 erasure-policy numeric reservoirs stay bounded to 256 samples", () => {
  const metrics = new ExperimentMetrics("receive", "COLOR_4", "ROBUST", 0);
  for (let index = 0; index < 300; index++) {
    metrics.recordAttempt("valid", {
      erasurePolicy: "classifier-budgeted",
      selectedBudgetFraction: 1,
      selectedMaxErasuresPerShard: index,
      selectedErasuresByShard: [index],
      unwrapAttempts: [{
        policy: "classifier-budgeted",
        budgetFraction: 1,
        maxErasuresPerShard: index,
        erasures: index,
        erasuresByShard: [index],
        phaseMatched: true,
        durationMs: index,
        status: "valid",
      }],
    });
  }

  const policy = metrics.snapshot({ success: true, now: 1 }).color4ErasurePolicy;
  assert.equal(policy?.selectedPolicies["classifier-budgeted"], 300);
  assert.equal(policy?.selectedMaxErasuresPerShard?.count, 256);
  assert.equal(policy?.selectedMaxErasuresPerShard?.min, 44);
  assert.equal(policy?.selectedMaxErasuresPerShard?.max, 299);
  assert.equal(policy?.selectedErasuresByShard?.[0]?.count, 256);
  assert.equal(policy?.attemptsPerFrame?.count, 256);
  assert.equal(policy?.attempts?.[0]?.durationMs?.count, 256);
  assert.equal(policy?.attempts?.[0]?.durationMs?.min, 44);
  assert.equal(policy?.attempts?.[0]?.durationMs?.max, 299);
  assert.equal(policy?.attempts?.[0]?.erasuresByShard?.[0]?.count, 256);
  assert.equal(policy?.attempts?.[0]?.policies["classifier-budgeted"], 300);
  assert.equal(policy?.attempts?.[0]?.phases.matched, 300);
});

test("COLOR_4 erasure-policy aggregates reset when the observed profile changes", () => {
  const metrics = new ExperimentMetrics("receive", "COLOR_4", "ROBUST", 0);
  const recordPolicy = (
    profile: "ROBUST" | "EXPERIMENTAL",
    maxErasuresPerShard: number,
    shardCount: number,
  ): void => {
    metrics.setProfile(profile);
    metrics.recordAttempt("valid", {
      profile,
      erasurePolicy: "classifier-budgeted",
      selectedBudgetFraction: 1,
      selectedMaxErasuresPerShard: maxErasuresPerShard,
      selectedErasuresByShard: Array.from({ length: shardCount }, () => 1),
      unwrapAttempts: [{
        policy: "classifier-budgeted",
        budgetFraction: 1,
        maxErasuresPerShard,
        erasures: shardCount,
        erasuresByShard: Array.from({ length: shardCount }, () => 1),
        phaseMatched: true,
        durationMs: 1,
        status: "valid",
      }],
    });
  };

  recordPolicy("ROBUST", 32, 6);
  recordPolicy("EXPERIMENTAL", 16, 14);
  const experimental = metrics.snapshot({ success: true, now: 1 });
  assert.equal(experimental.profile, "EXPERIMENTAL");
  assert.deepEqual(experimental.color4ErasurePolicy?.selectedPolicies, {
    "classifier-budgeted": 1,
  });
  assert.deepEqual(experimental.color4ErasurePolicy?.selectedMaxErasuresPerShard, {
    count: 1,
    average: 16,
    min: 16,
    max: 16,
    p50: 16,
    p95: 16,
  });
  assert.equal(experimental.color4ErasurePolicy?.selectedErasuresByShard?.length, 14);
  assert.equal(experimental.color4ErasurePolicy?.attempts?.[0]?.erasures?.average, 14);
  assert.equal(
    experimental.color4ErasurePolicy?.attempts?.[0]?.maxErasuresPerShard?.average,
    16,
  );

  recordPolicy("ROBUST", 32, 6);
  const robust = metrics.snapshot({ success: true, now: 2 });
  assert.equal(robust.profile, "ROBUST");
  assert.equal(robust.color4ErasurePolicy?.selectedPolicies["classifier-budgeted"], 1);
  assert.equal(robust.color4ErasurePolicy?.selectedMaxErasuresPerShard?.average, 32);
  assert.equal(robust.color4ErasurePolicy?.selectedErasuresByShard?.length, 6);
  assert.equal(robust.color4ErasurePolicy?.attempts?.[0]?.erasures?.average, 6);
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

test("schema-v2 temporal telemetry is bounded, whitelisted and derives throughput", () => {
  const metrics = new ExperimentMetrics("receive", "COLOR_4", "EXPERIMENTAL", 0);
  metrics.recordCapturePath("bitmap");
  metrics.recordCapturePath("bitmap");
  metrics.recordCapturePath("rgba");
  metrics.recordCapturePath("private-camera-name" as never);
  metrics.recordCaptureReservation();
  metrics.recordCaptureReservation();
  metrics.recordCaptureReservationCancelled();
  metrics.recordCaptureDrop("classifier-busy");
  metrics.recordCaptureDrop("bitmap-failed");
  metrics.recordCaptureDrop("private-drop-detail" as never);
  metrics.recordGeometryPath("cold");
  metrics.recordGeometryPath("tracked");
  metrics.recordGeometryPath("tracked");
  metrics.recordGeometryPath("fallback");
  metrics.recordGeometryPath("legacy");
  metrics.recordGeometryPath("private-path" as never);
  metrics.recordLegacyFallbacks({ probes: 2, holds: 1 });
  metrics.recordLegacyFallbacks({ probes: -1, holds: 1 });
  metrics.recordTransition();
  metrics.setWorkerCounts({ geometry: 1, classifier: 2 });
  metrics.setWorkerCounts({ geometry: 0, classifier: 99 });
  metrics.recordWorkerRestart("geometry");
  metrics.recordWorkerRestart("classifier");
  metrics.recordWorkerRestart("private-worker" as never);
  metrics.recordNewFrame(10, 1_200);
  metrics.recordNewFrame(11, 1_000);
  metrics.recordNewFrame(12, 1_100);
  metrics.recordNewFrame(12, 9_000);
  metrics.recordNewFrame(Number.NaN, 1_300);
  metrics.recordAttempt("valid", {
    vision: {
      timings: {
        tracking: 20,
        sampling: 45,
        guard: 5,
        geometryTotal: 80,
        classifier: 160,
      },
    },
  });

  const summary = metrics.snapshot({ success: true, now: 2_000, newFrames: 3 });
  assert.equal(summary.schemaVersion, 2);
  assert.deepEqual(summary.temporalPipeline, {
    capturePaths: { bitmap: 2, rgba: 1 },
    reservations: 2,
    reservationCancellations: 1,
    drops: { "classifier-busy": 1, "bitmap-failed": 1 },
    coldAcquisitions: 1,
    trackedFrames: 2,
    trackingFallbacks: 1,
    legacyFrames: 1,
    legacyProbes: 2,
    legacyHolds: 1,
    transitions: 1,
    geometryWorkers: 1,
    classifierWorkers: 2,
    geometryUtilization: 0.04,
    classifierUtilization: 0.04,
    geometryWorkerRestarts: 1,
    classifierWorkerRestarts: 1,
  });
  assert.equal(summary.vision?.timingsMs.tracking?.p95, 20);
  assert.equal(summary.vision?.timingsMs.sampling?.p95, 45);
  assert.equal(summary.vision?.timingsMs.guard?.p95, 5);
  assert.equal(summary.vision?.timingsMs.classifier?.p95, 160);
  assert.equal(summary.newFramesPerSecond, 10);
  assert.equal(summary.estimatedCapacityFps, 12.5);
  const serialized = JSON.stringify(summary);
  assert.equal(serialized.includes("captureSequence"), false);
  assert.equal(serialized.includes("private-"), false);
});

test("pipeline capacity stays optional for incomplete or invalid measurements", () => {
  assert.equal(estimatePipelineCapacityFps(80, 160, 2), 12.5);
  assert.equal(estimatePipelineCapacityFps(undefined, 160, 2), undefined);
  assert.equal(estimatePipelineCapacityFps(80, undefined, 2), undefined);
  assert.equal(estimatePipelineCapacityFps(0, 160, 2), undefined);
  assert.equal(estimatePipelineCapacityFps(80, Number.NaN, 2), undefined);
  assert.equal(estimatePipelineCapacityFps(80, 160, 0), undefined);

  const metrics = new ExperimentMetrics("receive", "COLOR_4", "EXPERIMENTAL", 0);
  metrics.recordNewFrame(1, 100);
  const summary = metrics.snapshot({ success: false, now: 200, newFrames: 1 });
  assert.equal("newFramesPerSecond" in summary, false);
  assert.equal("estimatedCapacityFps" in summary, false);
  assert.equal(summary.temporalPipeline, undefined);
});

test("experiment export has a pinned, portable v2 envelope", () => {
  const exported = makeExperimentExport([], undefined, new Date("2026-08-08T12:00:00Z"));
  assert.deepEqual(exported, {
    schema: "decimen-experiment-export",
    version: 2,
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

  assert.equal(exported.version, 2);
  assert.equal(exported.history[0], legacy);
  assert.equal("vision" in exported.history[0]!, false);
  assert.equal("stableCaptures" in exported.history[0]!, false);
  assert.equal("stabilityScore" in exported.history[0]!, false);
  assert.equal("qualityClassCounts" in exported.history[0]!, false);
  assert.equal("color4ErasurePolicy" in exported.history[0]!, false);
  assert.equal("p95" in exported.history[0]!.decodeLatencyMs, false);
  assert.deepEqual(JSON.parse(JSON.stringify(exported)).history[0], storedLegacyRecord);
});
