import assert from "node:assert/strict";
import test from "node:test";
import {
  COLOR4_OUTER_HEADER_BYTES,
  QUIET_MODULES,
  ROBUST_PROFILE,
  decodeCanonicalColor4Raster,
  encodeColor4PduForTesting,
  interleavedIndex,
  rasterizeColor4,
  unwrapColor4Frame,
  whitenInPlace,
  wrapColor4Frame,
  type CanonicalRasterObservation,
  type Color4UnwrapObservation,
} from "../shared/color4/index.ts";
import { packFrame } from "../shared/protocol.ts";

function deterministicBytes(length: number): Uint8Array {
  return Uint8Array.from({ length }, (_, index) => (index * 73 + 19) & 0xff);
}

function innerFrame(): Uint8Array {
  const totalLen = 12_345;
  return packFrame(
    {
      sessionId: 0xbeef,
      seq: 0x10203040,
      k: Math.ceil(totalLen / ROBUST_PROFILE.blockBytes),
      blockLen: ROBUST_PROFILE.blockBytes,
      totalLen,
      payloadFnv: 0x89abcdef,
    },
    deterministicBytes(ROBUST_PROFILE.blockBytes),
  );
}

function paintActiveModule(
  raster: ReturnType<typeof rasterizeColor4>,
  activeX: number,
  activeY: number,
  rgb: readonly [number, number, number],
): void {
  const startX = (activeX + QUIET_MODULES) * raster.moduleScale;
  const startY = (activeY + QUIET_MODULES) * raster.moduleScale;
  for (let y = 0; y < raster.moduleScale; y++) {
    for (let x = 0; x < raster.moduleScale; x++) {
      const offset = ((startY + y) * raster.width + startX + x) * 4;
      raster.pixels[offset] = rgb[0];
      raster.pixels[offset + 1] = rgb[1];
      raster.pixels[offset + 2] = rgb[2];
    }
  }
}

function incrementingClock(step = 1): () => number {
  let value = 0;
  return () => {
    value += step;
    return value;
  };
}

function assertDistributionInvariant(
  summary: Readonly<{ count: number; min: number; p50: number; p95: number; max: number }>,
  expectedCount: number,
): void {
  assert.equal(summary.count, expectedCount);
  assert.ok(Number.isFinite(summary.min));
  assert.ok(summary.min <= summary.p50);
  assert.ok(summary.p50 <= summary.p95);
  assert.ok(summary.p95 <= summary.max);
}

