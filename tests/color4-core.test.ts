import assert from "node:assert/strict";
import test from "node:test";
import {
  COLOR4_FLAGS,
  COLOR4_OUTER_HEADER_BYTES,
  COLOR4_PHY_VERSION,
  COLOR4_PROFILES,
  EXPERIMENTAL_PROFILE,
  ROBUST_PROFILE,
  ReedSolomonCodec,
  appendCrc32c,
  color4WhiteningSeed,
  crc8Atm,
  crc32c,
  deinterleaveCodewords,
  encodeColor4PduForTesting,
  getColor4Profile,
  interleaveCodewords,
  interleavedIndex,
  parseColor4OuterHeader,
  shardPosition,
  unwrapColor4Frame,
  whiten,
  whitenInPlace,
  wrapColor4Frame,
  type Color4PaletteId,
  type Color4Profile,
} from "../shared/color4/index.ts";
import { fnv1a, packFrame, splitmix32 } from "../shared/protocol.ts";

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join(" ");
}

function deterministicBytes(length: number, salt = 0): Uint8Array {
  return Uint8Array.from({ length }, (_, index) => (index * 37 + (index >> 8) * 11 + salt) & 0xff);
}

function innerFrame(profile: Color4Profile, paletteSalt = 0): Uint8Array {
  const totalLen = 12_345;
  return packFrame(
    {
      sessionId: 0xbeef,
      seq: 0x10203040,
      k: Math.ceil(totalLen / profile.blockBytes),
      blockLen: profile.blockBytes,
      totalLen,
      payloadFnv: 0x89abcdef,
    },
    Uint8Array.from(
      { length: profile.blockBytes },
      (_, index) => (index * 37 + 7 + paletteSalt) & 0xff,
    ),
  );
}

function recodePdu(
  pdu: Uint8Array,
  profile: Color4Profile,
  paletteId: Color4PaletteId,
): Uint8Array {
  const coded = encodeColor4PduForTesting(pdu, profile);
  whitenInPlace(coded, profile.id, paletteId);
  return coded;
}

test("COLOR_4 profiles pin their complete byte/cell geometry", () => {
  assert.deepEqual(COLOR4_PROFILES, [ROBUST_PROFILE, EXPERIMENTAL_PROFILE]);
  assert.deepEqual(
    COLOR4_PROFILES.map((profile) => ({
      id: profile.id,
      grid: `${profile.columns}x${profile.rows}`,
      rs: `${profile.shards}xRS(${profile.rsN},${profile.rsK})`,
      coded: profile.codedBytes,
      pdu: profile.pduBytes,
      inner: profile.innerFrameBytes,
      block: profile.blockBytes,
    })),
    [
      { id: 1, grid: "72x85", rs: "6xRS(255,223)", coded: 1530, pdu: 1338, inner: 1318, block: 1298 },
      { id: 2, grid: "120x119", rs: "14xRS(255,239)", coded: 3570, pdu: 3346, inner: 3326, block: 3306 },
    ],
  );
  for (const profile of COLOR4_PROFILES) {
    assert.equal(profile.columns * profile.rows, profile.codedBytes * 4);
    assert.equal(profile.shards * profile.rsN, profile.codedBytes);
    assert.equal(profile.shards * profile.rsK, profile.pduBytes);
    assert.equal(profile.innerFrameBytes, profile.blockBytes + 20);
    assert.equal(profile.pduBytes, profile.innerFrameBytes + COLOR4_OUTER_HEADER_BYTES + 4);
    assert.equal(getColor4Profile(profile.id), profile);
  }
  assert.equal(getColor4Profile(0), undefined);
  assert.equal(getColor4Profile(3), undefined);
});

test("both profiles keep the largest legal DCF2 container below k:u16", () => {
  const largestContainer = 64 * 1024 * 1024 + 49 + 2 * 0xffff;
  assert.equal(largestContainer, 67_239_983);
  assert.equal(Math.ceil(largestContainer / ROBUST_PROFILE.blockBytes), 51_803);
  assert.equal(Math.ceil(largestContainer / EXPERIMENTAL_PROFILE.blockBytes), 20_339);
});

test("CRC algorithms match their standard check vectors", () => {
  const check = new TextEncoder().encode("123456789");
  assert.equal(crc8Atm(check), 0xf4);
  assert.equal(crc32c(check), 0xe3069283);
  assert.equal(hex(appendCrc32c(check).subarray(check.length)), "83 92 06 e3");
});

