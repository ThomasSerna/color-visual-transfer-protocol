import assert from "node:assert/strict";
import test from "node:test";
import { LTDecoder, LTEncoder } from "../shared/fountain.ts";
import {
  fnv1a,
  packFrame,
  parseFrame,
  splitmix32,
  streamIdentity,
} from "../shared/protocol.ts";
import { decodeCanonicalColor4Raster } from "../shared/color4/classifier.ts";
import {
  interleavedIndex,
  unwrapColor4Frame,
  wrapColor4Frame,
} from "../shared/color4/index.ts";
import { QUIET_MODULES } from "../shared/color4/physical.ts";
import { ROBUST_PROFILE } from "../shared/color4/profiles.ts";
import {
  rasterizeColor4,
  type Color4Raster,
} from "../shared/color4/raster.ts";

interface RgbaImage {
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint8ClampedArray;
}

function deterministicBytes(length: number, salt = 0): Uint8Array {
  return Uint8Array.from(
    { length },
    (_, index) => (Math.imul(index, 73) + (index >>> 3) * 17 + salt) & 0xff,
  );
}

function makeInnerFrame(sessionId: number, sequence: number, salt = 0): Uint8Array {
  const totalLen = ROBUST_PROFILE.blockBytes * 3 - 17;
  return packFrame(
    {
      sessionId,
      seq: sequence,
      k: Math.ceil(totalLen / ROBUST_PROFILE.blockBytes),
      blockLen: ROBUST_PROFILE.blockBytes,
      totalLen,
      payloadFnv: (0x9e37_79b9 ^ salt) >>> 0,
    },
    deterministicBytes(ROBUST_PROFILE.blockBytes, salt + sequence),
  );
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
  let result = image;
  for (let turn = 0; turn < (quarterTurns & 3); turn++) {
    result = rotateClockwise(result);
  }
  return result;
}

/** A deterministic display/camera/JPEG-like curve applied before normalization. */
function applyOpticalDegradation(raster: Color4Raster): void {
  const whiteBalance = [1.04, 0.97, 1.02] as const;
  let state = 0x434f_4c34;
  for (let offset = 0; offset < raster.pixels.length; offset += 4) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    const noise = ((state >>> 28) - 8) * 0.55;
    for (let channel = 0; channel < 3; channel++) {
      const normalized = raster.pixels[offset + channel]! / 255;
      const exposed = 255 * 0.93 * normalized ** 0.88 * whiteBalance[channel]! + noise;
      // Four-level channel quantization approximates a lossy camera/JPEG path.
      raster.pixels[offset + channel] = Math.round(exposed / 4) * 4;
    }
  }
}

function boxBlur3x3(image: RgbaImage): RgbaImage {
  const pixels = new Uint8ClampedArray(image.pixels);
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
        pixels[target + channel] = Math.round(sum / 9);
      }
    }
  }
  return { width: image.width, height: image.height, pixels };
}

