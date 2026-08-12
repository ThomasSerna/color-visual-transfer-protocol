import assert from "node:assert/strict";
import test from "node:test";
import type { CanonicalRasterDiagnostics } from "../shared/color4/classifier.ts";

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
      meanBestDeltaE: 12,
      maximumBestDeltaE: 40,
    } as unknown as CanonicalRasterDiagnostics;

    const mapped = canonicalVisionDiagnostics(diagnostics);

    assert.equal(mapped.timingUncertainModules, 0);
    assert.equal(mapped.timingRails?.right.modules, 78);
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
