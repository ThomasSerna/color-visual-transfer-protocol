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
export async function expectColor4CameraReconstruction(
  page: Page,
  options: { readonly prefilterMode?: "observe" | "enabled" } = {},
): Promise<void> {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const openCvLoaded = page.waitForResponse(
    (response) => /\/assets\/opencv-[^/]+\.js$/.test(response.url()) && response.status() === 200,
  );
  await page.goto("/receive/");
  await page.locator("#carrier-color-option").click();
  if (options.prefilterMode === "enabled") {
    await page.locator("details:has(> summary:text-is('Debug Vision')) > summary").click();
    await page.locator("#cfg-debug-prefilter").selectOption("enabled");
  }
  await page.locator("#settings > summary").click();
  await page.locator("#cfg-color-palette").selectOption("0");
  await expect(page.locator("#cfg-color-palette")).toHaveValue("0");
  await page.locator("#start").click();
  await openCvLoaded;

  try {
    await expect(page.locator("#result .done")).toHaveText("Signal recovered", {
      timeout: 90_000,
    });
  } catch (error) {
    // Preserve the live experiment on timeout; otherwise the DOM snapshot only
    // says that recovery stalled and hides which acquisition stage dominated.
    const diagnostics = page.locator("#diagnostics");
    if ((await diagnostics.getAttribute("open")) === null) {
      await diagnostics.locator("summary").click();
    }
    const diagnosticDownload = page.waitForEvent("download");
    await page.locator("#export-metrics").click();
    const artifact = await diagnosticDownload;
    const path = await artifact.path();
    const exportRecord = path === null ? undefined : JSON.parse(await readFile(path, "utf8"));
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\n` +
        `Live COLOR_4 metrics: ${JSON.stringify(exportRecord?.current ?? null)}`,
    );
  }
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
      captures: number;
      stableCaptures?: number;
      unstableCaptures?: number;
      stabilityWarmupCaptures?: number;
      visionSubmissions?: number;
      skippedUnstable?: number;
      skippedRedundantStable?: number;
      skippedWhileBusy: number;
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
  expect(
    (metrics.history[0]!.stableCaptures ?? 0) +
      (metrics.history[0]!.unstableCaptures ?? 0) +
      (metrics.history[0]!.stabilityWarmupCaptures ?? 0),
  ).toBe(metrics.history[0]!.captures);
  if (options.prefilterMode === "enabled") {
    expect(metrics.history[0]!.skippedUnstable).toBeGreaterThan(0);
    expect(metrics.history[0]!.visionSubmissions).toBeLessThan(metrics.history[0]!.captures);
    expect(metrics.history[0]!.captures).toBe(
      (metrics.history[0]!.stabilityWarmupCaptures ?? 0) +
        (metrics.history[0]!.skippedUnstable ?? 0) +
        (metrics.history[0]!.skippedRedundantStable ?? 0) +
        metrics.history[0]!.skippedWhileBusy +
        (metrics.history[0]!.visionSubmissions ?? 0),
    );
  } else {
    expect(metrics.history[0]!.skippedUnstable).toBe(0);
    expect(metrics.history[0]!.skippedRedundantStable).toBe(0);
  }
  expect(errors).toEqual([]);
}
