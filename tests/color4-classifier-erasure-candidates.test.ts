import assert from "node:assert/strict";
import test from "node:test";
import {
  QUIET_MODULES,
  decodeCanonicalColor4Raster,
  type CanonicalRasterObservation,
} from "../shared/color4/index.ts";
import {
  EXPERIMENTAL_PROFILE,
  ROBUST_PROFILE,
  type Color4Profile,
} from "../shared/color4/profiles.ts";
import { rasterizeColor4, type Color4Raster } from "../shared/color4/raster.ts";

function deterministicBytes(length: number): Uint8Array {
  return Uint8Array.from({ length }, (_, index) => (index * 73 + 19) & 0xff);
}

function rasterFor(profile: Color4Profile): Color4Raster {
  return rasterizeColor4(deterministicBytes(profile.codedBytes), {
    profile,
    paletteId: profile === ROBUST_PROFILE ? 0 : 1,
    sequence: 0,
    moduleScale: 4,
  });
}

function paintActiveModule(
  raster: Color4Raster,
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

function closeTo(actual: number, expected: number): void {
  const tolerance = Math.max(1, Math.abs(expected)) * 1e-12;
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `expected ${actual} to be within ${tolerance} of ${expected}`,
  );
}

test("erasure candidate severity follows the formula and takes the maximum of four dibits", () => {
  for (const profile of [ROBUST_PROFILE, EXPERIMENTAL_PROFILE]) {
    const raster = rasterFor(profile);
    paintActiveModule(raster, raster.layout.data.x, raster.layout.data.y, [255, 255, 255]);
    paintActiveModule(raster, raster.layout.data.x + 1, raster.layout.data.y, [128, 128, 128]);

    const observations: CanonicalRasterObservation[] = [];
    const decoded = decodeCanonicalColor4Raster(raster, {
      observerDetail: true,
      observer: (observation) => observations.push(observation),
    });
    assert.equal(decoded.status, "valid", profile.name);
    if (decoded.status !== "valid") continue;

    const classification = observations.find(
      (observation) => observation.stage === "classification",
    );
    assert.equal(classification?.stage, "classification", profile.name);
    if (classification?.stage !== "classification") continue;
    const changedCells = [0, 1].map((cellIndex) => {
      const cell = classification.cells.find((entry) => entry.cellIndex === cellIndex);
      assert.notEqual(cell, undefined, profile.name);
      assert.equal(cell?.erased, true, profile.name);
      return cell!;
    });
    const expectedScores = changedCells.map((cell) => Math.max(
      cell.bestDeltaE /
        Math.max(classification.effectiveThresholds.maximumDeltaE, Number.EPSILON),
      classification.effectiveThresholds.minimumDeltaEGap /
        Math.max(cell.deltaEGap, Number.EPSILON),
    ));

    assert.deepEqual([...decoded.byteErasures], [0], profile.name);
    assert.equal(decoded.byteErasureCandidates.length, 1, profile.name);
    assert.equal(decoded.byteErasureCandidates[0]?.index, 0, profile.name);
    closeTo(decoded.byteErasureCandidates[0]!.score, Math.max(...expectedScores));
    assert.equal(decoded.diagnostics.erasureCandidateScore.count, 1, profile.name);
    closeTo(
      decoded.diagnostics.erasureCandidateScore.max,
      decoded.byteErasureCandidates[0]!.score,
    );
  }
});

test("erasure candidates are independent of debug observation and deeply immutable", () => {
  for (const profile of [ROBUST_PROFILE, EXPERIMENTAL_PROFILE]) {
    const raster = rasterFor(profile);
    paintActiveModule(raster, raster.layout.data.x, raster.layout.data.y, [128, 128, 128]);

    const baseline = decodeCanonicalColor4Raster(raster);
    const numeric = decodeCanonicalColor4Raster(raster, { observer: () => undefined });
    const detailed = decodeCanonicalColor4Raster(raster, {
      observerDetail: true,
      observer: () => undefined,
    });
    assert.equal(baseline.status, "valid", profile.name);
    assert.equal(numeric.status, "valid", profile.name);
    assert.equal(detailed.status, "valid", profile.name);
    if (baseline.status !== "valid" || numeric.status !== "valid" || detailed.status !== "valid") {
      continue;
    }

    assert.deepEqual(numeric.byteErasureCandidates, baseline.byteErasureCandidates, profile.name);
    assert.deepEqual(detailed.byteErasureCandidates, baseline.byteErasureCandidates, profile.name);
    assert.deepEqual(
      detailed.diagnostics.erasureCandidateScore,
      baseline.diagnostics.erasureCandidateScore,
      profile.name,
    );
    assert.equal(Object.isFrozen(baseline.byteErasureCandidates), true, profile.name);
    assert.ok(baseline.byteErasureCandidates.every(Object.isFrozen), profile.name);
    assert.equal(Object.isFrozen(baseline.diagnostics.erasureCandidateScore), true, profile.name);
    assert.deepEqual(
      structuredClone(baseline.byteErasureCandidates),
      baseline.byteErasureCandidates,
      profile.name,
    );
    assert.throws(
      () => ((baseline.byteErasureCandidates[0] as { score: number }).score = 0),
      TypeError,
      profile.name,
    );
    assert.throws(
      () => (baseline.byteErasureCandidates as { index: number; score: number }[]).push({
        index: 1,
        score: 1,
      }),
      TypeError,
      profile.name,
    );
  }
});

test("clean rasters emit no erasure candidates for either profile", () => {
  for (const profile of [ROBUST_PROFILE, EXPERIMENTAL_PROFILE]) {
    const decoded = decodeCanonicalColor4Raster(rasterFor(profile));
    assert.equal(decoded.status, "valid", profile.name);
    if (decoded.status !== "valid") continue;

    assert.deepEqual([...decoded.byteErasures], [], profile.name);
    assert.deepEqual(decoded.byteErasureCandidates, [], profile.name);
    assert.deepEqual(decoded.diagnostics.erasureCandidateScore, {
      count: 0,
      min: 0,
      p50: 0,
      p95: 0,
      max: 0,
    }, profile.name);
    assert.equal(Object.isFrozen(decoded.byteErasureCandidates), true, profile.name);
    assert.equal(Object.isFrozen(decoded.diagnostics.erasureCandidateScore), true, profile.name);
  }
});
