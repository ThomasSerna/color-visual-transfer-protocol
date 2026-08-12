import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";
import {
  decodeCanonicalColor4Raster,
  unwrapColor4Frame,
  type CanonicalRasterObservation,
  type Color4UnwrapObservation,
} from "../shared/color4/index.ts";
import { fecDiagnosticReason } from "../receive/color4-diagnostic-reason.ts";

const FIXTURE_DIRECTORY = fileURLToPath(
  new URL("./fixtures/color4/canonical/capture-000017/", import.meta.url),
);
const PNG_SHA256 = "3af7b4dd41ef15447fc54f7ef99e2d150a3f8a754b5c6a8a900003ae8e864bcc";
const RGBA_SHA256 = "86ebacb71a5bb9268848c3c478cdc51452ad4671d30bd38dc0d20e03a1402554";
const CODED_BYTES_SHA256 = "fd777331c87b26bbdc019c2b78eccd4713e62bb942df2bcca62e9128b75536df";

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

test("canonical capture 000017 reaches classification and preserves its phase-1 oracle", async () => {
  const pngBytes = await readFile(`${FIXTURE_DIRECTORY}/capture-000017-warped.png`);
  assert.equal(sha256(pngBytes), PNG_SHA256, "canonical PNG bytes changed");

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
  assert.equal(classified.diagnostics.uncertainCells, 219);
  assert.equal(classified.diagnostics.erasureBytes, 195);
  assert.equal(classified.byteErasures.length, 195);
  assert.equal(sha256(classified.codedBytes), CODED_BYTES_SHA256);

  const unwrapObservations: Color4UnwrapObservation[] = [];
  const unwrapped = unwrapColor4Frame(classified.codedBytes, {
    profileId: classified.profile.id,
    paletteId: classified.paletteId,
    erasures: classified.byteErasures,
    observer: (observation) => unwrapObservations.push(observation),
  });
  assert.equal(unwrapped.status, "rejected");
  if (unwrapped.status !== "rejected") return;
  assert.equal(unwrapped.reason, "fec-uncorrectable");
  assert.equal(unwrapped.diagnostics.erasures, 195);

  const shardReasons = unwrapObservations.flatMap((observation) =>
    observation.stage === "rs"
      ? observation.shards.map((shard) => shard.reason)
      : [],
  );
  assert.equal(
    fecDiagnosticReason(unwrapped.reason, shardReasons),
    "COLOR_CLASSIFICATION_TOO_UNCERTAIN",
  );
});
