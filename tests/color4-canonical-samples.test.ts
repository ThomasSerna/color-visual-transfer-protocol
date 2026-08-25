import assert from "node:assert/strict";
import test from "node:test";
import {
  CANONICAL_MODULE_SAMPLE_VALUES,
  COLOR4_PROFILES,
  TOTAL_MODULES,
  createCanonicalModuleSamples,
  decodeCanonicalColor4Raster,
  decodeCanonicalColor4Samples,
  rasterizeColor4,
  type CanonicalModuleSamples,
  type Color4Raster,
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

function samplesFromSinglePixelModules(raster: Color4Raster): CanonicalModuleSamples {
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

test("compact canonical samples match ideal raster decoding for every profile, palette, and phase", () => {
  for (const profile of COLOR4_PROFILES) {
    for (const paletteId of [0, 1] as const) {
      const coded = deterministicBytes(profile.codedBytes, profile.id * 17 + paletteId);
      for (const phase of [0, 1, 2, 3] as const) {
        const raster = rasterizeColor4(coded, {
          profile,
          paletteId,
          sequence: phase,
          moduleScale: 1,
        });
        const samples = samplesFromSinglePixelModules(raster);
        const rasterResult = decodeCanonicalColor4Raster(raster);
        const sampleResult = decodeCanonicalColor4Samples(samples);

        assert.deepEqual(sampleResult, rasterResult, `${profile.name}/palette-${paletteId}/phase-${phase}`);
        assert.equal(sampleResult.status, "valid");
        if (sampleResult.status === "valid") {
          assert.deepEqual(sampleResult.codedBytes, coded);
          assert.equal(sampleResult.profile.id, profile.id);
          assert.equal(sampleResult.paletteId, paletteId);
          assert.equal(sampleResult.sequencePhase, phase);
        }
      }
    }
  }
});

test("compact sample construction validates strictly and keeps the transferred view", () => {
  const rgb = new Float32Array(CANONICAL_MODULE_SAMPLE_VALUES);
  const samples = createCanonicalModuleSamples(rgb);
  assert.equal(samples.width, TOTAL_MODULES);
  assert.equal(samples.height, TOTAL_MODULES);
  assert.strictEqual(samples.rgb, rgb);
  assert.equal(Object.isFrozen(samples), true);

  assert.throws(
    () => createCanonicalModuleSamples(new Float32Array(CANONICAL_MODULE_SAMPLE_VALUES - 1)),
    RangeError,
  );
  const offsetView = new Float32Array(
    new ArrayBuffer((CANONICAL_MODULE_SAMPLE_VALUES + 1) * Float32Array.BYTES_PER_ELEMENT),
    Float32Array.BYTES_PER_ELEMENT,
    CANONICAL_MODULE_SAMPLE_VALUES,
  );
  assert.throws(() => createCanonicalModuleSamples(offsetView), RangeError);
  for (const invalid of [Number.NaN, Number.POSITIVE_INFINITY, -1, 255.01]) {
    rgb[0] = invalid;
    assert.throws(() => createCanonicalModuleSamples(rgb), RangeError, String(invalid));
  }
});

test("compact sample decoder rejects malformed dimensions, views, and values", () => {
  const validRgb = new Float32Array(CANONICAL_MODULE_SAMPLE_VALUES);
  const invalidCases: CanonicalModuleSamples[] = [
    { width: TOTAL_MODULES - 1, height: TOTAL_MODULES, rgb: validRgb },
    { width: TOTAL_MODULES, height: TOTAL_MODULES + 1, rgb: validRgb },
    {
      width: TOTAL_MODULES,
      height: TOTAL_MODULES,
      rgb: new Float32Array(CANONICAL_MODULE_SAMPLE_VALUES - 1),
    },
    {
      width: TOTAL_MODULES,
      height: TOTAL_MODULES,
      rgb: new Uint8Array(CANONICAL_MODULE_SAMPLE_VALUES) as unknown as
        Float32Array<ArrayBuffer>,
    },
  ];
  for (const samples of invalidCases) {
    const result = decodeCanonicalColor4Samples(samples);
    assert.equal(result.status, "rejected");
    if (result.status === "rejected") assert.equal(result.reason, "invalid_dimensions");
  }

  const nonFinite = new Float32Array(CANONICAL_MODULE_SAMPLE_VALUES);
  nonFinite[CANONICAL_MODULE_SAMPLE_VALUES - 1] = Number.NaN;
  const result = decodeCanonicalColor4Samples({
    width: TOTAL_MODULES,
    height: TOTAL_MODULES,
    rgb: nonFinite,
  });
  assert.equal(result.status, "rejected");
  if (result.status === "rejected") assert.equal(result.reason, "invalid_dimensions");
});
