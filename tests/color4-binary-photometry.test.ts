import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  buildLocalBinaryRailModel,
  classifyWithLocalBinaryRail,
  evaluateLocalBinaryRail,
  normalizeLumaThreshold,
  sampleDifferentialBootstrap,
} from "../shared/color4/binary-photometry.ts";
import {
  DEFAULT_CLASSIFIER_THRESHOLDS,
  decodeCanonicalColor4Raster,
  type CanonicalRasterObservation,
} from "../shared/color4/classifier.ts";
import {
  BOOTSTRAP_COLUMNS,
  BOOTSTRAP_ROWS,
  PHY_VERSION,
  QUIET_MODULES,
  crc8Atm,
  decodeBootstrap,
  encodeBootstrap,
} from "../shared/color4/physical.ts";
import { EXPERIMENTAL_PROFILE, ROBUST_PROFILE } from "../shared/color4/profiles.ts";
import { rasterizeColor4, type Color4Raster } from "../shared/color4/raster.ts";

function bootstrapLuminances(
  modules: ArrayLike<number>,
  black = 80,
  white = 120,
): Float64Array {
  return Float64Array.from(modules, (module) => (module === 1 ? black : white));
}

function bootstrapModulesFromBytes(bytes: readonly [number, number, number]): Uint8Array {
  const modules = new Uint8Array(BOOTSTRAP_COLUMNS * BOOTSTRAP_ROWS);
  for (let column = 0; column < BOOTSTRAP_COLUMNS; column++) {
    const bit = (bytes[column >>> 3]! >>> (7 - (column & 7))) & 1;
    modules[column] = bit;
    modules[BOOTSTRAP_COLUMNS + column] = bit ^ 1;
    modules[2 * BOOTSTRAP_COLUMNS + column] = bit;
  }
  return modules;
}

function paintActiveModule(
  raster: Color4Raster,
  activeX: number,
  activeY: number,
  luma: number,
): void {
  const startX = (activeX + QUIET_MODULES) * raster.moduleScale;
  const startY = (activeY + QUIET_MODULES) * raster.moduleScale;
  for (let y = 0; y < raster.moduleScale; y++) {
    for (let x = 0; x < raster.moduleScale; x++) {
      const offset = ((startY + y) * raster.width + startX + x) * 4;
      raster.pixels[offset] = luma;
      raster.pixels[offset + 1] = luma;
      raster.pixels[offset + 2] = luma;
      raster.pixels[offset + 3] = 255;
    }
  }
}

function boxBlur3x3(raster: Color4Raster): Uint8ClampedArray<ArrayBuffer> {
  const pixels = new Uint8ClampedArray(raster.pixels);
  for (let y = 1; y < raster.height - 1; y++) {
    for (let x = 1; x < raster.width - 1; x++) {
      const target = (y * raster.width + x) * 4;
      for (let channel = 0; channel < 3; channel++) {
        let sum = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            sum += raster.pixels[((y + dy) * raster.width + x + dx) * 4 + channel]!;
          }
        }
        pixels[target + channel] = Math.round(sum / 9);
      }
    }
  }
  return pixels;
}

function deterministicBytes(length: number): Uint8Array {
  return Uint8Array.from({ length }, (_, index) => (index * 73 + 19) & 0xff);
}

interface BootstrapLumaFixture {
  readonly lumaRows: readonly (readonly number[])[];
  readonly oracle: Readonly<{
    bytes: readonly [number, number, number];
    doubleVoteColumns: number;
    singleVoteColumns: number;
    uncertainColumns: number;
    contradictoryColumns: number;
    minimumDifferentialLuma: number;
    medianDifferentialLuma: number;
  }>;
}

