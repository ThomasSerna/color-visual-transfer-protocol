import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import test from "node:test";
import {
  CANONICAL_MODULE_SAMPLE_VALUES,
  EXPERIMENTAL_PROFILE,
  classifyLabCell,
  createCanonicalModuleSamples,
  decodeCanonicalColor4Raster,
  decodeCanonicalColor4Samples,
  deltaE76,
  normalizedRgbToLab,
  rasterizeColor4,
  type CanonicalModuleSamples,
  type Color4Raster,
  type FloatRgb,
} from "../shared/color4/index.ts";

function referenceClassification(
  sample: FloatRgb,
  centroids: readonly FloatRgb[],
  maximumDeltaE: number,
  minimumGap: number,
) {
  const sampleLab = normalizedRgbToLab(sample);
  const ranked = centroids.map((centroid, dibit) => ({
    dibit,
    distance: deltaE76(sampleLab, normalizedRgbToLab(centroid)),
  })).sort((left, right) => left.distance - right.distance);
  const best = ranked[0]!;
  const second = ranked[1]!;
  return {
    dibit: best.dibit,
    erased: best.distance > maximumDeltaE || second.distance - best.distance < minimumGap,
    bestDeltaE: best.distance,
    secondDeltaE: second.distance,
  };
}

function nextRandom(state: { value: number }): number {
  state.value = (Math.imul(state.value, 1_664_525) + 1_013_904_223) >>> 0;
  return state.value / 0x1_0000_0000;
}

test("squared-distance selection preserves exact COLOR_4 Lab decisions and diagnostics", () => {
  const state = { value: 0x5eed1234 };
  for (let iteration = 0; iteration < 512; iteration++) {
    const rgb = (): FloatRgb => [nextRandom(state), nextRandom(state), nextRandom(state)];
    const sample = rgb();
    const centroids = [rgb(), rgb(), rgb(), rgb()] as const;
    const maximumDeltaE = nextRandom(state) * 50;
    const minimumGap = nextRandom(state) * 20;
    assert.deepEqual(
      classifyLabCell(sample, centroids, maximumDeltaE, minimumGap),
      referenceClassification(sample, centroids, maximumDeltaE, minimumGap),
    );
  }

  // Stable candidate order remains observable when two centroids are identical.
  const tied = [0.25, 0.5, 0.75] as FloatRgb;
  const centroids = [tied, tied, [0, 0, 0], [1, 1, 1]] as const;
  assert.deepEqual(
    classifyLabCell(tied, centroids, 1, 1),
    referenceClassification(tied, centroids, 1, 1),
  );
});

function deterministicBytes(length: number): Uint8Array {
  const state = { value: 0xc0104f34 };
  return Uint8Array.from({ length }, () => Math.floor(nextRandom(state) * 256));
}

function samplesFromScaleOneRaster(raster: Color4Raster): CanonicalModuleSamples {
  assert.equal(raster.moduleScale, 1);
  const rgb = new Float32Array(CANONICAL_MODULE_SAMPLE_VALUES);
  let output = 0;
  for (let pixel = 0; pixel < raster.pixels.length; pixel += 4) {
    rgb[output++] = raster.pixels[pixel]!;
    rgb[output++] = raster.pixels[pixel + 1]!;
    rgb[output++] = raster.pixels[pixel + 2]!;
  }
  return createCanonicalModuleSamples(rgb);
}

function percentile(values: readonly number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor((sorted.length - 1) * fraction)]!;
}

test("compact sample classification meets the 2-warmup/7-run hot-path target", {
  concurrency: false,
}, (context) => {
  const coded = deterministicBytes(EXPERIMENTAL_PROFILE.codedBytes);
  const samples = samplesFromScaleOneRaster(rasterizeColor4(coded, {
    profile: EXPERIMENTAL_PROFILE,
    paletteId: 0,
    sequence: 3,
    moduleScale: 1,
  }));
  const raster = rasterizeColor4(coded, {
    profile: EXPERIMENTAL_PROFILE,
    paletteId: 0,
    sequence: 3,
    moduleScale: 6,
  });

  for (let warmup = 0; warmup < 2; warmup++) {
    assert.equal(decodeCanonicalColor4Raster(raster).status, "valid");
    assert.equal(decodeCanonicalColor4Samples(samples).status, "valid");
  }

  const rasterDurations: number[] = [];
  const sampleDurations: number[] = [];
  for (let measurement = 0; measurement < 7; measurement++) {
    let startedAt = performance.now();
    const rasterResult = decodeCanonicalColor4Raster(raster);
    rasterDurations.push(performance.now() - startedAt);
    assert.equal(rasterResult.status, "valid");

    startedAt = performance.now();
    const sampleResult = decodeCanonicalColor4Samples(samples);
    sampleDurations.push(performance.now() - startedAt);
    assert.equal(sampleResult.status, "valid");
    if (sampleResult.status === "valid" && rasterResult.status === "valid") {
      assert.deepEqual(sampleResult.codedBytes, rasterResult.codedBytes);
      assert.deepEqual(sampleResult.byteErasures, rasterResult.byteErasures);
      assert.deepEqual(
        { ...sampleResult.diagnostics, moduleScale: 0 },
        { ...rasterResult.diagnostics, moduleScale: 0 },
      );
    }
  }

  const rasterP50 = percentile(rasterDurations, 0.5);
  const sampleP50 = percentile(sampleDurations, 0.5);
  const sampleP95 = percentile(sampleDurations, 0.95);
  assert.ok(
    sampleP50 <= rasterP50 * 0.7,
    `samples p50 ${sampleP50.toFixed(2)} ms; raster p50 ${rasterP50.toFixed(2)} ms`,
  );
  assert.ok(
    sampleP95 / sampleP50 <= 1.5,
    `samples p95/p50 ${(sampleP95 / sampleP50).toFixed(2)} ` +
      `(p50 ${sampleP50.toFixed(2)} ms, p95 ${sampleP95.toFixed(2)} ms)`,
  );
  context.diagnostic(
    `classifier samples p50=${sampleP50.toFixed(2)}ms, p95=${sampleP95.toFixed(2)}ms; ` +
      `legacy raster p50=${rasterP50.toFixed(2)}ms; ratio=${(sampleP50 / rasterP50).toFixed(2)}`,
  );
});
