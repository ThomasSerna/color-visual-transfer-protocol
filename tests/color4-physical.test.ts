import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_CLASSIFIER_THRESHOLDS,
  decodeCanonicalColor4Raster,
} from "../shared/color4/classifier.ts";
import {
  ACTIVE_MODULES,
  BOOTSTRAP_COLUMNS,
  FIDUCIALS,
  FIDUCIAL_PAYLOADS,
  PHY_VERSION,
  QUIET_MODULES,
  QUIET_ZONE_FRACTION,
  TOTAL_MODULES,
  createPhysicalLayout,
  crc8Atm,
  decodeBootstrap,
  decodePhasePilot,
  encodeBootstrap,
  encodePhasePilot,
  fiducialModule,
} from "../shared/color4/physical.ts";
import {
  EXPERIMENTAL_PROFILE,
  ROBUST_PROFILE,
} from "../shared/color4/profiles.ts";
import { rasterizeColor4, type Color4Raster } from "../shared/color4/raster.ts";

function deterministicBytes(length: number): Uint8Array {
  return Uint8Array.from({ length }, (_, index) => (index * 73 + 19) & 0xff);
}

function rowBytes(modules: Uint8Array, row: number): Uint8Array {
  const bytes = new Uint8Array(3);
  for (let column = 0; column < BOOTSTRAP_COLUMNS; column++) {
    const byteIndex = column >>> 3;
    bytes[byteIndex] =
      bytes[byteIndex]! |
      (modules[row * BOOTSTRAP_COLUMNS + column]! << (7 - (column & 7)));
  }
  return bytes;
}

function rotatePayload(payload: readonly string[]): readonly string[] {
  return Array.from({ length: 5 }, (_, y) =>
    Array.from({ length: 5 }, (_, x) => payload[4 - x]![y]).join(""),
  );
}

function rotations(payload: readonly string[]): readonly (readonly string[])[] {
  const out: (readonly string[])[] = [];
  let current = payload;
  for (let index = 0; index < 4; index++) {
    out.push(current);
    current = rotatePayload(current);
  }
  return out;
}

function hamming(left: readonly string[], right: readonly string[]): number {
  let distance = 0;
  for (let y = 0; y < 5; y++) {
    for (let x = 0; x < 5; x++) {
      if (left[y]![x] !== right[y]![x]) distance++;
    }
  }
  return distance;
}

function rgbaAtModule(raster: Color4Raster, activeX: number, activeY: number): number[] {
  const x = (activeX + QUIET_MODULES) * raster.moduleScale;
  const y = (activeY + QUIET_MODULES) * raster.moduleScale;
  const offset = (y * raster.width + x) * 4;
  return [...raster.pixels.subarray(offset, offset + 4)];
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
      raster.pixels[offset + 3] = 0xff;
    }
  }
}

interface RgbaImage {
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint8ClampedArray<ArrayBuffer>;
}

function rotateClockwise(image: RgbaImage): RgbaImage {
  const pixels = new Uint8ClampedArray(image.pixels.length);
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      const source = (y * image.width + x) * 4;
      const targetX = image.height - 1 - y;
      const targetY = x;
      const target = (targetY * image.height + targetX) * 4;
      pixels.set(image.pixels.subarray(source, source + 4), target);
    }
  }
  return { width: image.height, height: image.width, pixels };
}

function rotateImage(image: RgbaImage, quarterTurns: number): RgbaImage {
  let out = image;
  for (let turn = 0; turn < (quarterTurns & 3); turn++) out = rotateClockwise(out);
  return out;
}

function applyCameraCurve(raster: Color4Raster): void {
  const whiteBalance = [1.04, 0.97, 1.02] as const;
  let noiseState = 0x4c414234;
  for (let offset = 0; offset < raster.pixels.length; offset += 4) {
    noiseState = (Math.imul(noiseState, 1664525) + 1013904223) >>> 0;
    const noise = ((noiseState >>> 28) - 8) * 0.55;
    for (let channel = 0; channel < 3; channel++) {
      const normalized = raster.pixels[offset + channel]! / 255;
      const curved = 255 * 0.93 * normalized ** 0.88 * whiteBalance[channel]! + noise;
      // Small channel quantization approximates a lossy camera/JPEG pipeline.
      raster.pixels[offset + channel] = Math.round(curved / 4) * 4;
    }
  }
}