test("differential bootstrap reproduces D5 24 07 and delegates wire validation", () => {
  const modules = encodeBootstrap({
    version: PHY_VERSION,
    profileId: ROBUST_PROFILE.id,
    paletteId: 0,
    sequencePhase: 3,
  });
  const sampled = sampleDifferentialBootstrap(bootstrapLuminances(modules), 16);

  assert.equal(Object.isFrozen(sampled), true);
  assert.equal(Object.isFrozen(sampled.modules), true);
  assert.equal(Object.isFrozen(sampled.decidedBytes), true);
  assert.equal(Object.isFrozen(sampled.diagnostics), true);
  assert.deepEqual(sampled.decidedBytes, [0xd5, 0x24, 0x07]);
  assert.deepEqual(decodeBootstrap(sampled.modules), {
    version: PHY_VERSION,
    profileId: ROBUST_PROFILE.id,
    paletteId: 0,
    sequencePhase: 3,
  });
  assert.deepEqual(sampled.diagnostics, {
    doubleVoteColumns: 24,
    singleVoteColumns: 0,
    uncertainColumns: 0,
    contradictoryColumns: 0,
    minimumDifferentialLuma: 40,
    medianDifferentialLuma: 40,
  });
});

test("capture 000017 numeric bootstrap matrix produces D5 24 07 and pinned margins", async () => {
  const fixturePath = fileURLToPath(
    new URL(
      "./fixtures/color4/canonical/capture-000017/bootstrap-luma.json",
      import.meta.url,
    ),
  );
  const fixture = JSON.parse(await readFile(fixturePath, "utf8")) as BootstrapLumaFixture;
  assert.deepEqual(fixture.lumaRows.map((row) => row.length), [24, 24, 24]);

  const sampled = sampleDifferentialBootstrap(fixture.lumaRows.flat(), 16);
  assert.deepEqual(sampled.decidedBytes, fixture.oracle.bytes);
  assert.deepEqual(decodeBootstrap(sampled.modules), {
    version: PHY_VERSION,
    profileId: ROBUST_PROFILE.id,
    paletteId: 0,
    sequencePhase: 3,
  });
  assert.deepEqual({
    ...sampled.diagnostics,
    minimumDifferentialLuma: undefined,
    medianDifferentialLuma: undefined,
  }, {
    doubleVoteColumns: fixture.oracle.doubleVoteColumns,
    singleVoteColumns: fixture.oracle.singleVoteColumns,
    uncertainColumns: fixture.oracle.uncertainColumns,
    contradictoryColumns: fixture.oracle.contradictoryColumns,
    minimumDifferentialLuma: undefined,
    medianDifferentialLuma: undefined,
  });
  assert.ok(
    Math.abs(
      sampled.diagnostics.minimumDifferentialLuma -
        fixture.oracle.minimumDifferentialLuma,
    ) < 1e-9,
  );
  assert.ok(
    Math.abs(
      sampled.diagnostics.medianDifferentialLuma -
        fixture.oracle.medianDifferentialLuma,
    ) < 1e-9,
  );
});

test("bootstrap votes accept inclusive delta 16 and distinguish single/conflict/flat", () => {
  const modules = encodeBootstrap({
    version: PHY_VERSION,
    profileId: ROBUST_PROFILE.id,
    paletteId: 0,
    sequencePhase: 3,
  });
  const luminances = bootstrapLuminances(modules, 100, 116);

  // Column 0: only top has a reliable delta and still decides the bit.
  luminances[2 * BOOTSTRAP_COLUMNS] = luminances[BOOTSTRAP_COLUMNS]! - 15;
  // Column 1: both votes are reliable but contradictory.
  luminances[1] = luminances[BOOTSTRAP_COLUMNS + 1]! - 16;
  luminances[2 * BOOTSTRAP_COLUMNS + 1] = luminances[BOOTSTRAP_COLUMNS + 1]! + 16;
  // Column 2: no reliable vote.
  luminances[2] = luminances[BOOTSTRAP_COLUMNS + 2]!;
  luminances[2 * BOOTSTRAP_COLUMNS + 2] = luminances[BOOTSTRAP_COLUMNS + 2]!;

  const sampled = sampleDifferentialBootstrap(luminances, 16);
  assert.equal(sampled.modules[0], modules[0]);
  assert.equal(sampled.modules[1], -1);
  assert.equal(sampled.modules[2], -1);
  assert.equal(sampled.decidedBytes, undefined);
  assert.deepEqual(sampled.diagnostics, {
    doubleVoteColumns: 21,
    singleVoteColumns: 1,
    uncertainColumns: 2,
    contradictoryColumns: 1,
    minimumDifferentialLuma: 16,
    medianDifferentialLuma: 16,
  });
  assert.equal(decodeBootstrap(sampled.modules), null);
});

