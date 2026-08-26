import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import test from "node:test";
import {
  CANONICAL_MODULE_SAMPLE_VALUES,
  EXPERIMENTAL_PROFILE,
  createCanonicalModuleSamples,
  decodeCanonicalColor4Raster,
  decodeCanonicalColor4Samples,
  rasterizeColor4,
  type CanonicalModuleSamples,
  type Color4Raster,
} from "../shared/color4/index.ts";

function nextRandom(state: { value: number }): number {
  state.value = (Math.imul(state.value, 1_664_525) + 1_013_904_223) >>> 0;
  return state.value / 0x1_0000_0000;
}

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

  // This benchmark runs in its own serial process so the best-of-N comparison
  // measures the classifier paths instead of contention from the OpenCV tests.
  const rasterBest = Math.min(...rasterDurations);
  const sampleBest = Math.min(...sampleDurations);
  const sampleP50 = percentile(sampleDurations, 0.5);
  const sampleP95 = percentile(sampleDurations, 0.95);
  assert.ok(
    sampleBest <= rasterBest * 0.7,
    `samples best ${sampleBest.toFixed(2)} ms; raster best ${rasterBest.toFixed(2)} ms`,
  );
  context.diagnostic(
    `classifier samples best=${sampleBest.toFixed(2)}ms, p50=${sampleP50.toFixed(2)}ms, ` +
      `p95=${sampleP95.toFixed(2)}ms; legacy raster best=${rasterBest.toFixed(2)}ms; ` +
      `ratio=${(sampleBest / rasterBest).toFixed(2)}`,
  );
});
