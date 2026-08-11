import { test } from "@playwright/test";
import { expectColor4CameraReconstruction } from "./color4-camera-test";

test("the active stability filter skips transitions and reconstructs the degraded COLOR_4 camera fixture byte-exactly", async ({ page }) => {
  test.setTimeout(120_000);
  await expectColor4CameraReconstruction(page, { prefilterMode: "enabled" });
});