function boxBlur3x3(image: RgbaImage): Uint8ClampedArray<ArrayBuffer> {
  const out = new Uint8ClampedArray(image.pixels);
  for (let y = 1; y < image.height - 1; y++) {
    for (let x = 1; x < image.width - 1; x++) {
      const target = (y * image.width + x) * 4;
      for (let channel = 0; channel < 3; channel++) {
        let sum = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            sum += image.pixels[((y + dy) * image.width + x + dx) * 4 + channel]!;
          }
        }
        out[target + channel] = Math.round(sum / 9);
      }
    }
  }
  return out;
}

test("COLOR_4 geometry pins the active square, quiet zone and both profile grids", () => {
  assert.equal(ACTIVE_MODULES, 160);
  assert.equal(QUIET_MODULES, 6);
  assert.equal(TOTAL_MODULES, 172);
  assert.ok(Math.abs(QUIET_ZONE_FRACTION - 0.035) < 0.0002);

  const robust = createPhysicalLayout(ROBUST_PROFILE);
  assert.deepEqual(robust.data, { x: 44, y: 37, width: 72, height: 85 });
  assert.deepEqual(robust.bootstrap, { x: 68, y: 14, width: 24, height: 3 });
  assert.deepEqual(robust.timing, {
    top: { x: 44, y: 36, width: 72, height: 1 },
    right: { x: 116, y: 37, width: 1, height: 85 },
    bottom: { x: 44, y: 122, width: 72, height: 1 },
    left: { x: 43, y: 37, width: 1, height: 85 },
  });
  assert.deepEqual(robust.phasePilots, {
    top: { x: 78, y: 34, width: 4, height: 1 },
    bottom: { x: 78, y: 124, width: 4, height: 1 },
  });
  assert.deepEqual(
    robust.calibration.left.map(({ name, x, y, width, height }) => ({ name, x, y, width, height })),
    ["K", "W", "C", "M", "Y", "G50"].map((name, index) => ({
      name,
      x: 39,
      y: 43 + index * 14,
      width: 2,
      height: 2,
    })),
  );
  assert.deepEqual(
    robust.calibration.right.map(({ name, x, y, width, height }) => ({ name, x, y, width, height })),
    ["K", "W", "C", "M", "Y", "G50"].map((name, index) => ({
      name,
      x: 119,
      y: 43 + index * 14,
      width: 2,
      height: 2,
    })),
  );

  const experimental = createPhysicalLayout(EXPERIMENTAL_PROFILE);
  assert.deepEqual(experimental.data, { x: 20, y: 20, width: 120, height: 119 });
  assert.deepEqual(experimental.timing, {
    top: { x: 20, y: 19, width: 120, height: 1 },
    right: { x: 140, y: 20, width: 1, height: 119 },
    bottom: { x: 20, y: 139, width: 120, height: 1 },
    left: { x: 19, y: 20, width: 1, height: 119 },
  });
  assert.deepEqual(experimental.phasePilots, {
    top: { x: 78, y: 17, width: 4, height: 1 },
    bottom: { x: 78, y: 141, width: 4, height: 1 },
  });
  assert.deepEqual(
    experimental.calibration.left.map(({ name, x, y, width, height }) => ({ name, x, y, width, height })),
    ["K", "W", "C", "M", "Y", "G50"].map((name, index) => ({
      name,
      x: 15,
      y: 28 + index * 20,
      width: 2,
      height: 2,
    })),
  );
  assert.deepEqual(
    experimental.calibration.right.map(({ name, x, y, width, height }) => ({ name, x, y, width, height })),
    ["K", "W", "C", "M", "Y", "G50"].map((name, index) => ({
      name,
      x: 143,
      y: 28 + index * 20,
      width: 2,
      height: 2,
    })),
  );
  assert.deepEqual(
    FIDUCIALS.map(({ id, x, y, width, height }) => ({ id, x, y, width, height })),
    [
      { id: "TL", x: 7, y: 7, width: 9, height: 9 },
      { id: "TR", x: 144, y: 7, width: 9, height: 9 },
      { id: "BR", x: 144, y: 144, width: 9, height: 9 },
      { id: "BL", x: 7, y: 144, width: 9, height: 9 },
    ],
  );
});