test("bootstrap diagnostics use zero margins when every column is uncertain", () => {
  const sampled = sampleDifferentialBootstrap(
    new Float64Array(BOOTSTRAP_COLUMNS * BOOTSTRAP_ROWS).fill(100),
    16,
  );
  assert.equal(sampled.decidedColumns, 0);
  assert.equal(sampled.diagnostics.uncertainColumns, 24);
  assert.equal(sampled.diagnostics.minimumDifferentialLuma, 0);
  assert.equal(sampled.diagnostics.medianDifferentialLuma, 0);
});

test("differential sampling tolerates deterministic noise but wire CRC and magic stay strict", () => {
  const validBytes = [0xd5, 0x24, 0x07] as const;
  const noisy = bootstrapLuminances(bootstrapModulesFromBytes(validBytes));
  for (let index = 0; index < noisy.length; index++) {
    noisy[index] = noisy[index]! + ((index * 17) % 11) - 5;
  }
  assert.notEqual(decodeBootstrap(sampleDifferentialBootstrap(noisy, 16).modules), null);

  const badCrc = sampleDifferentialBootstrap(
    bootstrapLuminances(bootstrapModulesFromBytes([0xd5, 0x24, 0x06])),
    16,
  );
  assert.deepEqual(badCrc.decidedBytes, [0xd5, 0x24, 0x06]);
  assert.equal(decodeBootstrap(badCrc.modules), null);

  const badMagicFirst = 0x95;
  const badMagicCrc = crc8Atm(Uint8Array.from([badMagicFirst, 0x24]));
  const badMagic = sampleDifferentialBootstrap(
    bootstrapLuminances(
      bootstrapModulesFromBytes([badMagicFirst, 0x24, badMagicCrc]),
    ),
    16,
  );
  assert.equal(decodeBootstrap(badMagic.modules), null);
});

test("additive luma thresholds clamp inclusively to 1..255", () => {
  assert.equal(normalizeLumaThreshold(undefined, 16), 16);
  assert.equal(normalizeLumaThreshold(Number.NaN, 16), 16);
  assert.equal(normalizeLumaThreshold(-100, 16), 1);
  assert.equal(normalizeLumaThreshold(0, 16), 1);
  assert.equal(normalizeLumaThreshold(999, 16), 255);
  assert.equal(normalizeLumaThreshold(40.5, 16), 40.5);
});

test("local timing models accept contrast 40 and classify with the 0.35/0.65 deadband", () => {
  const luminances = Float64Array.from([80, 120, 80, 120]);
  const expected = Int8Array.from([1, 0, 1, 0]);
  const model = buildLocalBinaryRailModel(luminances, expected, 40);
  assert.deepEqual(model, {
    valid: true,
    blackLuma: 80,
    whiteLuma: 120,
    thresholdLuma: 100,
    contrastLuma: 40,
  });
  assert.equal(classifyWithLocalBinaryRail(94, model), 1);
  assert.equal(classifyWithLocalBinaryRail(106, model), 0);
  assert.equal(classifyWithLocalBinaryRail(100, model), -1);

  const evaluated = evaluateLocalBinaryRail(
    [80, 100, 80, 120, 80, 120],
    [1, 0, 1, 0, 1, 0],
    40,
  );
  assert.equal(evaluated.valid, true);
  assert.equal(evaluated.errors, 1);
  assert.equal(evaluated.uncertainModules, 1);
});

test("flat, inverted and below-threshold timing rails invalidate every module", () => {
  const expected = Int8Array.from([1, 0, 1, 0]);
  for (const luminances of [
    [100, 100, 100, 100],
    [120, 80, 120, 80],
    [80, 119, 80, 119],
  ]) {
    const rail = evaluateLocalBinaryRail(luminances, expected, 40);
    assert.equal(Object.isFrozen(rail), true);
    assert.equal(Object.isFrozen(rail.sampledModules), true);
    assert.equal(rail.valid, false);
    assert.equal(rail.errors, 4);
    assert.equal(rail.uncertainModules, 4);
    assert.deepEqual([...rail.sampledModules], [-1, -1, -1, -1]);
  }
});