test("canonical classifier observations separate stages without changing deterministic output", () => {
  const coded = deterministicBytes(ROBUST_PROFILE.codedBytes);
  const raster = rasterizeColor4(coded, {
    profile: ROBUST_PROFILE,
    paletteId: 0,
    sequence: 7,
    moduleScale: 4,
  });
  paintActiveModule(raster, raster.layout.data.x, raster.layout.data.y, [128, 128, 128]);

  const baseline = decodeCanonicalColor4Raster(raster);
  const observations: CanonicalRasterObservation[] = [];
  const instrumented = decodeCanonicalColor4Raster(raster, {
    clock: incrementingClock(2),
    observerDetail: true,
    observer: (observation) => observations.push(observation),
  });

  assert.deepEqual(instrumented, baseline);
  assert.deepEqual(
    observations.map(({ stage, durationMs, outcome }) => ({ stage, durationMs, outcome })),
    [
      { stage: "canonicalGeometry", durationMs: 2, outcome: "completed" },
      { stage: "bootstrapPhase", durationMs: 2, outcome: "completed" },
      { stage: "calibration", durationMs: 2, outcome: "completed" },
      { stage: "classification", durationMs: 2, outcome: "completed" },
    ],
  );

  const geometry = observations[0];
  assert.equal(geometry?.stage, "canonicalGeometry");
  if (geometry?.stage === "canonicalGeometry") {
    assert.equal(geometry.diagnostics.fiducialErrors, 0);
    assert.deepEqual(geometry.diagnostics.fiducialErrorsById, { TL: 0, TR: 0, BR: 0, BL: 0 });
    assert.equal(geometry.diagnostics.fiducialErrorMax, 0);
    assert.equal(geometry.diagnostics.quietZoneErrors, 0);
    assert.ok(Math.abs((geometry.binaryAnchors?.contrast ?? 0) - 255) < 1e-9);
    assert.deepEqual(Object.keys(geometry.binaryAnchorsByFiducial ?? {}), ["TL", "TR", "BR", "BL"]);
    for (const anchors of Object.values(geometry.binaryAnchorsByFiducial ?? {})) {
      assert.equal(anchors.black, 0);
      assert.ok(Math.abs(anchors.white - 255) < 1e-9);
      assert.ok(Math.abs(anchors.contrast - 255) < 1e-9);
    }
  }
  const bootstrap = observations[1];
  assert.equal(bootstrap?.stage, "bootstrapPhase");
  if (bootstrap?.stage === "bootstrapPhase") {
    assert.equal(bootstrap.bootstrap?.sequencePhase, 3);
    assert.equal(bootstrap.topPhase, 3);
    assert.equal(bootstrap.bottomPhase, 3);
    assert.equal(bootstrap.diagnostics.timingErrors, 0);
  }
  const calibration = observations[2];
  assert.equal(calibration?.stage, "calibration");
  if (calibration?.stage === "calibration") {
    assert.deepEqual(calibration.left?.raw.K, [16, 16, 16]);
    assert.equal(calibration.detailIncluded, true);
    assert.equal(calibration.left?.mad, 0);
    assert.ok((calibration.left?.clippedChannels ?? 0) > 0);
    assert.equal(calibration.left?.samples.K.length, 4);
    assert.ok((calibration.diagnostics.minimumPaletteDistance ?? 0) > 80);
    assert.equal(calibration.thresholds.minimumContrast, 40);
  }
  const classification = observations[3];
  assert.equal(classification?.stage, "classification");
  if (classification?.stage === "classification") {
    assert.equal(classification.cells.length, 128);
    assert.equal(classification.detailIncluded, true);
    assert.equal(classification.cells[0]?.byteIndex, 0);
    assert.equal(classification.cells[0]?.erased, true);
    assert.equal(classification.diagnostics.erasureBytes, 1);
    assert.ok(classification.clippedChannels > 0);
    assert.ok((classification.effectiveThresholds?.maximumDeltaE ?? 0) >= 24);
    const diagnostics = classification.diagnostics;
    const expectedCells = ROBUST_PROFILE.columns * ROBUST_PROFILE.rows;
    assert.equal(
      diagnostics.uncertainCells,
      diagnostics.distanceRejectedCells + diagnostics.gapRejectedCells -
        diagnostics.bothRejectedCells,
    );
    assert.equal(
      diagnostics.uncertainCellsByRow.reduce((sum, count) => sum + count, 0),
      diagnostics.uncertainCells,
    );
    assert.equal(
      diagnostics.uncertainCellsByColumn.reduce((sum, count) => sum + count, 0),
      diagnostics.uncertainCells,
    );
    assert.equal(diagnostics.uncertainCellsByRow.length, ROBUST_PROFILE.rows);
    assert.equal(diagnostics.uncertainCellsByColumn.length, ROBUST_PROFILE.columns);
    assert.equal(
      diagnostics.erasuresByShard.reduce((sum, count) => sum + count, 0),
      diagnostics.erasureBytes,
    );
    assert.equal(diagnostics.erasuresByShard.length, ROBUST_PROFILE.shards);
    assert.equal(diagnostics.parityByShard, ROBUST_PROFILE.rsN - ROBUST_PROFILE.rsK);
    assert.deepEqual(
      diagnostics.remainingErasureBudgetByShard,
      diagnostics.erasuresByShard.map((count) => diagnostics.parityByShard - count),
    );
    assert.equal(
      diagnostics.effectiveMaximumDeltaE,
      classification.effectiveThresholds.maximumDeltaE,
    );
    assert.equal(
      diagnostics.effectiveMinimumDeltaEGap,
      classification.effectiveThresholds.minimumDeltaEGap,
    );
    assertDistributionInvariant(diagnostics.bestDeltaE, expectedCells);
    assertDistributionInvariant(diagnostics.deltaEGap, expectedCells);
    assert.equal(diagnostics.bestDeltaE.max, diagnostics.maximumBestDeltaE);
    for (const frozen of [
      diagnostics.uncertainCellsByRow,
      diagnostics.uncertainCellsByColumn,
      diagnostics.erasuresByShard,
      diagnostics.remainingErasureBudgetByShard,
      diagnostics.bestDeltaE,
      diagnostics.deltaEGap,
    ]) assert.equal(Object.isFrozen(frozen), true);
    assert.deepEqual(structuredClone(diagnostics), diagnostics);
  }
});