test("frozen fiducial payloads retain Hamming distance under every rotation", () => {
  assert.deepEqual(FIDUCIAL_PAYLOADS, {
    TL: ["10111", "01000", "11011", "11001", "01101"],
    TR: ["11101", "11101", "11100", "10010", "01010"],
    BR: ["00001", "11100", "11110", "01000", "01100"],
    BL: ["11100", "00010", "00010", "10110", "00010"],
  });
  const entries = Object.entries(FIDUCIAL_PAYLOADS);
  for (const [, payload] of entries) {
    for (const rotated of rotations(payload).slice(1)) {
      assert.ok(hamming(payload, rotated) >= 10);
    }
  }
  for (let first = 0; first < entries.length; first++) {
    for (let second = first + 1; second < entries.length; second++) {
      const left = entries[first]![1];
      const right = entries[second]![1];
      const minimum = Math.min(
        ...rotations(left).flatMap((a) => rotations(right).map((b) => hamming(a, b))),
      );
      assert.ok(minimum >= 10, `${entries[first]![0]}/${entries[second]![0]} = ${minimum}`);
    }
  }

  // The structural 9 x 9 border/ring is part of the normative marker too.
  assert.equal(fiducialModule("TL", 0, 4), 1);
  assert.equal(fiducialModule("TL", 1, 4), 0);
  assert.equal(fiducialModule("TL", 2, 2), 1);
});

test("bootstrap has a pinned CRC and word/complement/word redundancy", () => {
  assert.equal(crc8Atm(new TextEncoder().encode("123456789")), 0xf4);
  const modules = encodeBootstrap({
    version: PHY_VERSION,
    profileId: 1,
    paletteId: 0,
    sequencePhase: 2,
  });
  assert.deepEqual([...rowBytes(modules, 0)], [0xd5, 0x26, 0x09]);
  assert.deepEqual([...rowBytes(modules, 1)], [0x2a, 0xd9, 0xf6]);
  assert.deepEqual([...rowBytes(modules, 2)], [0xd5, 0x26, 0x09]);
  assert.deepEqual(decodeBootstrap(modules), {
    version: 1,
    profileId: 1,
    paletteId: 0,
    sequencePhase: 2,
  });

  // Losing a complete row still leaves two agreeing copies.
  modules.fill(0xff, BOOTSTRAP_COLUMNS, 2 * BOOTSTRAP_COLUMNS);
  assert.equal(decodeBootstrap(modules)?.sequencePhase, 2);
});

test("phase pilots use repeated two-bit Gray code", () => {
  assert.deepEqual([...encodePhasePilot(0)], [0, 0, 0, 0]);
  assert.deepEqual([...encodePhasePilot(1)], [0, 1, 0, 1]);
  assert.deepEqual([...encodePhasePilot(2)], [1, 1, 1, 1]);
  assert.deepEqual([...encodePhasePilot(3)], [1, 0, 1, 0]);
  for (const phase of [0, 1, 2, 3] as const) {
    assert.equal(decodePhasePilot(encodePhasePilot(phase)), phase);
  }
  assert.equal(decodePhasePilot(new Uint8Array([0, 0, 1, 0])), null);
});

