import assert from "node:assert/strict";
import test from "node:test";
import {
  EXPERIMENTAL_PROFILE,
  ROBUST_PROFILE,
  unwrapColor4Frame,
  wrapColor4Frame,
} from "../shared/color4/index.ts";
import { LTEncoder } from "../shared/fountain.ts";
import {
  MAX_FILE_BYTES,
  fnv1a,
  packFile,
  packFrame,
  unpackFile,
  verifyFile,
} from "../shared/protocol.ts";

/** Deterministic, incompressible-looking bytes without a second large buffer. */
function maximumPayload(): Uint8Array {
  const bytes = new Uint8Array(MAX_FILE_BYTES);
  let state = 0x12345678;
  for (let index = 0; index < bytes.length; index++) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    bytes[index] = state & 0xff;
  }
  return bytes;
}

test("the complete 64 MiB container with maximal UTF-8 metadata fits both profiles", async () => {
  const bytes = maximumPayload();
  const name = "n".repeat(0xffff);
  // Ends in +zip so the core correctly skips a pointless 64 MiB gzip attempt.
  const prefix = "application/";
  const suffix = "+zip";
  const type = prefix + "a".repeat(0xffff - prefix.length - suffix.length) + suffix;
  const packed = await packFile(name, type, bytes);

  assert.equal(packed.compression, "none");
  assert.equal(packed.container.length, 67_239_983);
  assert.equal(
    Math.ceil(packed.container.length / ROBUST_PROFILE.blockBytes),
    51_803,
  );
  assert.equal(
    Math.ceil(packed.container.length / EXPERIMENTAL_PROFILE.blockBytes),
    20_339,
  );

  const unpacked = await unpackFile(packed.container);
  assert.equal(unpacked.name, name);
  assert.equal(unpacked.type, type);
  assert.equal(unpacked.bytes.length, MAX_FILE_BYTES);
  assert.equal(await verifyFile(unpacked), true);
  assert.deepEqual(unpacked.bytes, bytes);

  const payloadFnv = fnv1a(packed.container);
  for (const profile of [ROBUST_PROFILE, EXPERIMENTAL_PROFILE]) {
    const encoder = new LTEncoder(packed.container, profile.blockBytes, 0xbeef);
    for (const sequence of [0, 0xffff_ffff]) {
      const innerFrame = packFrame(
        {
          sessionId: 0xbeef,
          seq: sequence,
          k: encoder.k,
          blockLen: profile.blockBytes,
          totalLen: packed.container.length,
          payloadFnv,
        },
        encoder.encode(sequence),
      );
      const wrapped = wrapColor4Frame(innerFrame, {
        profileId: profile.id,
        paletteId: 0,
      });
      const decoded = unwrapColor4Frame(wrapped.codedBytes, {
        profileId: profile.id,
        paletteId: 0,
      });
      assert.equal(decoded.status, "valid");
      if (decoded.status === "valid") assert.deepEqual(decoded.innerFrame, innerFrame);
    }
  }
});
