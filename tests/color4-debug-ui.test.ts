import assert from "node:assert/strict";
import test from "node:test";
import {
  encodeColor4SnapshotJson,
  objectFitCoverProjection,
} from "../receive/color4-debug-ui.ts";

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

test("snapshot JSON preserves aggregate classifier diagnostics and omits bootstrap bytes", () => {
  const record = {
    diagnostics: {
      classifier: [{
        stage: "classification",
        bootstrapBytes: [0xd5, 0x24, 0x07],
        bootstrapCrc: { expected: 0x07, observed: 0x07 },
        cells: [{
          cellIndex: 16,
          byteIndex: 4,
          dibitIndex: 0,
          dibit: 3,
          bestDeltaE: 22,
        }],
        diagnostics: {
          bootstrapSampling: {
            doubleVoteColumns: 24,
            minimumDifferentialLuma: 47.7157,
          },
          distanceRejectedCells: 124,
          gapRejectedCells: 196,
          bothRejectedCells: 101,
          erasuresByShard: [26, 35, 29, 34, 34, 37],
          parityByShard: 32,
          remainingErasureBudgetByShard: [6, -3, 3, -2, -2, -5],
          uncertainCellsByRow: [1, 2, 3],
          uncertainCellsByColumn: [3, 3],
          effectiveMaximumDeltaE: 45,
          effectiveMinimumDeltaEGap: 18.02,
          bestDeltaE: { count: 6_120, min: 0, p50: 8, p95: 44, max: 79 },
          deltaEGap: { count: 6_120, min: 0, p50: 31, p95: 65, max: 90 },
        },
      }],
      nested: {
        bootstrapBytes: [1, 2, 3],
        bootstrapCrc: { expected: 1, observed: 2 },
      },
    },
  };
  const before = structuredClone(record);

  const encoded = encodeColor4SnapshotJson(record);
  const persisted = JSON.parse(new TextDecoder().decode(encoded)) as typeof record;

  assert.equal(JSON.stringify(persisted).includes("bootstrapBytes"), false);
  assert.equal(JSON.stringify(persisted).includes("bootstrapCrc"), false);
  assert.deepEqual(
    persisted.diagnostics.classifier[0]?.diagnostics.bootstrapSampling,
    record.diagnostics.classifier[0]?.diagnostics.bootstrapSampling,
  );
  assert.deepEqual(
    persisted.diagnostics.classifier[0]?.diagnostics.erasuresByShard,
    record.diagnostics.classifier[0]?.diagnostics.erasuresByShard,
  );
  assert.deepEqual(
    persisted.diagnostics.classifier[0]?.diagnostics.uncertainCellsByRow,
    record.diagnostics.classifier[0]?.diagnostics.uncertainCellsByRow,
  );
  assert.deepEqual(
    persisted.diagnostics.classifier[0]?.diagnostics.bestDeltaE,
    record.diagnostics.classifier[0]?.diagnostics.bestDeltaE,
  );
  assert.deepEqual(
    persisted.diagnostics.classifier[0]?.cells,
    record.diagnostics.classifier[0]?.cells,
  );
  assert.deepEqual(record, before);
  assert.deepEqual(record.diagnostics.classifier[0]?.bootstrapBytes, [0xd5, 0x24, 0x07]);
  assert.deepEqual(record.diagnostics.classifier[0]?.bootstrapCrc, {
    expected: 0x07,
    observed: 0x07,
  });
});
