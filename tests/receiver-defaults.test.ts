import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  DEFAULT_CAPTURE_WIDTH,
  DEFAULT_COLOR4_CANONICAL_SCALE,
  DEFAULT_COLOR4_CAPTURE_FPS,
  DEFAULT_COLOR4_DETECTION_DIMENSION,
  DEFAULT_QR_CAPTURE_FPS,
  defaultCaptureFps,
} from "../shared/receiver-defaults";

test("receiver defaults pin the supported COLOR_4 capture path", () => {
  assert.equal(DEFAULT_CAPTURE_WIDTH, 1280);
  assert.equal(DEFAULT_COLOR4_CAPTURE_FPS, 30);
  assert.equal(DEFAULT_QR_CAPTURE_FPS, 60);
  assert.equal(DEFAULT_COLOR4_CANONICAL_SCALE, 6);
  assert.equal(DEFAULT_COLOR4_DETECTION_DIMENSION, 1280);
  assert.equal(defaultCaptureFps("color4"), 30);
  assert.equal(defaultCaptureFps("qr"), 60);
});

test("receiver HTML sources its camera and vision selections from build tokens", () => {
  const html = readFileSync(new URL("../receive/index.html", import.meta.url), "utf8");
  for (const token of [
    "CAPTURE_WIDTH_OPTIONS",
    "CAPTURE_FPS_OPTIONS",
    "COLOR4_CANONICAL_SCALE_OPTIONS",
    "COLOR4_DETECTION_DIMENSION_OPTIONS",
  ]) {
    assert.match(html, new RegExp(`%${token}%`));
  }
});
