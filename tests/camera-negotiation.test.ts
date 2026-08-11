import assert from "node:assert/strict";
import test from "node:test";
import {
  applyMaximumSupportedWidth,
  cameraConstraintLadder,
} from "../shared/camera-negotiation";

test("COLOR_4 camera negotiation tries exact selection, exact 1280, then ideals", () => {
  const attempts = cameraConstraintLadder("color4", 1920, 30);
  assert.deepEqual(attempts.map((attempt) => attempt.label), [
    "selected-exact",
    "fallback-1280-exact",
    "ideal",
  ]);
  assert.deepEqual(attempts[0]!.constraints.width, { exact: 1920 });
  assert.deepEqual(attempts[0]!.constraints.frameRate, { exact: 30 });
  assert.deepEqual(attempts[1]!.constraints.width, { exact: 1280 });
  assert.deepEqual(attempts[2]!.constraints.width, { ideal: 1920 });
  assert.deepEqual(attempts[2]!.constraints.frameRate, { ideal: 30 });
});

test("1280 and max avoid duplicate COLOR_4 fallback attempts", () => {
  assert.deepEqual(
    cameraConstraintLadder("color4", 1280, 15).map((attempt) => attempt.label),
    ["selected-exact", "ideal"],
  );
  assert.deepEqual(
    cameraConstraintLadder("color4", "max", 30).map((attempt) => attempt.label),
    ["selected-exact", "ideal"],
  );
});

test("QR retains ideal width while trying exact then ideal frame rate", () => {
  const attempts = cameraConstraintLadder("qr", 1280, 60);
  assert.equal(attempts.length, 2);
  assert.deepEqual(attempts[0]!.constraints.width, { ideal: 1280 });
  assert.deepEqual(attempts[0]!.constraints.frameRate, { exact: 60 });
  assert.deepEqual(attempts[1]!.constraints.frameRate, { ideal: 60 });
});

test("max supported uses capabilities best-effort and reports refusal", async () => {
  const accepted: MediaTrackConstraints[] = [];
  const track = {
    getCapabilities: () => ({ width: { min: 640, max: 4032 } }),
    applyConstraints: async (constraints: MediaTrackConstraints) => { accepted.push(constraints); },
  } as unknown as MediaStreamTrack;
  assert.deepEqual(await applyMaximumSupportedWidth(track, 30), {
    attempted: 4032,
    applied: true,
  });
  assert.deepEqual(accepted[0], {
    width: { exact: 4032 },
    height: { ideal: 3024 },
    frameRate: { exact: 30 },
  });

  const refused = {
    getCapabilities: () => ({ width: { min: 640, max: 1920 } }),
    applyConstraints: async () => { throw new Error("unsupported combination"); },
  } as unknown as MediaStreamTrack;
  assert.deepEqual(await applyMaximumSupportedWidth(refused, 15), {
    attempted: 1920,
    applied: false,
  });
  assert.deepEqual(
    await applyMaximumSupportedWidth({} as MediaStreamTrack, 30),
    { applied: false },
  );
});
