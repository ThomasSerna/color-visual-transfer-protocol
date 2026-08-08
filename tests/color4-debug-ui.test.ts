import assert from "node:assert/strict";
import test from "node:test";
import { objectFitCoverProjection } from "../receive/color4-debug-ui.ts";

function closeTo(actual: number, expected: number): void {
  assert.ok(
    Math.abs(actual - expected) < 1e-9,
    `expected ${actual} to be approximately ${expected}`,
  );
}

test("object-fit cover preserves an equal aspect ratio", () => {
  assert.deepEqual(objectFitCoverProjection(1_280, 720, 640, 360), {
    scale: 0.5,
    offsetX: 0,
    offsetY: 0,
  });
});

test("object-fit cover projects a landscape camera into a portrait preview", () => {
  const projection = objectFitCoverProjection(1_920, 1_080, 390, 844);
  const expectedScale = 844 / 1_080;

  closeTo(projection.scale, expectedScale);
  closeTo(projection.offsetX, (390 - 1_920 * expectedScale) / 2);
  closeTo(projection.offsetY, 0);

  // The camera centre stays at the preview centre despite the horizontal crop.
  closeTo(960 * projection.scale + projection.offsetX, 195);
  closeTo(540 * projection.scale + projection.offsetY, 422);
});

test("object-fit cover projects a portrait camera into a landscape preview", () => {
  const projection = objectFitCoverProjection(1_280, 1_920, 1_440, 900);

  assert.deepEqual(projection, {
    scale: 1.125,
    offsetX: 0,
    offsetY: -630,
  });
  closeTo(640 * projection.scale + projection.offsetX, 720);
  closeTo(960 * projection.scale + projection.offsetY, 450);
});

test("object-fit cover returns a safe identity for unavailable dimensions", () => {
  const dimensionSets: ReadonlyArray<readonly [number, number, number, number]> = [
    [0, 1_080, 390, 844],
    [1_920, 0, 390, 844],
    [1_920, 1_080, 0, 844],
    [1_920, 1_080, 390, -1],
  ];
  for (const dimensions of dimensionSets) {
    assert.deepEqual(objectFitCoverProjection(...dimensions), {
      scale: 1,
      offsetX: 0,
      offsetY: 0,
    });
  }
});
