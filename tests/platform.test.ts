import assert from "node:assert/strict";
import test from "node:test";
import {
  applyAdvancedConstraint,
  applyContinuousCameraModes,
  probeCameraCapabilities,
} from "../shared/platform";

function trackWithCapabilities(capabilities: object): MediaStreamTrack {
  return {
    getCapabilities: () => capabilities,
  } as unknown as MediaStreamTrack;
}

test("camera probing finds each continuous mode independently", () => {
  const capabilities = probeCameraCapabilities(trackWithCapabilities({
    torch: true,
    focusMode: ["manual", "continuous"],
    exposureMode: ["continuous"],
    whiteBalanceMode: ["manual", "continuous"],
    frameRate: { min: 1, max: 120 },
  }));

  assert.deepEqual(capabilities, {
    torch: true,
    continuousFocus: true,
    continuousExposure: true,
    continuousWhiteBalance: true,
    maxFrameRate: 120,
  });
});

test("missing or partial camera capabilities fail closed", () => {
  const missing = probeCameraCapabilities({} as MediaStreamTrack);
  assert.deepEqual(missing, {
    torch: false,
    continuousFocus: false,
    continuousExposure: false,
    continuousWhiteBalance: false,
    maxFrameRate: undefined,
  });

  const partial = probeCameraCapabilities(trackWithCapabilities({
    focusMode: ["manual"],
    exposureMode: "continuous",
  }));
  assert.equal(partial.continuousFocus, false);
  assert.equal(partial.continuousExposure, false);
  assert.equal(partial.continuousWhiteBalance, false);
});

test("advanced camera constraints are best effort", async () => {
  let applied: MediaTrackConstraints | undefined;
  const accepting = {
    applyConstraints: async (constraints: MediaTrackConstraints) => {
      applied = constraints;
    },
  } as unknown as MediaStreamTrack;
  assert.equal(await applyAdvancedConstraint(accepting, { exposureMode: "continuous" }), true);
  assert.deepEqual(applied, { advanced: [{ exposureMode: "continuous" }] });

  const refusing = {
    applyConstraints: async () => { throw new DOMException("refused", "OverconstrainedError"); },
  } as unknown as MediaStreamTrack;
  assert.equal(await applyAdvancedConstraint(refusing, { whiteBalanceMode: "continuous" }), false);
});

test("continuous modes retain accepted settings while isolating a refused mode", async () => {
  const attempts: MediaTrackConstraintSet[] = [];
  const track = {
    applyConstraints: async (constraints: MediaTrackConstraints) => {
      const advanced = constraints.advanced?.[0] as MediaTrackConstraintSet;
      attempts.push(advanced);
      if ((advanced as { exposureMode?: string }).exposureMode) throw new Error("unsupported");
    },
  } as unknown as MediaStreamTrack;

  const applied = await applyContinuousCameraModes(track, {
    torch: false,
    continuousFocus: true,
    continuousExposure: true,
    continuousWhiteBalance: true,
  });

  assert.deepEqual(applied, { focus: true, exposure: false, whiteBalance: true });
  assert.deepEqual(attempts, [
    { focusMode: "continuous" },
    { focusMode: "continuous", exposureMode: "continuous" },
    { focusMode: "continuous", whiteBalanceMode: "continuous" },
  ]);
});