test("whitening seed, endian consumption and stream are golden", () => {
  const source = Uint8Array.from({ length: 16 }, (_, index) => index);
  const golden: readonly [number, number, number, string][] = [
    [1, 0, 0x434f4d34, "98 b0 61 e2 91 77 1c a7 32 0f 6e 81 e6 59 b1 ce"],
    [1, 1, 0x434f4d35, "de c9 11 0b 76 c2 91 01 86 de bc 8a 14 55 5c 62"],
    [2, 0, 0x434f4e34, "e0 e1 7d 08 52 f2 b0 8d a4 9a 68 33 ad a7 29 b8"],
    [2, 1, 0x434f4e35, "4e 05 0e 19 62 c7 36 cd 38 aa 2a 40 95 38 12 4e"],
  ];
  for (const [profileId, paletteId, seed, expected] of golden) {
    assert.equal(color4WhiteningSeed(profileId, paletteId), seed);
    const whitened = whiten(source, profileId, paletteId);
    assert.equal(hex(whitened), expected);
    whitenInPlace(whitened, profileId, paletteId);
    assert.deepEqual(whitened, source, "whitening must be its own inverse");
  }
});

test("interleaving is position-major and exactly reversible", () => {
  const codewords = [
    new Uint8Array([0, 1, 2, 3]),
    new Uint8Array([10, 11, 12, 13]),
    new Uint8Array([20, 21, 22, 23]),
  ];
  const interleaved = interleaveCodewords(codewords, 4);
  assert.deepEqual(interleaved, new Uint8Array([0, 10, 20, 1, 11, 21, 2, 12, 22, 3, 13, 23]));
  assert.deepEqual(deinterleaveCodewords(interleaved, 3, 4), codewords);
  for (let shard = 0; shard < 3; shard++) {
    for (let position = 0; position < 4; position++) {
      const index = interleavedIndex(shard, position, 3);
      assert.deepEqual(shardPosition(index, 3), { shard, position });
    }
  }
});

test("RS(255,k) systematic encoders match recorded parity vectors", () => {
  const golden: readonly [number, number, string, number][] = [
    [
      223,
      32,
      "3e d5 77 e3 fe 7c 10 65 42 ed 72 e9 99 e5 0a aa 9d 46 6a e0 ed 59 b1 83 8d 41 c2 d8 47 d9 be 27",
      0x16e56199,
    ],
    [239, 16, "b1 7a de d0 ae 31 ca 15 64 79 3b 96 50 b7 47 33", 0x22891315],
  ];
  for (const [dataBytes, parityBytes, expectedParity, expectedFnv] of golden) {
    const data = Uint8Array.from({ length: dataBytes }, (_, index) => (index * 37 + 11) & 0xff);
    const codeword = new ReedSolomonCodec(dataBytes, parityBytes).encode(data);
    assert.deepEqual(codeword.subarray(0, dataBytes), data, "the code is systematic");
    assert.equal(hex(codeword.subarray(dataBytes)), expectedParity);
    assert.equal(fnv1a(codeword), expectedFnv);
  }
});

function damage(
  source: Uint8Array,
  count: number,
  start: number,
  stride: number,
): { damaged: Uint8Array; positions: number[] } {
  const damaged = source.slice();
  const positions: number[] = [];
  let candidate = start;
  while (positions.length < count) {
    const position = candidate % source.length;
    candidate += stride;
    if (positions.includes(position)) continue;
    positions.push(position);
    damaged[position] = damaged[position]! ^ (((positions.length * 29) % 255) + 1);
  }
  return { damaged, positions };
}

test("RS decoders meet the exact error and erasure limits", () => {
  for (const [dataBytes, parityBytes] of [[223, 32], [239, 16]] as const) {
    const codec = new ReedSolomonCodec(dataBytes, parityBytes);
    const data = deterministicBytes(dataBytes, parityBytes);
    const codeword = codec.encode(data);

    const atErrorLimit = damage(codeword, parityBytes / 2, 3, 13);
    const errorsDecoded = codec.decode(atErrorLimit.damaged);
    assert.equal(errorsDecoded.status, "corrected");
    if (errorsDecoded.status === "corrected") {
      assert.equal(errorsDecoded.errors, parityBytes / 2);
      assert.deepEqual(errorsDecoded.data, data);
    }

    const atErasureLimit = damage(codeword, parityBytes, 2, 7);
    const erasuresDecoded = codec.decode(atErasureLimit.damaged, atErasureLimit.positions);
    assert.equal(erasuresDecoded.status, "corrected");
    if (erasuresDecoded.status === "corrected") {
      assert.equal(erasuresDecoded.erasures, parityBytes);
      assert.deepEqual(erasuresDecoded.data, data);
    }

    const aboveErrors = damage(codeword, parityBytes / 2 + 1, 5, 11);
    assert.equal(codec.decode(aboveErrors.damaged).status, "uncorrectable");

    const aboveErasures = damage(codeword, parityBytes + 1, 7, 19);
    assert.equal(
      codec.decode(aboveErasures.damaged, aboveErasures.positions).status,
      "uncorrectable",
    );
  }
});

