import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";
import {
  decodeCanonicalColor4Raster,
  shardPosition,
  unwrapColor4Frame,
  type CanonicalRasterObservation,
  type Color4UnwrapObservation,
} from "../shared/color4/index.ts";
import { color4SequencePhaseMatches } from "../receive/color4-binding.ts";
import { runColor4ErasurePolicy } from "../receive/color4-erasure-policy.ts";

const FIXTURE_DIRECTORY = fileURLToPath(
  new URL("./fixtures/color4/canonical/capture-000017/", import.meta.url),
);
const PNG_SHA256 = "3af7b4dd41ef15447fc54f7ef99e2d150a3f8a754b5c6a8a900003ae8e864bcc";
const RGBA_SHA256 = "86ebacb71a5bb9268848c3c478cdc51452ad4671d30bd38dc0d20e03a1402554";
// The bytes the classifier reads off the image. This tracks classifier
// behaviour and moves whenever classification improves; INNER_FRAME_SHA256 below
// is the payload and must not move.
const CODED_BYTES_SHA256 = "33bc06b4a229242eaa61843376cc6d9feaab416a31fa55b09ab6db89ea0bd938";
const INNER_FRAME_SHA256 = "a5dcecd1058c25b13c5076e9f7d7e2617af3c830823c33831180d6a4f9976a84";