test("classifier observers and clocks cannot perturb rejection results", () => {
  const invalid = { width: 3, height: 4, pixels: new Uint8Array(16) };
  const baseline = decodeCanonicalColor4Raster(invalid);
  const observed: CanonicalRasterObservation[] = [];
  const instrumented = decodeCanonicalColor4Raster(invalid, {
    clock: () => {
      throw new Error("clock failed");
    },
    observer: (observation) => {
      observed.push(observation);
      throw new Error("observer failed");
    },
  });
  assert.deepEqual(instrumented, baseline);
  assert.equal(observed.length, 1);
  assert.equal(observed[0]?.stage, "canonicalGeometry");
  assert.equal(observed[0]?.outcome, "rejected");
});

test("numeric classifier observations omit debug banks and cell retention by default", () => {
  const raster = rasterizeColor4(deterministicBytes(ROBUST_PROFILE.codedBytes), {
    profile: ROBUST_PROFILE,
    paletteId: 0,
    sequence: 0,
    moduleScale: 2,
  });
  const observed: CanonicalRasterObservation[] = [];
  const decoded = decodeCanonicalColor4Raster(raster, {
    observer: (observation) => observed.push(observation),
  });
  assert.equal(decoded.status, "valid");
  const calibration = observed.find((event) => event.stage === "calibration");
  assert.equal(calibration?.stage, "calibration");
  if (calibration?.stage === "calibration") {
    assert.equal(calibration.detailIncluded, false);
    assert.equal(calibration.left, undefined);
    assert.equal(calibration.right, undefined);
  }
  const classification = observed.find((event) => event.stage === "classification");
  assert.equal(classification?.stage, "classification");
  if (classification?.stage === "classification") {
    assert.equal(classification.detailIncluded, false);
    assert.deepEqual(classification.cells, []);
    assert.ok(classification.clippedChannels > 0);
  }
});

test("unwrap observations expose deterministic RS, CRC and wire timings", () => {
  const wrapped = wrapColor4Frame(innerFrame(), { profileId: 1, paletteId: 0 });
  const run = (): { result: ReturnType<typeof unwrapColor4Frame>; events: Color4UnwrapObservation[] } => {
    const events: Color4UnwrapObservation[] = [];
    const result = unwrapColor4Frame(wrapped.codedBytes, {
      profileId: 1,
      paletteId: 0,
      clock: incrementingClock(),
      observer: (event) => events.push(event),
    });
    return { result, events };
  };

  const first = run();
  const second = run();
  assert.deepEqual(first.result, second.result);
  assert.deepEqual(first.events, second.events);
  assert.deepEqual(first.events.map(({ stage }) => stage), ["rs", "crc", "wire"]);
  const rs = first.events[0];
  assert.equal(rs?.stage, "rs");
  if (rs?.stage === "rs") {
    assert.equal(rs.outcome, "completed");
    assert.equal(rs.shards.length, ROBUST_PROFILE.shards);
    assert.ok(rs.shards.every((shard) => shard.status === "corrected"));
    assert.ok(rs.shards.every((shard) => shard.durationMs === 1));
  }
  const crc = first.events[1];
  assert.equal(crc?.stage, "crc");
  if (crc?.stage === "crc") assert.equal(crc.valid, true);
  const wire = first.events[2];
  assert.equal(wire?.stage, "wire");
  if (wire?.stage === "wire") {
    assert.equal(wire.outerHeaderValid, true);
    assert.equal(wire.innerFrameValid, true);
    assert.equal(wire.identityValid, true);
  }
});