test("RS decoders recover mixed damage whenever 2E + S <= parity", () => {
  for (const [dataBytes, parityBytes] of [[223, 32], [239, 16]] as const) {
    const codec = new ReedSolomonCodec(dataBytes, parityBytes);
    const random = splitmix32(dataBytes);
    for (let trial = 0; trial < 80; trial++) {
      const data = deterministicBytes(dataBytes, trial);
      const codeword = codec.encode(data);
      const erasureCount = trial % (parityBytes + 1);
      const errorCount = Math.floor((parityBytes - erasureCount) / 2);
      const damaged = codeword.slice();
      const erasures = new Set<number>();
      while (erasures.size < erasureCount) erasures.add(random() % codec.codewordBytes);
      for (const position of erasures) {
        damaged[position] = damaged[position]! ^ ((random() & 0xff) || 1);
      }
      const errors = new Set<number>();
      while (errors.size < errorCount) {
        const position = random() % codec.codewordBytes;
        if (!erasures.has(position)) errors.add(position);
      }
      for (const position of errors) {
        damaged[position] = damaged[position]! ^ ((random() & 0xff) || 1);
      }

      const decoded = codec.decode(damaged, erasures);
      assert.equal(decoded.status, "corrected", `trial ${trial}, 2E+S=${2 * errorCount + erasureCount}`);
      if (decoded.status === "corrected") assert.deepEqual(decoded.data, data);
    }
  }
});

test("outer header and full encoded frames are golden", () => {
  const golden: readonly [Color4Profile, number, number][] = [
    [ROBUST_PROFILE, 0x2c19f81d, 0xd380af31],
    [EXPERIMENTAL_PROFILE, 0xa3dc0e81, 0xd7a438f7],
  ];
  for (const [profile, pduFnv, codedFnv] of golden) {
    const wrapped = wrapColor4Frame(innerFrame(profile), { profileId: profile.id, paletteId: 0 });
    assert.equal(
      hex(wrapped.pdu.subarray(0, COLOR4_OUTER_HEADER_BYTES)),
      `44 43 34 01 0${profile.id} 00 03 10 ${profile.id === 1 ? "26 05" : "fe 0c"} ef be 40 30 20 10`,
    );
    assert.equal(fnv1a(wrapped.pdu), pduFnv);
    assert.equal(fnv1a(wrapped.codedBytes), codedFnv);
    assert.deepEqual(parseColor4OuterHeader(wrapped.pdu), wrapped.header);
    assert.equal(wrapped.header.phyVersion, COLOR4_PHY_VERSION);
    assert.equal(wrapped.header.flags, COLOR4_FLAGS);
  }
});

test("wrap/unwrap returns the exact original packFrame for every profile and palette", () => {
  for (const profile of COLOR4_PROFILES) {
    for (const paletteId of [0, 1] as const) {
      const inner = innerFrame(profile, paletteId);
      const wrapped = wrapColor4Frame(inner, { profileId: profile.id, paletteId });
      const decoded = unwrapColor4Frame(wrapped.codedBytes);
      assert.equal(decoded.status, "valid");
      if (decoded.status === "valid") {
        assert.deepEqual(decoded.innerFrame, inner);
        assert.equal(decoded.header.sessionId, 0xbeef);
        assert.equal(decoded.header.sequence, 0x10203040);
        assert.equal(decoded.header.paletteId, paletteId);
      }
    }
  }
});

