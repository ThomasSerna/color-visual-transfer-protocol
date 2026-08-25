import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import test from "node:test";
import {
  CANONICAL_MODULE_SAMPLE_VALUES,
  COLOR4_PROFILES,
  FIDUCIALS,
  QUIET_MODULES,
  TOTAL_MODULES,
  createCanonicalModuleSamples,
  createPhysicalLayout,
  decodeCanonicalColor4Samples,
  encodePhasePilot,
  guardCanonicalColor4Samples,
  rasterizeColor4,
  type CanonicalModuleSamples,
  type CanonicalRasterDiagnostics,
  type CanonicalRasterStage,
  type Color4Profile,
  type FloatRgb,
  type ModuleRect,
} from "../shared/color4/index.ts";

function deterministicBytes(length: number, seed: number): Uint8Array {
  const out = new Uint8Array(length);
  let state = seed >>> 0;
  for (let index = 0; index < out.length; index++) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    out[index] = state >>> 24;
  }
  return out;
}

function idealSamples(
  profile: Color4Profile,
  paletteId: 0 | 1,
  phase: 0 | 1 | 2 | 3,
): CanonicalModuleSamples {
  const coded = deterministicBytes(profile.codedBytes, profile.id * 31 + paletteId);
  const raster = rasterizeColor4(coded, {
    profile,
    paletteId,
    sequence: phase,
    moduleScale: 1,
  });
  const rgb = new Float32Array(CANONICAL_MODULE_SAMPLE_VALUES);
  let output = 0;
  for (let pixel = 0; pixel < raster.pixels.length; pixel += 4) {
    rgb[output++] = raster.pixels[pixel]!;
    rgb[output++] = raster.pixels[pixel + 1]!;
    rgb[output++] = raster.pixels[pixel + 2]!;
  }
  return createCanonicalModuleSamples(rgb);
}

function cloneSamples(samples: CanonicalModuleSamples): CanonicalModuleSamples {
  return createCanonicalModuleSamples(new Float32Array(samples.rgb));
}

function paintLogical(
  samples: CanonicalModuleSamples,
  logicalX: number,
  logicalY: number,
  rgb: FloatRgb,
): void {
  const offset = (logicalY * samples.width + logicalX) * 3;
  samples.rgb[offset] = rgb[0];
  samples.rgb[offset + 1] = rgb[1];
  samples.rgb[offset + 2] = rgb[2];
}

function paintActive(
  samples: CanonicalModuleSamples,
  activeX: number,
  activeY: number,
  rgb: FloatRgb,
): void {
  paintLogical(samples, activeX + QUIET_MODULES, activeY + QUIET_MODULES, rgb);
}

function paintActiveRect(
  samples: CanonicalModuleSamples,
  rect: ModuleRect,
  rgb: FloatRgb,
): void {
  for (let y = 0; y < rect.height; y++) {
    for (let x = 0; x < rect.width; x++) {
      paintActive(samples, rect.x + x, rect.y + y, rgb);
    }
  }
}

function structuralDiagnostics(diagnostics: CanonicalRasterDiagnostics): unknown {
  return {
    moduleScale: diagnostics.moduleScale,
    fiducialErrors: diagnostics.fiducialErrors,
    fiducialErrorsById: diagnostics.fiducialErrorsById,
    fiducialErrorMax: diagnostics.fiducialErrorMax,
    quietZoneErrors: diagnostics.quietZoneErrors,
    quietZoneLumaErrors: diagnostics.quietZoneLumaErrors,
    quietZoneRgbErrors: diagnostics.quietZoneRgbErrors,
    bootstrapSampling: diagnostics.bootstrapSampling,
    timingErrors: diagnostics.timingErrors,
    timingUncertainModules: diagnostics.timingUncertainModules,
    timingModules: diagnostics.timingModules,
    timingRails: diagnostics.timingRails,
    isiStrength: diagnostics.isiStrength,
    calibrationMad: diagnostics.calibrationMad,
    observedContrast: diagnostics.observedContrast,
    minimumPaletteDistance: diagnostics.minimumPaletteDistance,
  };
}

function assertDecisionParity(name: string, samples: CanonicalModuleSamples): void {
  const decoded = decodeCanonicalColor4Samples(samples);
  const guarded = guardCanonicalColor4Samples(samples);
  assert.deepEqual(
    structuralDiagnostics(guarded.diagnostics),
    structuralDiagnostics(decoded.diagnostics),
    `${name}: structural diagnostics`,
  );
  if (decoded.status === "valid") {
    assert.equal(guarded.status, "valid", name);
    if (guarded.status === "valid") {
      assert.equal(guarded.profile.id, decoded.profile.id, name);
      assert.equal(guarded.paletteId, decoded.paletteId, name);
      assert.equal(guarded.sequencePhase, decoded.sequencePhase, name);
    }
    return;
  }
  if (decoded.reason === "phase_mismatch") {
    assert.equal(guarded.status, "transition", name);
    if (guarded.status === "transition") assert.equal(guarded.reason, decoded.reason, name);
    return;
  }
  assert.equal(guarded.status, "rejected", name);
  if (guarded.status === "rejected") assert.equal(guarded.reason, decoded.reason, name);
}

test("canonical guard matches structural decisions for every profile, palette, and phase", {
  concurrency: false,
}, () => {
  for (const profile of COLOR4_PROFILES) {
    for (const paletteId of [0, 1] as const) {
      for (const phase of [0, 1, 2, 3] as const) {
        assertDecisionParity(
          `${profile.name}/palette-${paletteId}/phase-${phase}`,
          idealSamples(profile, paletteId, phase),
        );
      }
    }
  }
});