test("unwrap observers and clocks cannot perturb valid protocol output", () => {
  const wrapped = wrapColor4Frame(innerFrame(), { profileId: 1, paletteId: 0 });
  const baseline = unwrapColor4Frame(wrapped.codedBytes, { profileId: 1, paletteId: 0 });
  const instrumented = unwrapColor4Frame(wrapped.codedBytes, {
    profileId: 1,
    paletteId: 0,
    clock: () => {
      throw new Error("clock failed");
    },
    observer: () => {
      throw new Error("observer failed");
    },
  });
  assert.deepEqual(instrumented, baseline);
});

test("uncorrectable RS preserves requested erasures and every shard observation", () => {
  const wrapped = wrapColor4Frame(innerFrame(), { profileId: 1, paletteId: 0 });
  const parity = ROBUST_PROFILE.rsN - ROBUST_PROFILE.rsK;
  const erasures = Uint16Array.from(
    { length: parity + 1 },
    (_, position) => interleavedIndex(0, position, ROBUST_PROFILE.shards),
  );
  const events: Color4UnwrapObservation[] = [];
  const decoded = unwrapColor4Frame(wrapped.codedBytes, {
    profileId: 1,
    paletteId: 0,
    erasures,
    clock: incrementingClock(),
    observer: (event) => events.push(event),
  });

  assert.equal(decoded.status, "rejected");
  if (decoded.status === "rejected") {
    assert.equal(decoded.reason, "fec-uncorrectable");
    assert.equal(decoded.diagnostics.erasures, parity + 1);
  }
  assert.equal(events.length, 1);
  const rs = events[0];
  assert.equal(rs?.stage, "rs");
  if (rs?.stage === "rs") {
    assert.equal(rs.outcome, "rejected");
    assert.equal(rs.requestedErasures, parity + 1);
    assert.equal(rs.uniqueErasures, parity + 1);
    assert.equal(rs.shards.length, ROBUST_PROFILE.shards);
    assert.deepEqual(
      rs.shards.map(({ status, erasuresRequested, reason }) => ({
        status,
        erasuresRequested,
        reason,
      })),
      [
        { status: "uncorrectable", erasuresRequested: parity + 1, reason: "too-many-erasures" },
        ...Array.from({ length: ROBUST_PROFILE.shards - 1 }, () => ({
          status: "not-attempted" as const,
          erasuresRequested: 0,
          reason: undefined,
        })),
      ],
    );
  }
});

test("CRC observations reject a stale checksum without changing wire precedence", () => {
  const wrapped = wrapColor4Frame(innerFrame(), { profileId: 1, paletteId: 0 });
  const stale = wrapped.pdu.slice();
  stale[COLOR4_OUTER_HEADER_BYTES + 10] = stale[COLOR4_OUTER_HEADER_BYTES + 10]! ^ 1;
  const recoded = encodeColor4PduForTesting(stale, ROBUST_PROFILE);
  whitenInPlace(recoded, 1, 0);
  const events: Color4UnwrapObservation[] = [];
  const decoded = unwrapColor4Frame(recoded, {
    profileId: 1,
    paletteId: 0,
    observer: (event) => events.push(event),
  });
  assert.equal(decoded.status, "rejected");
  if (decoded.status === "rejected") assert.equal(decoded.reason, "crc-mismatch");
  assert.deepEqual(events.map(({ stage }) => stage), ["rs", "crc", "wire"]);
  const crc = events[1];
  assert.equal(crc?.stage, "crc");
  if (crc?.stage === "crc") {
    assert.equal(crc.valid, false);
    assert.equal(crc.outcome, "rejected");
  }
});
