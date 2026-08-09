import { test } from "@playwright/test";
import { expectColor4CameraReconstruction } from "./color4-camera-test";

test("the degraded COLOR_4 camera fixture reconstructs a byte-exact file", async ({ page }) => {
  test.setTimeout(120_000);
  await expectColor4CameraReconstruction(page);
});