test("all phases and both profiles decode through local rail pilot models", () => {
  for (const profile of [ROBUST_PROFILE, EXPERIMENTAL_PROFILE]) {
    for (const phase of [0, 1, 2, 3] as const) {
      const coded = deterministicBytes(profile.codedBytes);
      const decoded = decodeCanonicalColor4Raster(
        rasterizeColor4(coded, { profile, paletteId: 0, sequence: phase, moduleScale: 1 }),
      );
      assert.equal(decoded.status, "valid", `${profile.name} phase ${phase}`);
      if (decoded.status !== "valid") continue;
      assert.equal(decoded.sequencePhase, phase);
      assert.equal(decoded.diagnostics.timingErrors, 0);
      assert.equal(decoded.diagnostics.timingUncertainModules, 0);
      assert.equal(Object.values(decoded.diagnostics.timingRails ?? {}).length, 4);
    }
  }
});

test("blurred bootstrap and pilots decode all phases for both profiles", () => {
  for (const profile of [ROBUST_PROFILE, EXPERIMENTAL_PROFILE]) {
    for (const phase of [0, 1, 2, 3] as const) {
      const coded = deterministicBytes(profile.codedBytes);
      const raster = rasterizeColor4(coded, {
        profile,
        paletteId: 0,
        sequence: phase,
        moduleScale: 4,
      });
      const decoded = decodeCanonicalColor4Raster({
        width: raster.width,
        height: raster.height,
        pixels: boxBlur3x3(raster),
      });
      assert.equal(decoded.status, "valid", `${profile.name} blurred phase ${phase}`);
      if (decoded.status !== "valid") continue;
      assert.equal(decoded.sequencePhase, phase);
      assert.equal(decoded.diagnostics.bootstrapSampling?.uncertainColumns, 0);
      assert.equal(decoded.diagnostics.timingErrors, 0);
    }
  }
});

test("EXPERIMENTAL nearby bootstrap stays independent from uniform and mixed pilots", () => {
  for (const pilotLuma of [0, 255] as const) {
    const raster = rasterizeColor4(deterministicBytes(EXPERIMENTAL_PROFILE.codedBytes), {
      profile: EXPERIMENTAL_PROFILE,
      paletteId: 0,
      sequence: 3,
      moduleScale: 2,
    });
    for (let index = 0; index < raster.layout.phasePilots.top.width; index++) {
      paintActiveModule(
        raster,
        raster.layout.phasePilots.top.x + index,
        raster.layout.phasePilots.top.y,
        pilotLuma,
      );
      paintActiveModule(
        raster,
        raster.layout.phasePilots.bottom.x + index,
        raster.layout.phasePilots.bottom.y,
        pilotLuma,
      );
    }
    const decoded = decodeCanonicalColor4Raster(raster);
    assert.equal(decoded.status, "rejected", `uniform pilot luma ${pilotLuma}`);
    if (decoded.status !== "rejected") continue;
    assert.equal(decoded.reason, "phase_mismatch");
    assert.equal(decoded.diagnostics.bootstrapSampling?.uncertainColumns, 0);
  }

  const transition = rasterizeColor4(
    deterministicBytes(EXPERIMENTAL_PROFILE.codedBytes),
    { profile: EXPERIMENTAL_PROFILE, paletteId: 0, sequence: 3, moduleScale: 2 },
  );
  // Top remains phase 3; bottom becomes phase 1 to model a mixed transition.
  const phaseOne = [0, 1, 0, 1] as const;
  for (let index = 0; index < phaseOne.length; index++) {
    paintActiveModule(
      transition,
      transition.layout.phasePilots.bottom.x + index,
      transition.layout.phasePilots.bottom.y,
      phaseOne[index] === 1 ? 0 : 255,
    );
  }
  const observations: CanonicalRasterObservation[] = [];
  const decoded = decodeCanonicalColor4Raster(transition, {
    observer: (observation) => observations.push(observation),
  });
  assert.equal(decoded.status, "rejected");
  if (decoded.status === "rejected") assert.equal(decoded.reason, "phase_mismatch");
  const bootstrap = observations.find((observation) => observation.stage === "bootstrapPhase");
  assert.equal(bootstrap?.stage, "bootstrapPhase");
  if (bootstrap?.stage !== "bootstrapPhase") return;
  assert.deepEqual(bootstrap.bootstrap, {
    version: PHY_VERSION,
    profileId: EXPERIMENTAL_PROFILE.id,
    paletteId: 0,
    sequencePhase: 3,
  });
  assert.equal(bootstrap.topPhase, 3);
  assert.equal(bootstrap.bottomPhase, 1);
  assert.equal(bootstrap.diagnostics.bootstrapSampling?.uncertainColumns, 0);
});

