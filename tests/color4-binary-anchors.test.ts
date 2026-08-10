import assert from "node:assert/strict";
import test from "node:test";
import {
  MINIMUM_BINARY_CONTRAST,
  createSpatialBinaryAnchorModel,
  createSpatialRgbBinaryAnchorModel,
  type BinaryAnchorsByFiducial,
  type RgbBinaryAnchorsByFiducial,
} from "../shared/color4/binary-anchors.ts";

const SPATIAL_ANCHORS: BinaryAnchorsByFiducial = Object.freeze({
  TL: Object.freeze({ black: 10, white: 100 }),
  TR: Object.freeze({ black: 50, white: 200 }),
  BR: Object.freeze({ black: 90, white: 260 }),
  BL: Object.freeze({ black: 30, white: 150 }),
});

function requireModel(input: BinaryAnchorsByFiducial = SPATIAL_ANCHORS) {
  const model = createSpatialBinaryAnchorModel(input);
  assert.notEqual(model, null);
  return model!;
}

test("spatial binary anchors preserve each fiducial center", () => {
  const model = requireModel();

  assert.deepEqual(model.atActive(11, 11), SPATIAL_ANCHORS.TL);
  assert.deepEqual(model.atActive(148, 11), SPATIAL_ANCHORS.TR);
  assert.deepEqual(model.atActive(148, 148), SPATIAL_ANCHORS.BR);
  assert.deepEqual(model.atActive(11, 148), SPATIAL_ANCHORS.BL);

  // Logical coordinates include the six-module quiet zone.
  assert.deepEqual(model.atLogical(17, 17), SPATIAL_ANCHORS.TL);
  assert.deepEqual(model.atLogical(154, 154), SPATIAL_ANCHORS.BR);
});

test("spatial binary anchors interpolate black and white independently", () => {
  const model = requireModel();

  assert.deepEqual(model.atActive(79.5, 79.5), {
    black: 45,
    white: 177.5,
  });
  assert.deepEqual(model.atActive(79.5, 11), {
    black: 30,
    white: 150,
  });
  assert.deepEqual(model.atActive(79.5, 148), {
    black: 60,
    white: 205,
  });
});

test("spatial binary anchors clamp outside the fiducial-center domain", () => {
  const model = requireModel();

  assert.deepEqual(model.atActive(-1_000, -1_000), SPATIAL_ANCHORS.TL);
  assert.deepEqual(model.atActive(1_000, -1_000), SPATIAL_ANCHORS.TR);
  assert.deepEqual(model.atActive(1_000, 1_000), SPATIAL_ANCHORS.BR);
  assert.deepEqual(model.atActive(-1_000, 1_000), SPATIAL_ANCHORS.BL);

  // The outer logical quiet-zone corners clamp to the corresponding marker.
  assert.deepEqual(model.atLogical(0, 0), SPATIAL_ANCHORS.TL);
  assert.deepEqual(model.atLogical(171, 171), SPATIAL_ANCHORS.BR);
});

test("spatial binary anchors reject non-finite, inverted and low-contrast inputs", () => {
  const invalidPairs = [
    { black: Number.NaN, white: 100 },
    { black: 10, white: Number.POSITIVE_INFINITY },
    { black: 100, white: 100 },
    { black: 101, white: 100 },
    { black: 10, white: 10 + MINIMUM_BINARY_CONTRAST - 0.001 },
  ] as const;

  for (const pair of invalidPairs) {
    const input: BinaryAnchorsByFiducial = {
      ...SPATIAL_ANCHORS,
      TR: pair,
    };
    assert.equal(createSpatialBinaryAnchorModel(input), null, JSON.stringify(pair));
  }

  const exactMinimum: BinaryAnchorsByFiducial = {
    ...SPATIAL_ANCHORS,
    TR: { black: 25, white: 25 + MINIMUM_BINARY_CONTRAST },
  };
  assert.notEqual(createSpatialBinaryAnchorModel(exactMinimum), null);
});

test("spatial RGB anchors interpolate channels independently and reject unordered responses", () => {
  const input: RgbBinaryAnchorsByFiducial = {
    TL: { black: [0, 10, 20], white: [100, 110, 120] },
    TR: { black: [20, 30, 40], white: [140, 150, 160] },
    BR: { black: [60, 70, 80], white: [220, 230, 240] },
    BL: { black: [40, 50, 60], white: [180, 190, 200] },
  };
  const model = createSpatialRgbBinaryAnchorModel(input);
  assert.notEqual(model, null);
  assert.deepEqual(model!.atActive(11, 11), input.TL);
  assert.deepEqual(model!.atActive(79.5, 79.5), {
    black: [30, 40, 50],
    white: [160, 170, 180],
  });
  assert.deepEqual(model!.atLogical(0, 171), input.BL);

  assert.equal(createSpatialRgbBinaryAnchorModel({
    ...input,
    TR: { black: [20, 30, 40], white: [140, 30, 160] },
  }), null);
});
