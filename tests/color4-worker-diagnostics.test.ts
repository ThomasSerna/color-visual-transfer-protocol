import assert from "node:assert/strict";
import test from "node:test";
import type { CanonicalRasterDiagnostics } from "../shared/color4/classifier.ts";
import type { Color4UnwrapObservation } from "../shared/color4/envelope.ts";

test("worker maps photometric canonical diagnostics without debug bootstrap bytes", async () => {
  const previousSelf = Object.getOwnPropertyDescriptor(globalThis, "self");
  Object.defineProperty(globalThis, "self", {
    configurable: true,
    value: { onmessage: null, postMessage: () => undefined },
  });
  try {
    const { canonicalVisionDiagnostics } = await import("../receive/color4-worker.ts");
    const diagnostics = {
      moduleScale: 6,
      fiducialErrors: 0,
      fiducialErrorsById: { TL: 0, TR: 0, BR: 0, BL: 0 },
      fiducialErrorMax: 0,
      quietZoneErrors: 0,
      quietZoneLumaErrors: 0,
      quietZoneRgbErrors: 0,
      bootstrapSampling: {
        doubleVoteColumns: 20,
        singleVoteColumns: 4,
        uncertainColumns: 0,
        contradictoryColumns: 0,
        minimumDifferentialLuma: 16,
        medianDifferentialLuma: 23,
        bootstrapBytes: [0xd5, 0x24, 0x07],
        expectedCrc: 0x07,
        observedCrc: 0x07,
      },
      timingErrors: 0,
      timingUncertainModules: 0,
      timingModules: 314,
      timingRails: {
        top: rail(79),
        right: rail(78),
        bottom: rail(79),
        left: rail(78),
      },
      calibrationMad: 2,
      observedContrast: 120,
      minimumPaletteDistance: 30,
      uncertainCells: 219,
      erasureBytes: 195,
      distanceRejectedCells: 40,
      gapRejectedCells: 196,
      bothRejectedCells: 17,
      erasuresByShard: [26, 35, 29, 34, 34, 37],
      parityByShard: 32,
      remainingErasureBudgetByShard: [6, -3, 3, -2, -2, -5],
      uncertainCellsByRow: [1, 2, 3],
      uncertainCellsByColumn: [4, 5, 6],
      effectiveMaximumDeltaE: 45,
      effectiveMinimumDeltaEGap: 17.5,
      bestDeltaE: { count: 6_120, min: 1, p50: 10, p95: 30, max: 40 },
      deltaEGap: { count: 6_120, min: 0.5, p50: 25, p95: 60, max: 80 },
      erasureCandidateScore: { count: 195, min: 1.01, p50: 1.2, p95: 2.1, max: 3 },
      meanBestDeltaE: 12,
      maximumBestDeltaE: 40,
    } as unknown as CanonicalRasterDiagnostics;

    const mapped = canonicalVisionDiagnostics(diagnostics);

    assert.equal(mapped.timingUncertainModules, 0);
    assert.equal(mapped.timingRails?.right.modules, 78);
    assert.deepEqual(mapped.erasuresByShard, [26, 35, 29, 34, 34, 37]);
    assert.deepEqual(mapped.remainingErasureBudgetByShard, [6, -3, 3, -2, -2, -5]);
    assert.deepEqual(mapped.bestDeltaE, diagnostics.bestDeltaE);
    assert.deepEqual(mapped.deltaEGap, diagnostics.deltaEGap);
    assert.deepEqual(mapped.erasureCandidateScore, diagnostics.erasureCandidateScore);
    assert.notStrictEqual(mapped.erasuresByShard, diagnostics.erasuresByShard);
    assert.notStrictEqual(mapped.uncertainCellsByRow, diagnostics.uncertainCellsByRow);
    assert.notStrictEqual(mapped.bestDeltaE, diagnostics.bestDeltaE);
    assert.notStrictEqual(mapped.erasureCandidateScore, diagnostics.erasureCandidateScore);
    assert.deepEqual(mapped.bootstrapSampling, {
      doubleVoteColumns: 20,
      singleVoteColumns: 4,
      uncertainColumns: 0,
      contradictoryColumns: 0,
      minimumDifferentialLuma: 16,
      medianDifferentialLuma: 23,
    });
    assert.equal(JSON.stringify(mapped).includes("bootstrapBytes"), false);
    assert.equal(JSON.stringify(mapped).includes("Crc"), false);
    assert.deepEqual(structuredClone(mapped), mapped);

    const preTiming = canonicalVisionDiagnostics({
      ...diagnostics,
      timingUncertainModules: 0,
      timingRails: undefined,
    });
    assert.equal("timingUncertainModules" in preTiming, false);
    assert.equal("timingRails" in preTiming, false);

    const preClassification = canonicalVisionDiagnostics({
      ...diagnostics,
      distanceRejectedCells: 0,
      gapRejectedCells: 0,
      bothRejectedCells: 0,
      erasuresByShard: [],
      parityByShard: 0,
      remainingErasureBudgetByShard: [],
      uncertainCellsByRow: [],
      uncertainCellsByColumn: [],
      effectiveMaximumDeltaE: 0,
      effectiveMinimumDeltaEGap: 0,
      bestDeltaE: { count: 0, min: 0, p50: 0, p95: 0, max: 0 },
      deltaEGap: { count: 0, min: 0, p50: 0, p95: 0, max: 0 },
      erasureCandidateScore: { count: 0, min: 0, p50: 0, p95: 0, max: 0 },
    });
    assert.equal("distanceRejectedCells" in preClassification, false);
    assert.equal("erasuresByShard" in preClassification, false);
    assert.equal("bestDeltaE" in preClassification, false);
    assert.equal("erasureCandidateScore" in preClassification, false);
  } finally {
    if (previousSelf === undefined) delete (globalThis as { self?: unknown }).self;
    else Object.defineProperty(globalThis, "self", previousSelf);
  }
});

