import assert from "node:assert/strict";
import test from "node:test";
import {
  COLOR4_CAPTURE_FINGERPRINT_BLOCK_COLUMNS,
  COLOR4_CAPTURE_FINGERPRINT_BLOCK_COUNT,
  COLOR4_CAPTURE_FINGERPRINT_BLOCK_ROWS,
  COLOR4_CAPTURE_FINGERPRINT_BLOCK_SIZE,
  COLOR4_CAPTURE_FINGERPRINT_HEIGHT,
  COLOR4_CAPTURE_FINGERPRINT_LENGTH,
  COLOR4_CAPTURE_FINGERPRINT_WIDTH,
  CaptureStabilityTracker,
  bt709LumaByte,
  captureStabilityState,
  compareCaptureLumaFingerprints,
  createCaptureLumaFingerprint,
  shouldSubmitCapture,
  type CaptureStabilityState,
} from "../receive/color4-capture-stability";

function solidRgba(width: number, height: number, red: number, green: number, blue: number): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let offset = 0; offset < rgba.length; offset += 4) {
    rgba[offset] = red;
    rgba[offset + 1] = green;
    rgba[offset + 2] = blue;
    rgba[offset + 3] = 255;
  }
  return rgba;
}

function fingerprint(value = 0): Uint8Array {
  return new Uint8Array(COLOR4_CAPTURE_FINGERPRINT_LENGTH).fill(value);
}

function fillBlock(values: Uint8Array, blockIndex: number, value: number): void {
  const blockX = blockIndex % COLOR4_CAPTURE_FINGERPRINT_BLOCK_COLUMNS;
  const blockY = Math.floor(blockIndex / COLOR4_CAPTURE_FINGERPRINT_BLOCK_COLUMNS);
  for (let y = 0; y < COLOR4_CAPTURE_FINGERPRINT_BLOCK_SIZE; y++) {
    const row = (blockY * COLOR4_CAPTURE_FINGERPRINT_BLOCK_SIZE + y) *
      COLOR4_CAPTURE_FINGERPRINT_WIDTH;
    for (let x = 0; x < COLOR4_CAPTURE_FINGERPRINT_BLOCK_SIZE; x++) {
      values[row + blockX * COLOR4_CAPTURE_FINGERPRINT_BLOCK_SIZE + x] = value;
    }
  }
}

test("capture fingerprints have the frozen 64x48 and 8x8-block geometry", () => {
  assert.equal(COLOR4_CAPTURE_FINGERPRINT_WIDTH, 64);
  assert.equal(COLOR4_CAPTURE_FINGERPRINT_HEIGHT, 48);
  assert.equal(COLOR4_CAPTURE_FINGERPRINT_LENGTH, 3_072);
  assert.equal(COLOR4_CAPTURE_FINGERPRINT_BLOCK_SIZE, 8);
  assert.equal(COLOR4_CAPTURE_FINGERPRINT_BLOCK_COLUMNS, 8);
  assert.equal(COLOR4_CAPTURE_FINGERPRINT_BLOCK_ROWS, 6);
  assert.equal(COLOR4_CAPTURE_FINGERPRINT_BLOCK_COUNT, 48);
});

test("BT.709 luma is rounded deterministically and ignores alpha", () => {
  assert.equal(bt709LumaByte(0, 0, 0), 0);
  assert.equal(bt709LumaByte(255, 255, 255), 255);
  assert.equal(bt709LumaByte(255, 0, 0), 54);
  assert.equal(bt709LumaByte(0, 255, 0), 182);
  assert.equal(bt709LumaByte(0, 0, 255), 18);

  const opaque = solidRgba(1, 1, 20, 40, 60);
  const transparent = opaque.slice();
  transparent[3] = 0;
  assert.deepEqual(
    createCaptureLumaFingerprint(transparent, 1, 1),
    createCaptureLumaFingerprint(opaque, 1, 1),
  );
});

test("fingerprinting samples the source pixel at each target cell centre", () => {
  const rgba = new Uint8ClampedArray([
    0, 0, 0, 255,
    255, 255, 255, 255,
  ]);
  const observed = createCaptureLumaFingerprint(rgba, 2, 1);
  assert.deepEqual([...observed.slice(0, 32)], new Array<number>(32).fill(0));
  assert.deepEqual([...observed.slice(32, 64)], new Array<number>(32).fill(255));
  assert.deepEqual([...observed.slice(-32)], new Array<number>(32).fill(255));
});

test("fingerprinting validates dimensions and exact RGBA storage", () => {
  assert.throws(
    () => createCaptureLumaFingerprint(new Uint8Array(), 0, 1),
    /width must be a positive safe integer/i,
  );
  assert.throws(
    () => createCaptureLumaFingerprint(new Uint8Array(), 1, Number.NaN),
    /height must be a positive safe integer/i,
  );
  assert.throws(
    () => createCaptureLumaFingerprint(new Uint8Array(7), 2, 1),
    /RGBA length must be exactly/i,
  );
});