test("ROBUST global timing boundary accepts 25/314 and rejects 26/314", () => {
  for (const damaged of [25, 26]) {
    const raster = rasterizeColor4(deterministicBytes(ROBUST_PROFILE.codedBytes), {
      profile: ROBUST_PROFILE,
      paletteId: 0,
      sequence: 0,
      moduleScale: 2,
    });
    // Spread damage so no expected class can move a rail's median model.
    const rails = [
      { rect: raster.layout.timing.top, inverted: false },
      { rect: raster.layout.timing.bottom, inverted: true },
      { rect: raster.layout.timing.left, inverted: false },
      { rect: raster.layout.timing.right, inverted: true },
    ];
    for (let index = 0; index < damaged; index++) {
      const rail = rails[index % rails.length]!;
      const railIndex = Math.floor(index / rails.length) * 2 + (rail.inverted ? 1 : 0);
      const horizontal = rail.rect.height === 1;
      paintActiveModule(
        raster,
        rail.rect.x + (horizontal ? railIndex : 0),
        rail.rect.y + (horizontal ? 0 : railIndex),
        255,
      );
    }
    const decoded = decodeCanonicalColor4Raster(raster);
    assert.equal(decoded.diagnostics.timingModules, 314);
    assert.equal(decoded.diagnostics.timingErrors, damaged);
    assert.equal(decoded.status, damaged === 25 ? "valid" : "rejected");
    if (decoded.status === "rejected") assert.equal(decoded.reason, "invalid_geometry");
  }
});

test("nested photometric diagnostics are deeply frozen, cloneable and hide bytes", () => {
  const raster = rasterizeColor4(deterministicBytes(ROBUST_PROFILE.codedBytes), {
    profile: ROBUST_PROFILE,
    paletteId: 0,
    sequence: 3,
    moduleScale: 1,
  });
  const observations: CanonicalRasterObservation[] = [];
  const decoded = decodeCanonicalColor4Raster(raster, {
    observerDetail: true,
    observer: (observation) => observations.push(observation),
  });
  assert.equal(decoded.status, "valid");
  assert.equal(Object.isFrozen(decoded.diagnostics), true);
  assert.equal(Object.isFrozen(decoded.diagnostics.bootstrapSampling), true);
  assert.equal(Object.isFrozen(decoded.diagnostics.timingRails), true);
  assert.equal(Object.isFrozen(decoded.diagnostics.timingRails?.top), true);
  assert.deepEqual(structuredClone(decoded.diagnostics), decoded.diagnostics);
  assert.equal("bootstrapBytes" in decoded.diagnostics, false);

  const bootstrap = observations.find((observation) => observation.stage === "bootstrapPhase");
  assert.equal(bootstrap?.stage, "bootstrapPhase");
  if (bootstrap?.stage !== "bootstrapPhase") return;
  assert.deepEqual(bootstrap.bootstrapBytes, [0xd5, 0x24, 0x07]);
  assert.deepEqual(bootstrap.bootstrapCrc, { expected: 0x07, observed: 0x07 });
  assert.deepEqual(structuredClone(bootstrap), bootstrap);

  let observedThresholds: typeof DEFAULT_CLASSIFIER_THRESHOLDS | undefined;
  decodeCanonicalColor4Raster(raster, {
    thresholds: {
      minimumBootstrapDifferentialLuma: -1,
      minimumTimingRailContrastLuma: 999,
    },
    observer: (observation) => {
      if (observation.stage === "canonicalGeometry") observedThresholds = observation.thresholds;
    },
  });
  assert.equal(observedThresholds?.minimumBootstrapDifferentialLuma, 1);
  assert.equal(observedThresholds?.minimumTimingRailContrastLuma, 255);
});