function rail(modules: number) {
  return {
    valid: true,
    blackLuma: 40,
    whiteLuma: 100,
    thresholdLuma: 70,
    contrastLuma: 60,
    errors: 0,
    uncertainModules: 0,
    modules,
  };
}

test("worker exposes bounded erasure attempts and retains original saturation diagnosis", async () => {
  const previousSelf = Object.getOwnPropertyDescriptor(globalThis, "self");
  Object.defineProperty(globalThis, "self", {
    configurable: true,
    value: { onmessage: null, postMessage: () => undefined },
  });
  try {
    const {
      color4ErasurePolicyDiagnostics,
      color4FecDiagnosticReason,
    } = await import("../receive/color4-worker.ts");
    const rejected = { status: "rejected", reason: "fec-uncorrectable" };
    const valid = { status: "valid" };
    const policy = {
      result: valid,
      selectedPolicy: "hard-decision",
      selectedBudgetFraction: 0,
      selectedMaxErasuresPerShard: 0,
      selectedErasures: new Uint16Array(),
      selectedObservations: [],
      suggestedErasuresByShard: [26, 35, 29, 34, 34, 37],
      saturatedErasureShards: [1, 3, 4, 5],
      attempts: [
        {
          policy: "classifier-budgeted",
          budgetFraction: 1,
          maxErasuresPerShard: 32,
          erasures: new Uint16Array(183),
          erasuresByShard: [26, 32, 29, 32, 32, 32],
          durationMs: 2.5,
          observations: [],
          result: rejected,
        },
        {
          policy: "hard-decision",
          budgetFraction: 0,
          maxErasuresPerShard: 0,
          erasures: new Uint16Array(),
          erasuresByShard: [0, 0, 0, 0, 0, 0],
          phaseMatched: true,
          durationMs: 1.5,
          observations: [],
          result: valid,
        },
      ],
    } as unknown as Parameters<typeof color4ErasurePolicyDiagnostics>[0];

    const diagnostics = color4ErasurePolicyDiagnostics(policy);
    assert.deepEqual(diagnostics, {
      erasurePolicy: "hard-decision",
      selectedBudgetFraction: 0,
      selectedMaxErasuresPerShard: 0,
      selectedErasuresByShard: [0, 0, 0, 0, 0, 0],
      suggestedErasuresByShard: [26, 35, 29, 34, 34, 37],
      saturatedErasureShards: [1, 3, 4, 5],
      unwrapAttempts: [
        {
          policy: "classifier-budgeted",
          budgetFraction: 1,
          maxErasuresPerShard: 32,
          erasures: 183,
          erasuresByShard: [26, 32, 29, 32, 32, 32],
          durationMs: 2.5,
          status: "rejected",
          reason: "fec-uncorrectable",
        },
        {
          policy: "hard-decision",
          budgetFraction: 0,
          maxErasuresPerShard: 0,
          erasures: 0,
          erasuresByShard: [0, 0, 0, 0, 0, 0],
          phaseMatched: true,
          durationMs: 1.5,
          status: "valid",
        },
      ],
    });
    assert.deepEqual(structuredClone(diagnostics), diagnostics);

    const locatorObservation = [{
      stage: "rs",
      shards: [{ reason: "locator" }],
    }] as unknown as readonly Color4UnwrapObservation[];
    assert.equal(
      color4FecDiagnosticReason("fec-uncorrectable", locatorObservation),
      "RS_FAILED",
    );
    assert.equal(
      color4FecDiagnosticReason("fec-uncorrectable", locatorObservation, [1, 3, 4, 5]),
      "COLOR_CLASSIFICATION_TOO_UNCERTAIN",
    );
  } finally {
    if (previousSelf === undefined) delete (globalThis as { self?: unknown }).self;
    else Object.defineProperty(globalThis, "self", previousSelf);
  }
});