function paintModule(
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

function paintFirstCellOfByte(
  raster: Color4Raster,
  byteIndex: number,
  rgb: readonly [number, number, number],
): void {
  const cell = byteIndex * 4;
  const column = cell % ROBUST_PROFILE.columns;
  const row = Math.floor(cell / ROBUST_PROFILE.columns);
  paintModule(raster, raster.layout.data.x + column, raster.layout.data.y + row, rgb);
}

function decodeRasterThroughCarrier(raster: RgbaImage) {
  const visual = decodeCanonicalColor4Raster(raster);
  if (visual.status !== "valid") throw new Error(`visual reject: ${visual.reason}`);
  assert.equal(visual.status, "valid");
  return unwrapColor4Frame(visual.codedBytes, {
    profileId: visual.profile.id,
    paletteId: visual.paletteId,
    erasures: visual.byteErasures,
  });
}

test("degraded and rotated optical frames recover the exact legacy packFrame", () => {
  const inner = makeInnerFrame(0x4c34, 0x1020_3042, 7);
  const wrapped = wrapColor4Frame(inner, { profileId: 1, paletteId: 0 });
  const raster = rasterizeColor4(wrapped.codedBytes, {
    profile: ROBUST_PROFILE,
    paletteId: 0,
    sequence: 0x1020_3042,
    moduleScale: 4,
  });
  applyOpticalDegradation(raster);
  const captured = boxBlur3x3(raster);

  for (let turns = 0; turns < 4; turns++) {
    // Fiducial detection owns orientation. This exercises its contract with the
    // pure classifier by presenting the canonicalized result for every input rotation.
    const cameraFrame = rotateImage(captured, turns);
    const canonical = rotateImage(cameraFrame, (4 - turns) & 3);
    const decoded = decodeRasterThroughCarrier(canonical);
    assert.equal(decoded.status, "valid", `rotation ${turns * 90} degrees`);
    if (decoded.status === "valid") assert.deepEqual(decoded.innerFrame, inner);
  }
});

test("one uncertain cell per byte is corrected through the exact RS erasure boundary", () => {
  const inner = makeInnerFrame(0x2201, 19, 11);
  const wrapped = wrapColor4Frame(inner, { profileId: 1, paletteId: 0 });
  const parity = ROBUST_PROFILE.rsN - ROBUST_PROFILE.rsK;

  for (const erasureCount of [parity, parity + 1]) {
    const raster = rasterizeColor4(wrapped.codedBytes, {
      profile: ROBUST_PROFILE,
      paletteId: 0,
      sequence: 19,
      moduleScale: 3,
    });
    const expected = new Set<number>();
    for (let position = 0; position < erasureCount; position++) {
      const byteIndex = interleavedIndex(2, position, ROBUST_PROFILE.shards);
      expected.add(byteIndex);
      paintFirstCellOfByte(raster, byteIndex, [128, 128, 128]);
    }

    const visual = decodeCanonicalColor4Raster(raster);
    assert.equal(visual.status, "valid");
    if (visual.status !== "valid") continue;
    assert.deepEqual(new Set(visual.byteErasures), expected);
    const decoded = unwrapColor4Frame(visual.codedBytes, {
      profileId: 1,
      paletteId: 0,
      erasures: visual.byteErasures,
    });
    if (erasureCount === parity) {
      assert.equal(decoded.status, "valid");
      if (decoded.status === "valid") {
        assert.deepEqual(decoded.innerFrame, inner);
        assert.equal(decoded.diagnostics.erasures, parity);
      }
    } else {
      assert.equal(decoded.status, "rejected");
      if (decoded.status === "rejected") assert.equal(decoded.reason, "fec-uncorrectable");
    }
  }
});

test("synthetic errors and erasures can only correct exactly or reject", () => {
  const inner = makeInnerFrame(0x5a5a, 0x0102_0304, 29);
  const wrapped = wrapColor4Frame(inner, { profileId: 1, paletteId: 0 });
  const parity = ROBUST_PROFILE.rsN - ROBUST_PROFILE.rsK;
  const fixedCases = [
    { errors: 16, erasures: 0 },
    { errors: 0, erasures: 32 },
    { errors: 7, erasures: 18 },
    { errors: 17, erasures: 0 },
    { errors: 8, erasures: 18 },
    { errors: 4, erasures: 25 },
  ];
  const random = splitmix32(0xacc3_5701);
  const cases = [...fixedCases];
  for (let trial = 0; trial < 10; trial++) {
    cases.push({ errors: random() % 20, erasures: random() % 34 });
  }

  for (const [trial, damage] of cases.entries()) {
    const damagedCoded = wrapped.codedBytes.slice();
    const positions = Array.from({ length: ROBUST_PROFILE.rsN }, (_, index) => index);
    for (let index = positions.length - 1; index > 0; index--) {
      const swap = random() % (index + 1);
      [positions[index], positions[swap]] = [positions[swap]!, positions[index]!];
    }
    const errorPositions = positions.slice(0, damage.errors);
    const erasurePositions = positions.slice(damage.errors, damage.errors + damage.erasures);
    for (const position of errorPositions) {
      const byteIndex = interleavedIndex(0, position, ROBUST_PROFILE.shards);
      // Change one high dibit to another valid palette symbol: a confident error.
      damagedCoded[byteIndex] = damagedCoded[byteIndex]! ^ 0x40;
    }
    const raster = rasterizeColor4(damagedCoded, {
      profile: ROBUST_PROFILE,
      paletteId: 0,
      sequence: 0x0102_0304,
      moduleScale: 2,
    });
    for (const position of erasurePositions) {
      const byteIndex = interleavedIndex(0, position, ROBUST_PROFILE.shards);
      // The midpoint is deliberately not a palette symbol and must be erased.
      paintFirstCellOfByte(raster, byteIndex, [128, 128, 128]);
    }

    const visual = decodeCanonicalColor4Raster(raster);
    assert.equal(visual.status, "valid", `trial ${trial} visual classification`);
    if (visual.status !== "valid") continue;
    const decoded = unwrapColor4Frame(visual.codedBytes, {
      profileId: 1,
      paletteId: 0,
      erasures: visual.byteErasures,
    });
    if (decoded.status === "valid") {
      assert.deepEqual(decoded.innerFrame, inner, `trial ${trial} must never emit corruption`);
    }
    if (2 * damage.errors + damage.erasures <= parity) {
      assert.equal(decoded.status, "valid", `trial ${trial} is within 2E+S <= ${parity}`);
    }
  }
  assert.deepEqual(wrapped.codedBytes, wrapColor4Frame(inner, {
    profileId: 1,
    paletteId: 0,
  }).codedBytes, "decoding must not mutate the reusable encoded frame");
});

test("mixed fountain sessions remain separable after COLOR_4 unwrap", () => {
  const payloads = [deterministicBytes(3_113, 17), deterministicBytes(3_127, 91)];
  const sessions = [0x1111, 0x2222] as const;
  const encoders = payloads.map(
    (payload, index) => new LTEncoder(payload, ROBUST_PROFILE.blockBytes, sessions[index]!),
  );
  const decoders = new Map<string, LTDecoder>();
  const expectedByIdentity = new Map<string, Uint8Array>();

  for (let sequence = 0; sequence < 80; sequence++) {
    for (const streamIndex of [sequence & 1, (sequence + 1) & 1]) {
      const payload = payloads[streamIndex]!;
      const encoder = encoders[streamIndex]!;
      const header = {
        sessionId: sessions[streamIndex]!,
        seq: sequence,
        k: encoder.k,
        blockLen: ROBUST_PROFILE.blockBytes,
        totalLen: payload.length,
        payloadFnv: fnv1a(payload),
      };
      const identity = streamIdentity(header);
      expectedByIdentity.set(identity, payload);
      const inner = packFrame(header, encoder.encode(sequence));
      const wrapped = wrapColor4Frame(inner, { profileId: 1, paletteId: 0 });
      const optical = unwrapColor4Frame(wrapped.codedBytes, { profileId: 1, paletteId: 0 });
      assert.equal(optical.status, "valid");
      if (optical.status !== "valid") continue;
      const parsed = parseFrame(optical.innerFrame)!;
      const key = streamIdentity(parsed.header);
      let decoder = decoders.get(key);
      if (decoder === undefined) {
        decoder = new LTDecoder(
          parsed.header.k,
          parsed.header.blockLen,
          parsed.header.sessionId,
          parsed.header.totalLen,
        );
        decoders.set(key, decoder);
      }
      decoder.addFrame(parsed.header.seq, parsed.block);
      if ((sequence & 3) === 0) decoder.addFrame(parsed.header.seq, parsed.block);
    }
    if ([...decoders.values()].filter((decoder) => decoder.isComplete).length === 2) break;
  }

  assert.equal(decoders.size, 2);
  for (const [identity, decoder] of decoders) {
    assert.equal(decoder.isComplete, true, identity);
    assert.deepEqual(decoder.assemble(), expectedByIdentity.get(identity));
    assert.ok(decoder.framesDup > 0);
  }
});

test("pure wrap/visual/unwrap paths stay stateless over a bounded soak", () => {
  for (let sequence = 0; sequence < 48; sequence++) {
    const inner = makeInnerFrame(0x7007, sequence, sequence * 3);
    const innerFingerprint = fnv1a(inner);
    const wrapped = wrapColor4Frame(inner, { profileId: 1, paletteId: 0 });
    const codedFingerprint = fnv1a(wrapped.codedBytes);
    const raster = rasterizeColor4(wrapped.codedBytes, {
      profile: ROBUST_PROFILE,
      paletteId: 0,
      sequence,
    });
    const decoded = decodeRasterThroughCarrier(raster);
    assert.equal(decoded.status, "valid", `soak frame ${sequence}`);
    if (decoded.status === "valid") assert.equal(fnv1a(decoded.innerFrame), innerFingerprint);
    assert.equal(fnv1a(wrapped.codedBytes), codedFingerprint, "unwrap must not mutate input");
  }
});