test("raster is canvas-independent RGBA and maps bytes MSB-first to KCMY", () => {
  const coded = new Uint8Array(ROBUST_PROFILE.codedBytes);
  coded[0] = 0x1b; // 00, 01, 10, 11
  const raster = rasterizeColor4(coded, {
    profile: ROBUST_PROFILE,
    paletteId: 0,
    sequence: 0,
    moduleScale: 2,
  });
  assert.equal(raster.width, TOTAL_MODULES * 2);
  assert.equal(raster.height, TOTAL_MODULES * 2);
  assert.equal(raster.pixels.length, raster.width * raster.height * 4);
  assert.deepEqual([...raster.pixels.subarray(0, 4)], [255, 255, 255, 255]);
  const { x, y } = raster.layout.data;
  assert.deepEqual(rgbaAtModule(raster, x, y), [0x10, 0x10, 0x10, 0xff]);
  assert.deepEqual(rgbaAtModule(raster, x + 1, y), [0x00, 0xd8, 0xd8, 0xff]);
  assert.deepEqual(rgbaAtModule(raster, x + 2, y), [0xd8, 0x00, 0xd8, 0xff]);
  assert.deepEqual(rgbaAtModule(raster, x + 3, y), [0xd8, 0xd8, 0x00, 0xff]);
});

test("canonical KCMY raster decodes every coded byte with no erasures", () => {
  const coded = deterministicBytes(ROBUST_PROFILE.codedBytes);
  const raster = rasterizeColor4(coded, {
    profile: ROBUST_PROFILE,
    paletteId: 0,
    sequence: 0x1234_567a,
    moduleScale: 3,
  });
  const decoded = decodeCanonicalColor4Raster(raster);
  assert.equal(decoded.status, "valid");
  if (decoded.status !== "valid") return;
  assert.equal(decoded.profile, ROBUST_PROFILE);
  assert.equal(decoded.paletteId, 0);
  assert.equal(decoded.sequencePhase, 2);
  assert.deepEqual(decoded.codedBytes, coded);
  assert.deepEqual([...decoded.byteErasures], []);
  assert.equal(decoded.diagnostics.uncertainCells, 0);
  assert.equal(decoded.diagnostics.moduleScale, 3);
});

test("canonical experimental KRGB raster uses the same decoder path", () => {
  const coded = deterministicBytes(EXPERIMENTAL_PROFILE.codedBytes);
  const raster = rasterizeColor4(coded, {
    profile: EXPERIMENTAL_PROFILE,
    paletteId: 1,
    sequence: 3,
  });
  const decoded = decodeCanonicalColor4Raster(raster, {
    thresholds: { maximumDeltaE: 32 },
  });
  assert.equal(decoded.status, "valid");
  if (decoded.status !== "valid") return;
  assert.deepEqual(decoded.codedBytes, coded);
  assert.equal(decoded.profile, EXPERIMENTAL_PROFILE);
  assert.equal(decoded.paletteId, 1);
  assert.equal(decoded.sequencePhase, 3);
  assert.equal(decoded.byteErasures.length, 0);
});

test("all four camera rotations decode after the vision layer restores orientation", () => {
  const coded = deterministicBytes(ROBUST_PROFILE.codedBytes);
  const canonical = rasterizeColor4(coded, {
    profile: ROBUST_PROFILE,
    paletteId: 0,
    sequence: 1,
  });
  for (let capturedTurns = 0; capturedTurns < 4; capturedTurns++) {
    const captured = rotateImage(canonical, capturedTurns);
    // This is the explicit contract with the camera worker: locate marker IDs,
    // rotate/warp the ROI, then call the pure canonical decoder.
    const normalized = rotateImage(captured, (4 - capturedTurns) & 3);
    const decoded = decodeCanonicalColor4Raster(normalized);
    assert.equal(decoded.status, "valid", `rotation ${capturedTurns * 90} degrees`);
    if (decoded.status === "valid") assert.deepEqual(decoded.codedBytes, coded);
  }
});

test("calibration survives gamma, exposure, white balance, noise, blur and quantization", () => {
  const coded = deterministicBytes(ROBUST_PROFILE.codedBytes);
  const raster = rasterizeColor4(coded, {
    profile: ROBUST_PROFILE,
    paletteId: 0,
    sequence: 2,
    moduleScale: 4,
  });
  applyCameraCurve(raster);
  const pixels = boxBlur3x3(raster);
  const decoded = decodeCanonicalColor4Raster({
    width: raster.width,
    height: raster.height,
    pixels,
  });
  assert.equal(decoded.status, "valid");
  if (decoded.status !== "valid") return;
  assert.deepEqual(decoded.codedBytes, coded);
  assert.deepEqual([...decoded.byteErasures], []);
  assert.ok(decoded.diagnostics.observedContrast >= 150);
});