test("high-level unwrap corrects full per-shard errors and typed-array erasures", () => {
  for (const profile of COLOR4_PROFILES) {
    const inner = innerFrame(profile);
    const wrapped = wrapColor4Frame(inner, { profileId: profile.id, paletteId: 0 });

    const unknown = wrapped.codedBytes.slice();
    const unknownLimit = (profile.rsN - profile.rsK) / 2;
    for (let position = 0; position < unknownLimit; position++) {
      const index = interleavedIndex(0, position * 7, profile.shards);
      unknown[index] = unknown[index]! ^ (position + 1);
    }
    const unknownDecoded = unwrapColor4Frame(unknown, { profileId: profile.id, paletteId: 0 });
    assert.equal(unknownDecoded.status, "valid");
    if (unknownDecoded.status === "valid") {
      assert.deepEqual(unknownDecoded.innerFrame, inner);
      assert.equal(unknownDecoded.diagnostics.correctedErrors, unknownLimit);
    }

    const erased = wrapped.codedBytes.slice();
    const erasureLimit = profile.rsN - profile.rsK;
    const erasureIndices = new Uint16Array(erasureLimit);
    for (let position = 0; position < erasureLimit; position++) {
      const index = interleavedIndex(profile.shards - 1, position * 5, profile.shards);
      erasureIndices[position] = index;
      erased[index] = erased[index]! ^ (position + 17);
    }
    const erasedDecoded = unwrapColor4Frame(erased, {
      profileId: profile.id,
      paletteId: 0,
      erasures: erasureIndices,
    });
    assert.equal(erasedDecoded.status, "valid");
    if (erasedDecoded.status === "valid") {
      assert.deepEqual(erasedDecoded.innerFrame, inner);
      assert.equal(erasedDecoded.diagnostics.erasures, erasureLimit);
    }
  }
});

test("semantic envelope corruption is rejected only after successful FEC", () => {
  const profile = ROBUST_PROFILE;
  const wrapped = wrapColor4Frame(innerFrame(profile), { profileId: 1, paletteId: 0 });

  const staleCrc = wrapped.pdu.slice();
  const staleCrcIndex = COLOR4_OUTER_HEADER_BYTES + 100;
  staleCrc[staleCrcIndex] = staleCrc[staleCrcIndex]! ^ 1;
  assert.equal(unwrapColor4Frame(recodePdu(staleCrc, profile, 0)).status, "rejected");
  assert.deepEqual(unwrapColor4Frame(recodePdu(staleCrc, profile, 0)), {
    status: "rejected",
    reason: "crc-mismatch",
    diagnostics: {
      profileId: 1,
      paletteId: 0,
      erasures: 0,
      correctedErrors: 0,
      correctedBytes: 0,
      correctedShards: 0,
      attemptedProfiles: 1,
      attemptedPalettes: 1,
    },
  });

  const mismatchedIdentityBody = wrapped.pdu.slice(0, -4);
  new DataView(mismatchedIdentityBody.buffer).setUint16(10, 0x1234, true);
  const mismatchedIdentity = appendCrc32c(mismatchedIdentityBody);
  const identityResult = unwrapColor4Frame(recodePdu(mismatchedIdentity, profile, 0));
  assert.equal(identityResult.status, "rejected");
  if (identityResult.status === "rejected") assert.equal(identityResult.reason, "identity-mismatch");

  const badInnerBody = wrapped.pdu.slice(0, -4);
  badInnerBody[COLOR4_OUTER_HEADER_BYTES] = 0;
  const badInner = unwrapColor4Frame(recodePdu(appendCrc32c(badInnerBody), profile, 0));
  assert.equal(badInner.status, "rejected");
  if (badInner.status === "rejected") assert.equal(badInner.reason, "invalid-inner-frame");

  const badOuterBody = wrapped.pdu.slice(0, -4);
  badOuterBody[6] = 0;
  const badOuter = unwrapColor4Frame(recodePdu(appendCrc32c(badOuterBody), profile, 0));
  assert.equal(badOuter.status, "rejected");
  if (badOuter.status === "rejected") assert.equal(badOuter.reason, "invalid-outer-header");
});

test("invalid geometry, profile, palette and excessive damage fail closed", () => {
  const inner = innerFrame(ROBUST_PROFILE);
  const wrapped = wrapColor4Frame(inner, { profileId: 1, paletteId: 0 });
  assert.throws(
    () => wrapColor4Frame(inner.subarray(0, -1), { profileId: 1, paletteId: 0 }),
    /valid 1318-byte frame/,
  );
  assert.equal(unwrapColor4Frame(wrapped.codedBytes.subarray(0, -1)).status, "rejected");
  const wrongProfile = unwrapColor4Frame(wrapped.codedBytes, { profileId: 2 });
  assert.equal(wrongProfile.status, "rejected");
  if (wrongProfile.status === "rejected") assert.equal(wrongProfile.reason, "invalid-length");

  const excessive = wrapped.codedBytes.slice();
  for (let position = 0; position < 17; position++) {
    const index = interleavedIndex(0, position * 7, ROBUST_PROFILE.shards);
    excessive[index] = excessive[index]! ^ (position + 1);
  }
  const failed = unwrapColor4Frame(excessive, { profileId: 1, paletteId: 0 });
  assert.equal(failed.status, "rejected");
  if (failed.status === "rejected") assert.equal(failed.reason, "fec-uncorrectable");
});
