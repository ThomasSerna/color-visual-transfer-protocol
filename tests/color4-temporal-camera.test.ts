import assert from "node:assert/strict";
import test from "node:test";
import { FountainFrameGenerator } from "../send/fountain-frame.ts";
import { LTDecoder } from "../shared/fountain.ts";
import { TemporalFrameScheduler } from "../shared/frame-timing.ts";
import {
  packFile,
  parseFrame,
  unpackFile,
  verifyFile,
} from "../shared/protocol.ts";
import {
  unwrapColor4Frame,
  wrapColor4Frame,
} from "../shared/color4/envelope.ts";
import { EXPERIMENTAL_PROFILE } from "../shared/color4/profiles.ts";

const TRANSMIT_FPS = 15;
const CAMERA_FPS = [30, 60] as const;
const PALETTE_KCMY = 0 as const;
const SESSION_ID = 0x4c15;

interface DisplayFrame {
  readonly sequence: number;
  readonly codedBytes: Uint8Array;
}

function incompressiblePayload(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  let state = 0x15c4_30f0;
  for (let index = 0; index < bytes.length; index++) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    bytes[index] = state >>> 24;
  }
  return bytes;
}

/**
 * Drive the real sender hold policy from a synthetic camera clock. Since both
 * supported camera rates are exact multiples of 15 fps, every possible
 * discrete camera position inside one displayed frame is a finite tick offset.
 */
function cameraTimeline(
  cameraFps: 30 | 60,
  transmitFrames: number,
  generator: FountainFrameGenerator,
): Readonly<{ frames: readonly DisplayFrame[]; ticksPerTransmitFrame: number }> {
  const ticksPerTransmitFrame = cameraFps / TRANSMIT_FPS;
  assert.equal(Number.isInteger(ticksPerTransmitFrame), true);
  const scheduler = new TemporalFrameScheduler(
    TRANSMIT_FPS,
    EXPERIMENTAL_PROFILE.minHoldCycles,
  );
  assert.ok(Math.abs(scheduler.effectiveHoldMs - 1_000 / TRANSMIT_FPS) < 1e-9);

  const frames: DisplayFrame[] = [];
  let displayed: DisplayFrame | undefined;
  let nextSequence = 0;
  const cameraTickMs = 1_000 / cameraFps;
  const cameraTicks = transmitFrames * ticksPerTransmitFrame;
  for (let tick = 0; tick < cameraTicks; tick++) {
    const presented = scheduler.take(tick * cameraTickMs, () => {
      const sequence = nextSequence++;
      const innerFrame = generator.encode(sequence);
      const wrapped = wrapColor4Frame(innerFrame, {
        profileId: EXPERIMENTAL_PROFILE.id,
        paletteId: PALETTE_KCMY,
      });
      return { sequence, codedBytes: wrapped.codedBytes };
    });
    if (presented !== undefined) displayed = presented;
    assert.ok(displayed, `camera ${cameraFps} fps tick ${tick} has no displayed frame`);
    frames.push(displayed);
  }

  assert.equal(nextSequence, transmitFrames, `${cameraFps} fps did not sustain 15 fps TX`);
  for (let tick = 0; tick < frames.length; tick++) {
    assert.equal(
      frames[tick]!.sequence,
      Math.floor(tick / ticksPerTransmitFrame),
      `${cameraFps} fps changed the display before its 66.7 ms hold elapsed`,
    );
  }
  return { frames, ticksPerTransmitFrame };
}

test("30/60 fps camera tick phases reconstruct EXPERIMENTAL/KCMY at 15 fps byte-exactly", async () => {
  const payload = incompressiblePayload(EXPERIMENTAL_PROFILE.blockBytes * 4 - 211);
  const packed = await packFile(
    "synthetic-15fps.bin",
    "application/octet-stream",
    payload,
  );
  const generator = new FountainFrameGenerator(
    packed.container,
    EXPERIMENTAL_PROFILE.blockBytes,
    SESSION_ID,
  );
  assert.ok(generator.metadata.k > 1, "the temporal fixture must span multiple LT blocks");

  // The deterministic k=4 fixture currently peels after five unique frames.
  // This larger finite ceiling leaves ample wire-compatible overhead without
  // allowing a broken cadence or decoder to run indefinitely.
  const transmitFrameBudget = generator.metadata.k * 8 + 16;
  let exercisedPhases = 0;

  for (const cameraFps of CAMERA_FPS) {
    const timeline = cameraTimeline(cameraFps, transmitFrameBudget, generator);
    for (let phaseOffset = 0; phaseOffset < timeline.ticksPerTransmitFrame; phaseOffset++) {
      exercisedPhases++;
      const label = `${cameraFps} fps phase ${phaseOffset}/${timeline.ticksPerTransmitFrame - 1}`;
      const decoder = new LTDecoder(
        generator.metadata.k,
        generator.metadata.blockLen,
        generator.metadata.sessionId,
        generator.metadata.totalLen,
      );
      let capturedCallbacks = 0;

      // Starting at each tick within the first 66.7 ms hold enumerates every
      // discrete camera/TX phase. Subsequent callbacks deliberately include the
      // repeated captures a 30/60 fps camera observes from a 15 fps display.
      for (
        let cameraTick = phaseOffset;
        cameraTick < timeline.frames.length && !decoder.isComplete;
        cameraTick++
      ) {
        capturedCallbacks++;
        const captured = timeline.frames[cameraTick]!;
        const optical = unwrapColor4Frame(captured.codedBytes, {
          profileId: EXPERIMENTAL_PROFILE.id,
          paletteId: PALETTE_KCMY,
        });
        assert.equal(
          optical.status,
          "valid",
          optical.status === "rejected" ? `${label}: ${optical.reason}` : label,
        );
        if (optical.status !== "valid") continue;

        const parsed = parseFrame(optical.innerFrame);
        assert.ok(parsed, `${label}: COLOR_4 did not return a valid fountain frame`);
        if (!parsed) continue;
        assert.equal(parsed.header.seq, captured.sequence, label);
        assert.equal(parsed.header.sessionId, generator.metadata.sessionId, label);
        assert.equal(parsed.header.k, generator.metadata.k, label);
        assert.equal(parsed.header.blockLen, generator.metadata.blockLen, label);
        assert.equal(parsed.header.totalLen, generator.metadata.totalLen, label);
        assert.equal(parsed.header.payloadFnv, generator.metadata.payloadFnv, label);
        decoder.addFrame(parsed.header.seq, parsed.block);
      }

      assert.equal(decoder.isComplete, true, `${label}: fountain decode did not complete`);
      assert.ok(decoder.framesDup > 0, `${label}: repeated camera frames were not exercised`);
      assert.ok(capturedCallbacks > decoder.framesNew, `${label}: camera callbacks were not repeated`);
      const reconstructed = decoder.assemble();
      assert.ok(reconstructed, `${label}: complete decoder assembled no container`);
      assert.deepEqual(reconstructed, packed.container, `${label}: DCF2 container changed`);
      if (!reconstructed) continue;

      const recovered = await unpackFile(reconstructed);
      assert.equal(await verifyFile(recovered), true, `${label}: SHA-256 verification failed`);
      assert.equal(recovered.name, "synthetic-15fps.bin", label);
      assert.deepEqual(recovered.bytes, payload, `${label}: recovered file changed`);
    }
  }

  assert.equal(exercisedPhases, 2 + 4, "not every 30/60 fps discrete tick phase ran");
});