test("identical and maximally different fingerprints normalize to zero and one", () => {
  const black = fingerprint(0);
  const same = compareCaptureLumaFingerprints(black, black.slice());
  assert.equal(same.blockMaeNormalized.length, 48);
  assert.ok(same.blockMaeNormalized.every((value) => value === 0));
  assert.equal(same.p90MaeNormalized, 0);

  const inverse = compareCaptureLumaFingerprints(black, fingerprint(255));
  assert.ok(inverse.blockMaeNormalized.every((value) => value === 1));
  assert.equal(inverse.p90MaeNormalized, 1);
});

test("block MAE is row-major and normalized by 64 samples and 255", () => {
  const previous = fingerprint();
  const current = fingerprint();
  current[0] = 255;
  fillBlock(current, 47, 255);
  const difference = compareCaptureLumaFingerprints(previous, current);
  assert.equal(difference.blockMaeNormalized[0], 1 / 64);
  assert.equal(difference.blockMaeNormalized[1], 0);
  assert.equal(difference.blockMaeNormalized[46], 0);
  assert.equal(difference.blockMaeNormalized[47], 1);
});

test("nearest-rank p90 ignores four changed blocks but includes five", () => {
  const previous = fingerprint();
  const fourChanged = fingerprint();
  for (let block = 0; block < 4; block++) fillBlock(fourChanged, block, 255);
  assert.equal(compareCaptureLumaFingerprints(previous, fourChanged).p90MaeNormalized, 0);

  const fiveChanged = fourChanged.slice();
  fillBlock(fiveChanged, 4, 255);
  assert.equal(compareCaptureLumaFingerprints(previous, fiveChanged).p90MaeNormalized, 1);
});

test("comparison rejects buffers that are not complete fingerprints", () => {
  assert.throws(
    () => compareCaptureLumaFingerprints(new Uint8Array(1), fingerprint()),
    /exactly 3072 luma samples/i,
  );
  assert.throws(
    () => compareCaptureLumaFingerprints(fingerprint(), new Uint8Array(3071)),
    /exactly 3072 luma samples/i,
  );
});

test("stability classification treats equality as stable and validates normalized inputs", () => {
  assert.equal(captureStabilityState(undefined, 0.04), "warmup");
  assert.equal(captureStabilityState(0.04, 0.04), "stable");
  assert.equal(captureStabilityState(0.040_001, 0.04), "unstable");
  for (const invalid of [-0.01, 1.01, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => captureStabilityState(undefined, invalid), /Stable threshold/);
    assert.throws(() => captureStabilityState(invalid, 0.04), /Normalized p90 MAE/);
  }
});

test("observe is pass-through while enabled submits only stable comparisons", () => {
  const states: CaptureStabilityState[] = ["warmup", "stable", "unstable"];
  for (const state of states) assert.equal(shouldSubmitCapture("observe", state), true);
  assert.equal(shouldSubmitCapture("enabled", "warmup"), false);
  assert.equal(shouldSubmitCapture("enabled", "unstable"), false);
  assert.equal(shouldSubmitCapture("enabled", "stable"), true);
});

test("enabled tracker warms up, rejects a transition, then accepts its stable successor", () => {
  const tracker = new CaptureStabilityTracker("enabled", 0.02);
  assert.deepEqual(tracker.observe(fingerprint(0)), { state: "warmup", shouldSubmit: false });

  const stable = tracker.observe(fingerprint(0));
  assert.equal(stable.state, "stable");
  assert.equal(stable.shouldSubmit, true);
  if (stable.state !== "stable") assert.fail("Expected a measured result.");
  assert.equal(stable.p90MaeNormalized, 0);

  const transition = tracker.observe(fingerprint(255));
  assert.equal(transition.state, "unstable");
  assert.equal(transition.shouldSubmit, false);

  const settled = tracker.observe(fingerprint(255));
  assert.equal(settled.state, "stable");
  assert.equal(settled.shouldSubmit, true);
});

test("observe tracker reports the same states without gating them", () => {
  const tracker = new CaptureStabilityTracker("observe", 0.02);
  assert.deepEqual(tracker.observe(fingerprint(0)), { state: "warmup", shouldSubmit: true });
  const transition = tracker.observe(fingerprint(255));
  assert.equal(transition.state, "unstable");
  assert.equal(transition.shouldSubmit, true);
});

test("tracker snapshots caller buffers and reset restores warmup semantics", () => {
  const tracker = new CaptureStabilityTracker("enabled", 0);
  const first = fingerprint(0);
  tracker.observe(first);
  first.fill(255);
  assert.equal(tracker.observe(fingerprint(0)).state, "stable");
  tracker.reset();
  assert.deepEqual(tracker.observe(fingerprint(0)), { state: "warmup", shouldSubmit: false });
});

test("tracker rejects invalid thresholds and fingerprints", () => {
  assert.throws(() => new CaptureStabilityTracker("enabled", -1), /Stable threshold/);
  const tracker = new CaptureStabilityTracker("enabled", 0.02);
  assert.throws(() => tracker.observe(new Uint8Array(1)), /exactly 3072 luma samples/i);
});
