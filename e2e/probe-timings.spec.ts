import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";

test("probe worker timings", async ({ page }) => {
  await page.goto("/receive/");
  await page.locator("#carrier-color-option").click();
  await page.locator("#start").click();
  await expect(page.locator("#result .done")).toHaveText("Signal recovered", { timeout: 90_000 });
  await page.locator("#diagnostics > summary").click();
  const dl = page.waitForEvent("download");
  await page.locator("#export-metrics").click();
  const path = await (await dl).path();
  const record = JSON.parse(await readFile(path!, "utf8"));
  const c = record.current ?? record.history?.[0];
  console.log("TIMING_PROBE " + JSON.stringify({
    elapsedMs: c.elapsedMs,
    captures: c.captures,
    visionSubmissions: c.visionSubmissions,
    skippedWhileBusy: c.skippedWhileBusy,
    carrierAttempts: c.carrierAttempts,
    validFrames: c.validFrames,
    decodeLatencyMs: c.decodeLatencyMs,
    timings: c.vision?.timingsMs,
    optical: c.vision?.optical,
  }, null, 1));
});
