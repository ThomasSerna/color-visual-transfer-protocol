import { expect, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  COLOR4_CAMERA_PAYLOAD,
  COLOR4_CAMERA_SCHEDULE,
} from "./global-setup";

/**
 * Shared assertions for both fake-camera projects. Keeping the receiver flow
 * here makes the degraded project exercise the same contract as the baseline
 * without running or copying the rest of the browser suite.
 */
export async function expectColor4CameraReconstruction(page: Page): Promise<void> {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const openCvLoaded = page.waitForResponse(
    (response) => /\/assets\/opencv-[^/]+\.js$/.test(response.url()) && response.status() === 200,
  );
  await page.goto("/receive/");
  await page.locator("#carrier-color-option").click();
  await page.locator("#settings > summary").click();
  await page.locator("#cfg-color-palette").selectOption("0");
  await expect(page.locator("#cfg-color-palette")).toHaveValue("0");
  await page.locator("#start").click();
  await openCvLoaded;

  await expect(page.locator("#result .done")).toHaveText("Signal recovered", {
    timeout: 90_000,
  });
  await expect(page.locator('#result a[download="camera-e2e.bin"]')).toHaveText(
    "Save camera-e2e.bin",
  );
  await expect(page.locator("#result .hint")).toContainText("SHA-256 verified");
  const recovered = await page.locator('#result a[download="camera-e2e.bin"]').evaluate(
    async (anchor: HTMLAnchorElement) =>
      Array.from(new Uint8Array(await (await fetch(anchor.href)).arrayBuffer())),
  );
  const recoveredBytes = Buffer.from(recovered);
  expect(recoveredBytes).toEqual(Buffer.from(COLOR4_CAMERA_PAYLOAD));
  expect(createHash("sha256").update(recoveredBytes).digest("hex")).toBe(
    createHash("sha256").update(COLOR4_CAMERA_PAYLOAD).digest("hex"),
  );
  expect(COLOR4_CAMERA_SCHEDULE.filter((entry) => entry.sequence === 1)).toHaveLength(2);
  await expect(page.locator("#m-carrier")).toContainText(/^\d+\/\d+$/);
  await page.locator("#diagnostics > summary").click();
  await expect(page.locator("#export-metrics")).toBeVisible();
  const metricsDownload = page.waitForEvent("download");
  await page.locator("#export-metrics").click();
  const metricsArtifact = await metricsDownload;
  expect(metricsArtifact.suggestedFilename()).toMatch(/^cvtp-experiments-.+\.json$/);
  const metricsPath = await metricsArtifact.path();
  expect(metricsPath).not.toBeNull();
  const metrics = JSON.parse(await readFile(metricsPath!, "utf8")) as {
    current?: unknown;
    history: Array<{
      carrier: string;
      profile?: string;
      success: boolean;
      cameraWidth?: number;
      cameraHeight?: number;
      validFrames: number;
      newFrames: number;
      duplicateFrames: number;
      resolvedBlocks: number;
      crcFailures: number;
    }>;
  };
  expect(metrics.current).toBeUndefined();
  expect(metrics.history).toHaveLength(1);
  expect(metrics.history[0]).toMatchObject({
    carrier: "COLOR_4",
    profile: "ROBUST",
    success: true,
    cameraWidth: 1280,
    cameraHeight: 960,
  });
  expect(metrics.history[0]!.validFrames).toBeGreaterThanOrEqual(2);
  expect(metrics.history[0]!.newFrames).toBeGreaterThanOrEqual(2);
  // A busy vision worker intentionally drops camera callbacks, so the short
  // duplicate segment in the Y4M schedule is not a deterministic E2E event.
  // Duplicate semantics are unit-tested; here, pin the observed accounting.
  expect(metrics.history[0]!.validFrames).toBe(
    metrics.history[0]!.newFrames + metrics.history[0]!.duplicateFrames,
  );
  expect(metrics.history[0]!.resolvedBlocks).toBe(2);
  expect(metrics.history[0]!.crcFailures).toBe(0);
  expect(errors).toEqual([]);
}
