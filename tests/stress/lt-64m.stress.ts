import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { EXPERIMENTAL_PROFILE } from "../../shared/color4/profiles.ts";
import { LTDecoder, LTEncoder } from "../../shared/fountain.ts";
import {
  MAX_FILE_BYTES,
  MAX_CONTAINER_BYTES,
  fnv1a,
  packFile,
  packFrame,
  parseFrame,
  unpackFile,
  verifyFile,
} from "../../shared/protocol.ts";

const SESSION_ID = 0x64d4;
const MAX_FRAME_OVERHEAD = 3;
const MAX_NAME = "n".repeat(0xffff);
const TYPE_PREFIX = "application/";
const TYPE_SUFFIX = "+zip";
const MAX_TYPE =
  TYPE_PREFIX + "a".repeat(0xffff - TYPE_PREFIX.length - TYPE_SUFFIX.length) + TYPE_SUFFIX;

interface StressMetrics {
  readonly fileBytes: number;
  readonly containerBytes: number;
  readonly blockBytes: number;
  readonly sourceBlocks: number;
  readonly framesAccepted: number;
  readonly frameOverhead: number;
  readonly packMs: number;
  readonly fountainMs: number;
  readonly verifyMs: number;
  readonly totalMs: number;
  readonly baselineRssMiB: number;
  readonly peakRssMiB: number;
  readonly rssGrowthMiB: number;
}

/** Fill one 64 MiB allocation with a reproducible, incompressible-looking stream. */
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

function mib(bytes: number): number {
  return Math.round((bytes / 1024 / 1024) * 10) / 10;
}

function forceGc(): void {
  // This script is launched with --expose-gc. Keep the guard so a direct test
  // invocation remains a useful correctness run, albeit with noisier RSS.
  globalThis.gc?.();
}

test(
  "64 MiB crosses DCF2, the complete LT stream, frame parsing and SHA-256",
  { timeout: 15 * 60_000 },
  async (context) => {
    forceGc();
    const startedAt = performance.now();
    const baselineRss = process.memoryUsage().rss;
    let peakRss = baselineRss;
    const sampleRss = (): void => {
      peakRss = Math.max(peakRss, process.memoryUsage().rss);
    };

    const payload = maximumPayload();
    sampleRss();

    const packStartedAt = performance.now();
    // The +zip suffix declares already-compressed input, avoiding a second
    // 64 MiB gzip experiment while still exercising the absolute maximum DCF2
    // envelope: 64 MiB of data plus two 65,535-byte UTF-8 metadata fields.
    const packed = await packFile(MAX_NAME, MAX_TYPE, payload);
    const packMs = performance.now() - packStartedAt;
    assert.equal(packed.compression, "none");
    assert.equal(packed.originalSize, MAX_FILE_BYTES);
    assert.equal(packed.transmittedSize, MAX_FILE_BYTES);
    assert.equal(packed.container.length, MAX_CONTAINER_BYTES);
    sampleRss();

    const blockBytes = EXPERIMENTAL_PROFILE.blockBytes;
    const payloadFnv = fnv1a(packed.container);
    const encoder = new LTEncoder(packed.container, blockBytes, SESSION_ID);
    const decoder = new LTDecoder(
      encoder.k,
      blockBytes,
      SESSION_ID,
      packed.container.length,
    );
    assert.ok(encoder.k <= 0xffff, `k=${encoder.k} exceeds the Decimen u16 header`);
    sampleRss();

    const fountainStartedAt = performance.now();
    const frameCeiling = Math.ceil(encoder.k * MAX_FRAME_OVERHEAD);
    let sequence = 0;
    while (!decoder.isComplete && sequence < frameCeiling) {
      const frame = packFrame(
        {
          sessionId: SESSION_ID,
          seq: sequence,
          k: encoder.k,
          blockLen: blockBytes,
          totalLen: packed.container.length,
          payloadFnv,
        },
        encoder.encode(sequence),
      );
      const parsed = parseFrame(frame);
      if (!parsed) throw new Error(`self-generated frame ${sequence} was rejected`);
      if (
        parsed.header.sessionId !== SESSION_ID ||
        parsed.header.seq !== sequence ||
        parsed.header.k !== encoder.k ||
        parsed.header.blockLen !== blockBytes ||
        parsed.header.totalLen !== packed.container.length ||
        parsed.header.payloadFnv !== payloadFnv
      ) {
        throw new Error(`frame ${sequence} changed its stream identity`);
      }
      decoder.addFrame(parsed.header.seq, parsed.block);
      sequence++;
      if ((sequence & 0xff) === 0) sampleRss();
    }
    const fountainMs = performance.now() - fountainStartedAt;
    sampleRss();

    assert.ok(
      decoder.isComplete,
      `LT peeling stalled after ${decoder.framesNew}/${encoder.k} frames ` +
        `(ceiling ${MAX_FRAME_OVERHEAD.toFixed(1)}x)`,
    );
    const recoveredContainer = decoder.assemble();
    assert.ok(recoveredContainer);
    assert.equal(fnv1a(recoveredContainer), payloadFnv, "recovered container FNV changed");
    sampleRss();

    const verifyStartedAt = performance.now();
    const recovered = await unpackFile(recoveredContainer);
    assert.equal(recovered.name, MAX_NAME);
    assert.equal(recovered.type, MAX_TYPE);
    assert.equal(recovered.bytes.length, MAX_FILE_BYTES);
    assert.equal(await verifyFile(recovered), true, "recovered DCF2 SHA-256 changed");
    const verifyMs = performance.now() - verifyStartedAt;
    sampleRss();

    const totalMs = performance.now() - startedAt;
    const metrics: StressMetrics = {
      fileBytes: MAX_FILE_BYTES,
      containerBytes: packed.container.length,
      blockBytes,
      sourceBlocks: encoder.k,
      framesAccepted: decoder.framesNew,
      frameOverhead: Math.round((decoder.framesNew / encoder.k) * 10_000) / 10_000,
      packMs: Math.round(packMs),
      fountainMs: Math.round(fountainMs),
      verifyMs: Math.round(verifyMs),
      totalMs: Math.round(totalMs),
      baselineRssMiB: mib(baselineRss),
      peakRssMiB: mib(peakRss),
      rssGrowthMiB: mib(peakRss - baselineRss),
    };

    context.diagnostic(`STRESS_METRICS ${JSON.stringify(metrics)}`);
  },
);