test("canonical guard preserves every structural rejection and marks phase conflicts as transitions", {
  concurrency: false,
}, () => {
  const profile = COLOR4_PROFILES[0]!;
  const baseline = idealSamples(profile, 0, 0);
  const layout = createPhysicalLayout(profile);
  const cases: Array<Readonly<{
    name: string;
    samples: CanonicalModuleSamples;
    status: "rejected" | "transition";
    reason: string;
  }>> = [];

  const invalidDimensions = cloneSamples(baseline);
  cases.push({
    name: "dimensions",
    samples: { ...invalidDimensions, width: TOTAL_MODULES - 1 },
    status: "rejected",
    reason: "invalid_dimensions",
  });

  const fiducial = cloneSamples(baseline);
  const marker = FIDUCIALS[0]!;
  paintActiveRect(fiducial, marker, [127, 127, 127]);
  cases.push({
    name: "fiducial",
    samples: fiducial,
    status: "rejected",
    reason: "invalid_geometry",
  });

  const quietZone = cloneSamples(baseline);
  for (let x = 0; x < TOTAL_MODULES; x++) paintLogical(quietZone, x, 3, [0, 0, 0]);
  cases.push({
    name: "quiet-zone",
    samples: quietZone,
    status: "rejected",
    reason: "invalid_geometry",
  });

  const bootstrap = cloneSamples(baseline);
  paintActiveRect(bootstrap, layout.bootstrap, [127, 127, 127]);
  cases.push({
    name: "bootstrap",
    samples: bootstrap,
    status: "rejected",
    reason: "invalid_bootstrap",
  });

  const timing = cloneSamples(baseline);
  paintActiveRect(timing, layout.timing.top, [127, 127, 127]);
  cases.push({
    name: "timing",
    samples: timing,
    status: "rejected",
    reason: "invalid_geometry",
  });

  const calibration = cloneSamples(baseline);
  for (const placement of [...layout.calibration.left, ...layout.calibration.right]) {
    paintActiveRect(calibration, placement, [128, 128, 128]);
  }
  cases.push({
    name: "calibration",
    samples: calibration,
    status: "rejected",
    reason: "calibration_failed",
  });

  const transition = cloneSamples(baseline);
  const differentPilot = encodePhasePilot(1);
  for (let x = 0; x < differentPilot.length; x++) {
    const value = differentPilot[x] === 1 ? 0 : 255;
    paintActive(
      transition,
      layout.phasePilots.top.x + x,
      layout.phasePilots.top.y,
      [value, value, value],
    );
  }
  cases.push({
    name: "phase-transition",
    samples: transition,
    status: "transition",
    reason: "phase_mismatch",
  });

  for (const expected of cases) {
    assertDecisionParity(expected.name, expected.samples);
    const guarded = guardCanonicalColor4Samples(expected.samples);
    assert.equal(guarded.status, expected.status, expected.name);
    assert.equal(guarded.reason, expected.reason, expected.name);
  }

  const decodedTransition = decodeCanonicalColor4Samples(transition);
  const guardedTransition = guardCanonicalColor4Samples(transition);
  assert.equal(decodedTransition.status, "rejected");
  if (decodedTransition.status === "rejected") {
    assert.equal(decodedTransition.reason, "phase_mismatch");
  }
  assert.equal(guardedTransition.status, "transition");
});

test("canonical guard emits structural observations only", { concurrency: false }, () => {
  const stages: CanonicalRasterStage[] = [];
  const samples = idealSamples(COLOR4_PROFILES[0]!, 0, 2);
  const result = guardCanonicalColor4Samples(samples, {
    observerDetail: true,
    observer: (observation) => stages.push(observation.stage),
  });
  assert.equal(result.status, "valid");
  assert.equal("codedBytes" in result, false);
  assert.equal("byteErasures" in result, false);
  assert.deepEqual(stages, ["canonicalGeometry", "bootstrapPhase", "calibration"]);
});

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)]!;
}

test("canonical guard is materially faster than full EXPERIMENTAL classification", {
  concurrency: false,
}, () => {
  const samples = idealSamples(COLOR4_PROFILES[1]!, 0, 3);
  for (let warmup = 0; warmup < 2; warmup++) {
    assert.equal(guardCanonicalColor4Samples(samples).status, "valid");
    assert.equal(decodeCanonicalColor4Samples(samples).status, "valid");
  }

  const guardDurations: number[] = [];
  const decodeDurations: number[] = [];
  for (let measurement = 0; measurement < 7; measurement++) {
    let startedAt = performance.now();
    assert.equal(guardCanonicalColor4Samples(samples).status, "valid");
    guardDurations.push(performance.now() - startedAt);

    startedAt = performance.now();
    assert.equal(decodeCanonicalColor4Samples(samples).status, "valid");
    decodeDurations.push(performance.now() - startedAt);
  }
  // Best-of-N: the minimum is the closest either run gets to the work itself,
  // so a loaded machine cannot invert the comparison.
  const guardBest = Math.min(...guardDurations);
  const decodeBest = Math.min(...decodeDurations);
  assert.ok(
    guardBest <= decodeBest * 0.7,
    `guard best ${guardBest.toFixed(2)} ms (p50 ${median(guardDurations).toFixed(2)}); ` +
      `decode best ${decodeBest.toFixed(2)} ms (p50 ${median(decodeDurations).toFixed(2)})`,
  );
});