test("one uncertain cell marks its complete coded byte as an erasure", () => {
  const coded = deterministicBytes(ROBUST_PROFILE.codedBytes);
  const raster = rasterizeColor4(coded, {
    profile: ROBUST_PROFILE,
    paletteId: 0,
    sequence: 0,
    moduleScale: 4,
  });
  paintActiveModule(raster, raster.layout.data.x, raster.layout.data.y, [128, 128, 128]);
  const decoded = decodeCanonicalColor4Raster(raster);
  assert.equal(decoded.status, "valid");
  if (decoded.status !== "valid") return;
  assert.deepEqual([...decoded.byteErasures], [0]);
  assert.equal(decoded.diagnostics.erasureBytes, 1);
  assert.equal(decoded.diagnostics.uncertainCells, 1);
});

test("different top and bottom pilots reject a transition frame before color decode", () => {
  const raster = rasterizeColor4(new Uint8Array(ROBUST_PROFILE.codedBytes), {
    profile: ROBUST_PROFILE,
    paletteId: 0,
    sequence: 0,
    moduleScale: 2,
  });
  const phaseOne = encodePhasePilot(1);
  for (let index = 0; index < 4; index++) {
    const value = phaseOne[index] === 1 ? 0 : 255;
    paintActiveModule(
      raster,
      raster.layout.phasePilots.bottom.x + index,
      raster.layout.phasePilots.bottom.y,
      [value, value, value],
    );
  }
  const decoded = decodeCanonicalColor4Raster(raster);
  assert.equal(decoded.status, "rejected");
  if (decoded.status === "rejected") assert.equal(decoded.reason, "phase_mismatch");
});

test("damaged complementary timing rails reject geometry before color decode", () => {
  const raster = rasterizeColor4(new Uint8Array(ROBUST_PROFILE.codedBytes), {
    profile: ROBUST_PROFILE,
    paletteId: 0,
    sequence: 0,
    moduleScale: 2,
  });
  for (let x = 0; x < raster.layout.timing.top.width; x++) {
    paintActiveModule(
      raster,
      raster.layout.timing.top.x + x,
      raster.layout.timing.top.y,
      [255, 255, 255],
    );
  }
  const decoded = decodeCanonicalColor4Raster(raster);
  assert.equal(decoded.status, "rejected");
  if (decoded.status === "rejected") {
    assert.equal(decoded.reason, "invalid_geometry");
    assert.ok(decoded.diagnostics.timingErrors > 0);
  }
});

test("invalid canonical dimensions and damaged fiducials fail closed", () => {
  const invalid = decodeCanonicalColor4Raster({
    width: TOTAL_MODULES,
    height: TOTAL_MODULES - 1,
    pixels: new Uint8Array(TOTAL_MODULES * (TOTAL_MODULES - 1) * 4),
  });
  assert.equal(invalid.status, "rejected");
  if (invalid.status === "rejected") assert.equal(invalid.reason, "invalid_dimensions");

  const raster = rasterizeColor4(new Uint8Array(ROBUST_PROFILE.codedBytes), {
    profile: ROBUST_PROFILE,
    paletteId: 0,
    sequence: 0,
  });
  for (let y = 0; y < 9; y++) {
    for (let x = 0; x < 9; x++) paintActiveModule(raster, 7 + x, 7 + y, [255, 255, 255]);
  }
  const damaged = decodeCanonicalColor4Raster(raster, {
    thresholds: { maximumFiducialErrors: DEFAULT_CLASSIFIER_THRESHOLDS.maximumFiducialErrors },
  });
  assert.equal(damaged.status, "rejected");
  if (damaged.status === "rejected") assert.equal(damaged.reason, "invalid_geometry");
});