interface CanonicalFixtureMetadata {
  readonly oracle: {
    readonly basis: {
      readonly kind: string;
    };
    readonly classification: {
      readonly uncertainCells: number;
      readonly candidateErasures: {
        readonly total: number;
        readonly byShard: readonly number[];
      };
      readonly erasureCandidateScore: {
        readonly count: number;
        readonly min: number;
        readonly p50: number;
        readonly p95: number;
        readonly max: number;
      };
      readonly codedBytesSha256: string;
    };
    readonly unwrap: {
      readonly status: string;
      readonly sessionId: number;
      readonly sequence: number;
      readonly selectedPolicy: string;
      readonly selectedBudgetFraction: number;
      readonly selectedMaxErasuresPerShard: number;
      readonly attempts: number;
      readonly selectedErasures: {
        readonly total: number;
        readonly byShard: readonly number[];
      };
      readonly correctedErrors: number;
      readonly correctedBytes: number;
      readonly correctedShards: number;
      readonly innerFrameSha256: string;
    };
  };
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function erasureDistribution(
  erasures: ArrayLike<number>,
  shards: number,
): { readonly total: number; readonly byShard: readonly number[] } {
  const byShard = Array.from({ length: shards }, () => 0);
  for (const index of Array.from(erasures)) {
    const shard = shardPosition(index, shards).shard;
    byShard[shard] = (byShard[shard] ?? 0) + 1;
  }
  return { total: erasures.length, byShard };
}

test("canonical capture 000017 reaches a CRC-valid unwrap through the ranked erasure policy", async () => {
  const pngBytes = await readFile(`${FIXTURE_DIRECTORY}/capture-000017-warped.png`);
  const metadata = JSON.parse(
    await readFile(`${FIXTURE_DIRECTORY}/metadata.json`, "utf8"),
  ) as CanonicalFixtureMetadata;
  assert.equal(sha256(pngBytes), PNG_SHA256, "canonical PNG bytes changed");
  assert.equal(metadata.oracle.basis.kind, "crc-derived-regression");

  const png = PNG.sync.read(pngBytes);
  assert.deepEqual(
    { width: png.width, height: png.height },
    { width: 1032, height: 1032 },
  );
  assert.equal(sha256(png.data), RGBA_SHA256, "decoded canonical RGBA plane changed");

  const classifierObservations: CanonicalRasterObservation[] = [];
  const classified = decodeCanonicalColor4Raster({
    width: png.width,
    height: png.height,
    pixels: png.data,
  }, {
    observerDetail: true,
    observer: (observation) => classifierObservations.push(observation),
  });

  assert.deepEqual(
    classifierObservations.map(({ stage, outcome }) => ({ stage, outcome })),
    [
      { stage: "canonicalGeometry", outcome: "completed" },
      { stage: "bootstrapPhase", outcome: "completed" },
      { stage: "calibration", outcome: "completed" },
      { stage: "classification", outcome: "completed" },
    ],
    "the canonical replay must reach classification",
  );

  const bootstrap = classifierObservations.find(
    (observation) => observation.stage === "bootstrapPhase",
  );
  assert.ok(bootstrap?.stage === "bootstrapPhase");
  assert.deepEqual(bootstrap.bootstrap, {
    version: 1,
    profileId: 1,
    paletteId: 0,
    sequencePhase: 3,
  });
  assert.equal(bootstrap.topPhase, 3);
  assert.equal(bootstrap.bottomPhase, 3);
  assert.equal(bootstrap.diagnostics.timingErrors, 0);
  assert.equal(bootstrap.diagnostics.timingModules, 314);

  assert.equal(classified.status, "valid");
  if (classified.status !== "valid") return;
  assert.equal(classified.profile.id, 1);
  assert.equal(classified.profile.name, "ROBUST");
  assert.equal(classified.paletteId, 0);
  assert.equal(classified.sequencePhase, 3);
  assert.equal(classified.diagnostics.timingErrors, 0);
  assert.equal(classified.diagnostics.timingModules, 314);
  // This capture is blurred enough that a module's own light is a minority of
  // its sample, so the classifier corrects for the interference before reading
  // colour. Without it these counters were 219 uncertain cells and 195 erasure
  // bytes, and three of six shards were over parity.
  assert.equal(classified.diagnostics.isiStrength, 0.4);
  assert.equal(classified.diagnostics.uncertainCells, 95);
  assert.equal(classified.diagnostics.erasureBytes, 87);
  assert.equal(classified.diagnostics.distanceRejectedCells, 75);
  assert.equal(classified.diagnostics.gapRejectedCells, 72);
  assert.equal(classified.diagnostics.bothRejectedCells, 52);
  assert.deepEqual(classified.diagnostics.erasuresByShard, [13, 14, 14, 15, 18, 13]);
  assert.equal(classified.diagnostics.parityByShard, 32);
  // Every shard now sits inside its parity budget with room to spare.
  assert.deepEqual(
    classified.diagnostics.remainingErasureBudgetByShard,
    [19, 18, 18, 17, 14, 19],
  );
  assert.ok(
    classified.diagnostics.remainingErasureBudgetByShard.every((budget) => budget > 0),
    "no shard may exceed its parity budget on this capture",
  );
  assert.equal(classified.diagnostics.uncertainCellsByRow.length, classified.profile.rows);
  assert.equal(classified.diagnostics.uncertainCellsByColumn.length, classified.profile.columns);
  assert.equal(
    classified.diagnostics.uncertainCellsByRow.reduce((sum, count) => sum + count, 0),
    95,
  );
  assert.equal(
    classified.diagnostics.uncertainCellsByColumn.reduce((sum, count) => sum + count, 0),
    95,
  );
  // Uncertainty still concentrates in the bottom third of this capture, which is
  // the part of the sending screen furthest off-axis from the camera.
  assert.deepEqual([
    classified.diagnostics.uncertainCellsByRow.slice(0, 28).reduce((sum, count) => sum + count, 0),
    classified.diagnostics.uncertainCellsByRow.slice(28, 57).reduce((sum, count) => sum + count, 0),
    classified.diagnostics.uncertainCellsByRow.slice(57).reduce((sum, count) => sum + count, 0),
  ], [3, 6, 86]);
  assert.equal(classified.diagnostics.effectiveMaximumDeltaE, 45);
  assert.ok(classified.diagnostics.effectiveMinimumDeltaEGap > 17);
  for (const summary of [
    classified.diagnostics.bestDeltaE,
    classified.diagnostics.deltaEGap,
  ]) {
    assert.equal(summary.count, classified.profile.columns * classified.profile.rows);
    assert.ok(summary.min <= summary.p50);
    assert.ok(summary.p50 <= summary.p95);
    assert.ok(summary.p95 <= summary.max);
  }
  assert.deepEqual(structuredClone(classified.diagnostics), classified.diagnostics);
  assert.equal(classified.byteErasures.length, 87);
  assert.deepEqual(
    erasureDistribution(classified.byteErasures, classified.profile.shards),
    { total: 87, byShard: [13, 14, 14, 15, 18, 13] },
  );
  assert.deepEqual(classified.diagnostics.erasureCandidateScore, {
    count: 87,
    min: 1.000340246414468,
    p50: 1.6532158348557915,
    p95: 17.866086603057013,
    max: 454.59501886870567,
  });
  assert.equal(sha256(classified.codedBytes), CODED_BYTES_SHA256);
  assert.deepEqual(metadata.oracle.classification, {
    isiStrength: 0.4,
    uncertainCells: 95,
    candidateErasures: { total: 87, byShard: [13, 14, 14, 15, 18, 13] },
    erasureCandidateScore: {
      count: 87,
      min: 1.000340246414468,
      p50: 1.6532158348557915,
      p95: 17.866086603057013,
      max: 454.59501886870567,
    },
    codedBytesSha256: CODED_BYTES_SHA256,
  });

  // Marking every uncertain byte used to overrun parity on three shards, so this
  // capture only survived via the ranked erasure ladder. With the interference
  // corrected the raw classifier hints now fit, and the plain unwrap succeeds on
  // its own. The ladder below still has to reach the identical payload.
  const directObservations: Color4UnwrapObservation[] = [];
  const direct = unwrapColor4Frame(classified.codedBytes, {
    profileId: classified.profile.id,
    paletteId: classified.paletteId,
    erasures: classified.byteErasures,
    observer: (observation) => directObservations.push(observation),
  });
  assert.equal(direct.status, "valid");
  if (direct.status !== "valid") return;
  assert.equal(direct.diagnostics.erasures, 87);
  assert.equal(sha256(direct.innerFrame), INNER_FRAME_SHA256);
  const directShardReasons = directObservations.flatMap((observation) =>
    observation.stage === "rs"
      ? observation.shards.map((shard) => shard.reason)
      : [],
  );
  assert.ok(!directShardReasons.includes("too-many-erasures"));
  // Every shard kept parity in reserve, so Reed-Solomon could still have
  // rejected these corrections. The payload is verified, not merely solved.
  const directMargins = directObservations.flatMap((observation) =>
    observation.stage === "rs"
      ? observation.shards.map((shard) => shard.verificationMargin)
      : [],
  );
  assert.equal(directMargins.length, classified.profile.shards);
  assert.ok(directMargins.every((margin) => margin !== undefined && margin > 0));

  const coordinated = runColor4ErasurePolicy({
    codedBytes: classified.codedBytes,
    profile: classified.profile,
    paletteId: classified.paletteId,
    erasureCandidates: classified.byteErasureCandidates,
    expectedSequencePhase: classified.sequencePhase,
  });
  assert.equal(coordinated.selectedPolicy, "classifier-budgeted");
  assert.equal(coordinated.selectedBudgetFraction, 1);
  assert.equal(coordinated.selectedMaxErasuresPerShard, 32);
  assert.equal(coordinated.attempts.length, 1);
  // Nothing is clipped any more: the ladder spends exactly the hints it was
  // given, because none of them exceed a shard's parity budget.
  assert.deepEqual(
    erasureDistribution(coordinated.selectedErasures, classified.profile.shards),
    { total: 87, byShard: [13, 14, 14, 15, 18, 13] },
  );
  assert.deepEqual(coordinated.saturatedErasureShards, []);

  const unwrapped = coordinated.result;
  assert.equal(unwrapped.status, "valid");
  if (unwrapped.status !== "valid") return;
  assert.equal(unwrapped.header.sessionId, 31926);
  assert.equal(unwrapped.header.sequence, 23);
  assert.equal(
    color4SequencePhaseMatches(unwrapped.header.sequence, classified.sequencePhase),
    true,
  );
  assert.equal(unwrapped.diagnostics.correctedErrors, 1);
  assert.equal(unwrapped.diagnostics.correctedBytes, 15);
  assert.equal(unwrapped.diagnostics.correctedShards, 6);
  assert.equal(sha256(unwrapped.innerFrame), INNER_FRAME_SHA256);

  const crc = coordinated.selectedObservations.find((observation) => observation.stage === "crc");
  assert.ok(crc?.stage === "crc");
  assert.equal(crc.valid, true);
  assert.equal(crc.outcome, "completed");
  const wire = coordinated.selectedObservations.find((observation) => observation.stage === "wire");
  assert.ok(wire?.stage === "wire");
  assert.equal(wire.outerHeaderValid, true);
  assert.equal(wire.innerFrameValid, true);
  assert.equal(wire.identityValid, true);

  assert.deepEqual(metadata.oracle.unwrap, {
    status: "valid",
    sessionId: 31926,
    sequence: 23,
    selectedPolicy: "classifier-budgeted",
    selectedBudgetFraction: 1,
    selectedMaxErasuresPerShard: 32,
    attempts: 1,
    selectedErasures: { total: 87, byShard: [13, 14, 14, 15, 18, 13] },
    correctedErrors: 1,
    correctedBytes: 15,
    correctedShards: 6,
    innerFrameSha256: INNER_FRAME_SHA256,
  });
});
