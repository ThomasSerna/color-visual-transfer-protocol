import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyLabCell,
  deltaE76,
  normalizedRgbToLab,
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
