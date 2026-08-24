import { test } from "@playwright/test";
import { expectColor4CameraReconstruction } from "./color4-camera-test";
import { COLOR4_EXPERIMENTAL_PAYLOAD } from "./global-setup";

/**
 * Until this existed, every fake-camera project transmitted ROBUST, so the
 * denser profile had no end-to-end gate at all: nothing caught a regression
 * that only reached 120x119 cells, 14 shards or 16 parity symbols. The fixture
 * frames the code at roughly 5 camera pixels per module, which is the regime
 * the physical exports report rather than a comfortable one.
 */
test("the COLOR_4 camera worker reconstructs an EXPERIMENTAL-profile file", async ({ page }) => {
  test.setTimeout(120_000);
  await expectColor4CameraReconstruction(page, {
    profile: "EXPERIMENTAL",
    payload: COLOR4_EXPERIMENTAL_PAYLOAD,
    fileName: "camera-e2e-experimental.bin",
    resolvedBlocks: 2,
  });
});
