import { expect, test } from "@playwright/test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { PNG } from "pngjs";
import { expectColor4CameraReconstruction } from "./color4-camera-test";

const retiredPrimaryBrand = ["Decimen", "COLOR_4"].join(" ");

interface StoredZipEntry {
  readonly name: string;
  readonly data: Uint8Array;
}

function storedZipEntries(bytes: Uint8Array): StoredZipEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();
  const entries: StoredZipEntry[] = [];
  let offset = 0;
  while (offset + 4 <= bytes.length && view.getUint32(offset, true) === 0x04034b50) {
    if (offset + 30 > bytes.length) throw new Error("Truncated ZIP local header.");
    const method = view.getUint16(offset + 8, true);
    const size = view.getUint32(offset + 18, true);
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    if (method !== 0) throw new Error("Debug snapshot ZIP must use STORE entries.");
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const dataEnd = dataStart + size;
    if (dataEnd > bytes.length) throw new Error("Truncated ZIP entry.");
    entries.push({
      name: decoder.decode(bytes.subarray(nameStart, nameStart + nameLength)),
      data: Uint8Array.from(bytes.subarray(dataStart, dataEnd)),
    });
    offset = dataEnd;
  }
  if (entries.length === 0) throw new Error("Debug snapshot ZIP has no local entries.");
  return entries;
}

test("the public shell presents CVTP with Transmit and Capture roles", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".brand-wordmark")).toHaveText("CVTP");
  await expect(page.locator("main h1")).toHaveText(/Color Visual\s*Transfer Protocol/);
  await expect(page.locator('.mode-nav a[href="./send/"]')).toHaveText("Transmit");
  await expect(page.locator('.mode-nav a[href="./receive/"]')).toHaveText("Capture");
  await expect(page.locator('main a[href="./send/"]')).toContainText("Open transmitter");
  await expect(page.locator('main a[href="./receive/"]')).toContainText("Open receiver");
});

test("hosted sender renders COLOR_4 in its worker and can return to legacy QR", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/send/");

  const expectCarrierInsideStage = async () => {
    const bounds = await page.locator("#qr").evaluate((canvas: HTMLCanvasElement) => {
      const stage = canvas.closest("#stage");
      if (!(stage instanceof HTMLElement)) throw new Error("Optical stage is missing");
      const frame = canvas.getBoundingClientRect();
      const slot = stage.getBoundingClientRect();
      return {
        frameWidth: frame.width,
        frameHeight: frame.height,
        slotWidth: slot.width,
        slotHeight: slot.height,
      };
    });
    expect(bounds.frameWidth, "carrier width must preserve its quiet zone inside #stage")
      .toBeLessThanOrEqual(bounds.slotWidth + 0.5);
    expect(bounds.frameHeight, "carrier height must preserve its quiet zone inside #stage")
      .toBeLessThanOrEqual(bounds.slotHeight + 0.5);
  };

  // The native radio stays focusable but is visually covered by its styled
  // label, so exercise the same click target a real user sees.
  await page.locator("#carrier-color-option").click();
  const profile = page.locator("#cfg-color-profile");
  await expect(profile).toHaveValue("1");
  await page.locator("details.settings > summary").click();
  await expect(page.locator("#cfg-color-palette")).toBeVisible();
  await page.locator("#cfg-file").setInputFiles({
    name: "e2e-random.bin",
    mimeType: "application/zip",
    buffer: Buffer.from(Array.from({ length: 8_192 }, (_, index) => (index * 73 + 19) & 0xff)),
  });

  await expect(page.locator("#stage")).toBeVisible();
  await expect(page.locator("#spec-qr")).toContainText("COLOR_4 ROBUST");
  await expect(page.locator("#share-url")).toHaveValue("http://127.0.0.1:4173/receive/");
  const colorFrame = await page.locator("#qr").evaluate((canvas: HTMLCanvasElement) => {
    const context = canvas.getContext("2d");
    if (!context) return { width: 0, colors: 0 };
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    const colors = new Set<string>();
    for (let offset = 0; offset < pixels.length && colors.size < 8; offset += 4 * 97) {
      colors.add(`${pixels[offset]},${pixels[offset + 1]},${pixels[offset + 2]}`);
    }
    return { width: canvas.width, colors: colors.size };
  });
  expect(colorFrame.width).toBeGreaterThan(0);
  expect(colorFrame.width % 172).toBe(0);
  expect(colorFrame.colors).toBeGreaterThanOrEqual(4);
  await expectCarrierInsideStage();

  // The workbench bay has padding on phones. Resizing exercises the real
  // canvas budget and guards against clipping a QR quiet zone or COLOR_4
  // fiducial inside that padded parent.
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(async () => {
    const widths = await page.locator("#qr").evaluate((canvas: HTMLCanvasElement) => ({
      canvas: canvas.getBoundingClientRect().width,
      stage: canvas.closest("#stage")?.getBoundingClientRect().width ?? 0,
    }));
    return widths.canvas <= widths.stage + 0.5;
  }).toBe(true);
  await expectCarrierInsideStage();

  await page.locator('label:has(input[name="carrier"][value="qr"])').click();
  await expect(page.locator("#spec-qr")).toContainText(/V\d+ · ECC/);
  await expectCarrierInsideStage();
  expect(errors).toEqual([]);
});

test("the COLOR_4 camera receiver exposes carrier-specific settings", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/receive/");

  const qr = page.locator('input[name="carrier"][value="qr"]');
  const color = page.locator('input[name="carrier"][value="color4"]');
  await expect(qr).toBeChecked();
  await page.locator("#settings > summary").click();
  await expect(page.locator("#cfg-width")).toHaveValue("1280");
  await expect(page.locator("#cfg-capfps")).toHaveValue("60");
  await expect(page.locator("#cfg-workers")).toBeVisible();
  await page.locator("#carrier-color-option").click();
  await expect(color).toBeChecked();
  await expect(qr).not.toBeChecked();
  await expect(page.locator("#cfg-color-palette")).toBeVisible();
  await expect(page.locator("#cfg-width")).toHaveValue("1920");
  await expect(page.locator("#cfg-width option[value='max']")).toHaveText("max supported");
  await expect(page.locator("#cfg-capfps")).toHaveValue("30");
  await expect(page.locator("#cfg-capfps option[value='15']")).not.toHaveAttribute("hidden", "");
  await expect(page.locator("#cfg-capfps option[value='60']")).toHaveAttribute("hidden", "");
  await expect(page.locator("#cfg-workers")).toBeHidden();
  await expect(page.locator("details:has(> summary:text-is('Debug Vision'))")).toBeVisible();
  await expect(page.locator("#cfg-vision-debug")).not.toBeChecked();
  expect(errors).toEqual([]);
});

test("the COLOR_4 camera Debug Vision exports a private snapshot and stops cleanly", async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== "chromium", "Chromium provides Playwright's deterministic fake camera.");
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const openCvLoaded = page.waitForResponse(
    (response) => /\/assets\/opencv-[^/]+\.js$/.test(response.url()) && response.status() === 200,
  );
  await page.goto("/receive/");
  await page.locator("#carrier-color-option").click();
  const debugPanel = page.locator("details:has(> summary:text-is('Debug Vision'))");
  await debugPanel.locator("summary").click();
  await page.locator("#settings > summary").click();
  await page.locator("#cfg-color-palette").selectOption("1");
  await page.locator("#cfg-debug-label").fill("playwright-debug-baseline");
  await page.locator("#cfg-debug-tx").selectOption("5");
  await page.locator("#cfg-debug-distance").selectOption("0.5");
  await page.locator("#cfg-debug-angle").selectOption("0");
  await page.locator("#cfg-debug-brightness").selectOption("maximum");
  await page.locator("#cfg-debug-view").selectOption("raw");
  await page.locator("#start").click();
  await openCvLoaded;
  // RAW capture is an acquisition action, not a live-overlay prerequisite.
  await expect(page.locator("#cfg-vision-debug")).not.toBeChecked();
  await expect(page.locator("#capture-debug-snapshot")).toBeEnabled({ timeout: 30_000 });
  const rawOnlyDownload = page.waitForEvent("download");
  await page.locator("#capture-debug-snapshot").click();
  const rawOnlyArtifact = await rawOnlyDownload;
  expect(rawOnlyArtifact.suggestedFilename()).toMatch(/^cvtp-vision-.+-capture-\d{6}\.zip$/);
  await expect(page.locator("#debug-snapshot-status")).toContainText("Snapshot ZIP downloaded");
  // Enabling after capture starts must activate diagnostics without restarting
  // the camera; advanced controls are already locked to the session config.
  await page.locator("#cfg-vision-debug").check();

  await expect(page.locator("#capture-debug-snapshot")).toBeEnabled({ timeout: 30_000 });
  await expect(page.locator("#cfg-debug-scale")).toBeDisabled();
  await expect(page.locator("#cfg-debug-detection")).toBeDisabled();
  await expect(page.locator("#vision-debug-output")).toBeVisible();
  await expect(page.locator("#vision-overlay")).toBeVisible();

  const stages = [
    { value: "raw", title: "Raw camera", width: 1280 },
    { value: "grayscale", title: "Grayscale", width: 1280 },
    { value: "threshold", title: "Threshold", width: 1280 },
    { value: "contours", title: "Contours / quads", width: 1280 },
    { value: "fiducials", title: "Detected fiducials", width: 1280 },
    { value: "warped", title: "Warped frame", width: 1032 },
    { value: "calibration", title: "Calibration swatches", width: 1032 },
  ] as const;
  for (const stage of stages) {
    await page.locator("#cfg-debug-view").selectOption(stage.value);
    await expect(page.locator("#vision-debug-title")).toHaveText(stage.title);
    await expect.poll(
      () => page.locator("#vision-debug-canvas").evaluate((canvas: HTMLCanvasElement) => ({
        width: canvas.width,
        // The view-change handler clears the existing bitmap without changing
        // its dimensions. Alpha therefore proves that a frame from the new
        // debug generation rendered, even for adjacent same-width stages.
        alpha: canvas.getContext("2d")?.getImageData(0, 0, 1, 1).data[3] ?? 0,
      })),
      { message: `${stage.title} must receive a plane from the current debug generation` },
    ).toEqual({ width: stage.width, alpha: 255 });
  }

  await expect.poll(
    () => page.locator("#vision-overlay").evaluate((canvas: HTMLCanvasElement) => {
      const context = canvas.getContext("2d");
      if (!context || canvas.width === 0 || canvas.height === 0) return 0;
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let opaque = 0;
      for (let offset = 3; offset < pixels.length; offset += 4) {
        if (pixels[offset]! > 0) opaque++;
      }
      return opaque;
    }),
    { message: "the sibling overlay must contain projected fiducial diagnostics" },
  ).toBeGreaterThan(0);

  const snapshotDownload = page.waitForEvent("download");
  await page.locator("#capture-debug-snapshot").click();
  const snapshotArtifact = await snapshotDownload;
  expect(snapshotArtifact.suggestedFilename()).toMatch(
    /^cvtp-vision-.+-capture-\d{6}\.zip$/,
  );
  const snapshotPath = await snapshotArtifact.path();
  expect(snapshotPath).not.toBeNull();
  const snapshotEntries = storedZipEntries(await readFile(snapshotPath!));
  const names = snapshotEntries.map((entry) => entry.name);
  expect(names).toHaveLength(4);
  expect(names).toEqual(expect.arrayContaining([
    expect.stringMatching(/^capture-\d{6}-raw\.png$/),
    expect.stringMatching(/^capture-\d{6}-threshold\.png$/),
    expect.stringMatching(/^capture-\d{6}-warped\.png$/),
    expect.stringMatching(/^capture-\d{6}\.json$/),
  ]));
  for (const entry of snapshotEntries.filter((candidate) => candidate.name.endsWith(".png"))) {
    expect(Array.from(entry.data.subarray(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  }
  const jsonEntry = snapshotEntries.find((entry) => entry.name.endsWith(".json"));
  expect(jsonEntry).toBeDefined();
  const snapshot = JSON.parse(new TextDecoder().decode(jsonEntry!.data)) as {
    schema: string;
    version: number;
    configuration: {
      carrier: string;
      canonicalScale: number;
      maxDetectionDimension: number | string;
      paletteId: number;
      palette: string;
      prefilterMode: string;
      expectedProfile?: string;
      observedProfile?: string;
      declaredTxFps?: number;
      requestedCamera: { width: number | string; height?: number; fps: number };
      actualCamera?: { width?: number; height?: number; fps?: number };
    };
    conditions: { label?: string; expectedTxFps: number; expectedProfile?: string; prefilterMode?: string; distanceM: number; angleDeg: number };
    artifacts: { raw: { available: boolean; width?: number; height?: number; rgbaRowStride?: number; rgbaSha256?: string }; threshold: { available: boolean }; warped: { available: boolean } };
    vision: { traces: unknown[] };
    experiment?: { vision?: { debugEnabled?: boolean } };
  };
  expect(snapshot).toMatchObject({
    schema: "cvtp-color4-vision-snapshot",
    version: 1,
    configuration: {
      carrier: "COLOR_4",
      canonicalScale: 6,
      maxDetectionDimension: 1280,
      paletteId: 1,
      palette: "KRGB",
      prefilterMode: "observe",
      expectedProfile: "ROBUST",
      declaredTxFps: 5,
      requestedCamera: { width: 1920, height: 1440, fps: 30 },
      actualCamera: { width: 1280, height: 960, fps: 5 },
    },
    conditions: {
      label: "playwright-debug-baseline",
      expectedTxFps: 5,
      expectedProfile: "ROBUST",
      prefilterMode: "observe",
      distanceM: 0.5,
      angleDeg: 0,
    },
    artifacts: {
      raw: { available: true },
      threshold: { available: true },
      warped: { available: true },
    },
  });
  expect(snapshot.vision.traces.length).toBeGreaterThanOrEqual(4);
  const rawEntry = snapshotEntries.find((entry) => entry.name.endsWith("-raw.png"));
  expect(rawEntry).toBeDefined();
  const decodedRaw = PNG.sync.read(Buffer.from(rawEntry!.data));
  expect(snapshot.artifacts.raw).toMatchObject({
    width: decodedRaw.width,
    height: decodedRaw.height,
    rgbaRowStride: decodedRaw.width * 4,
  });
  expect(createHash("sha256").update(decodedRaw.data).digest("hex")).toBe(
    snapshot.artifacts.raw.rgbaSha256,
  );
  expect(snapshot.experiment?.vision?.debugEnabled).toBe(true);
  await expect(page.locator("#debug-snapshot-status")).toContainText(
    "No camera images were retained",
  );

  // A carrier change cancels the camera and invalidates pending callbacks.
  // Waiting after cancellation catches any stale worker response that tries to
  // resurrect the selected-stage canvas or overlay.
  await page.locator('label:has(input[name="carrier"][value="qr"])').click();
  await expect(page.locator("#stats")).toContainText("Carrier changed");
  await expect(page.locator("#preview")).toBeHidden();
  await expect(page.locator("#vision-debug-output")).toBeHidden();
  await expect(page.locator("#cfg-debug-scale")).toBeEnabled();
  await page.waitForTimeout(750);
  await expect(page.locator("#vision-debug-output")).toBeHidden();
  expect(errors).toEqual([]);
});

test("a consumed COLOR_4 camera debug snapshot survives camera teardown", async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== "chromium", "Chromium provides Playwright's deterministic fake camera.");
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const openCvLoaded = page.waitForResponse(
    (response) => /\/assets\/opencv-[^/]+\.js$/.test(response.url()) && response.status() === 200,
  );
  await page.goto("/receive/");
  await page.locator("#carrier-color-option").click();
  await page.locator("details:has(> summary:text-is('Debug Vision')) > summary").click();
  await page.locator("#settings > summary").click();
  await page.locator("#cfg-debug-label").fill("snapshot-context-before-teardown");
  await page.locator("#cfg-debug-tx").selectOption("5");
  await page.locator("#cfg-debug-profile").selectOption("ROBUST");
  await page.locator("#cfg-debug-prefilter").selectOption("enabled");
  await page.locator("#cfg-debug-distance").selectOption("0.5");
  await page.locator("#cfg-debug-angle").selectOption("0");
  await page.locator("#start").click();
  await openCvLoaded;
  await expect(page.locator("#capture-debug-snapshot")).toBeEnabled({ timeout: 30_000 });

  // Hold the first snapshot hash after the worker result reaches the UI. This
  // makes ZIP encoding observably busy while camera callbacks continue and
  // while the session is torn down. Count decode posts to prove that encoding
  // busy no longer bypasses stable-frame dedupe.
  await page.evaluate(() => {
    document.documentElement.dataset.snapshotDigestStarted = "false";
    document.documentElement.dataset.snapshotDecodePosts = "0";
    const originalDigest = crypto.subtle.digest.bind(crypto.subtle);
    let releaseDigest = (): void => undefined;
    const digestGate = new Promise<void>((resolve) => {
      releaseDigest = resolve;
    });
    window.addEventListener("cvtp-release-snapshot-digest", releaseDigest, { once: true });
    Object.defineProperty(crypto.subtle, "digest", {
      configurable: true,
      value: async (algorithm: AlgorithmIdentifier, data: BufferSource): Promise<ArrayBuffer> => {
        document.documentElement.dataset.snapshotDigestStarted = "true";
        await digestGate;
        return originalDigest(algorithm, data);
      },
    });
    const originalPostMessage = Worker.prototype.postMessage;
    Object.defineProperty(Worker.prototype, "postMessage", {
      configurable: true,
      value: function(this: Worker, ...args: unknown[]): void {
        const request = args[0] as { kind?: unknown } | undefined;
        if (request?.kind === "decode") {
          const count = Number(document.documentElement.dataset.snapshotDecodePosts ?? "0");
          document.documentElement.dataset.snapshotDecodePosts = String(count + 1);
        }
        Reflect.apply(originalPostMessage, this, args);
      },
    });
  });

  const snapshotDownload = page.waitForEvent("download");
  await page.locator("#capture-debug-snapshot").click();
  await expect.poll(
    () => page.evaluate(() => document.documentElement.dataset.snapshotDigestStarted),
    { message: "the snapshot worker result must reach asynchronous ZIP encoding" },
  ).toBe("true");
  // The captured frame owns its original view after consumption. A live-view
  // change may advance overlay generation, but must not revoke this download.
  await page.locator("#cfg-debug-view").selectOption("warped");
  const postsWhenEncodingStarted = await page.evaluate(
    () => Number(document.documentElement.dataset.snapshotDecodePosts ?? "0"),
  );
  await page.waitForTimeout(1_000);
  expect(await page.evaluate(
    () => Number(document.documentElement.dataset.snapshotDecodePosts ?? "0"),
  )).toBe(postsWhenEncodingStarted);

  // Teardown clears the live camera/experiment globals. Mutating unlocked
  // controls before releasing the digest catches any metadata read performed
  // after an await instead of when the snapshot frame was consumed.
  await page.locator('label:has(input[name="carrier"][value="qr"])').click();
  await expect(page.locator("#stats")).toContainText("Carrier changed");
  await page.evaluate(() => {
    (document.getElementById("cfg-debug-label") as HTMLInputElement).value =
      "snapshot-context-after-teardown";
    (document.getElementById("cfg-debug-tx") as HTMLSelectElement).value = "10";
    (document.getElementById("cfg-debug-profile") as HTMLSelectElement).value = "EXPERIMENTAL";
    (document.getElementById("cfg-debug-prefilter") as HTMLSelectElement).value = "observe";
    window.dispatchEvent(new Event("cvtp-release-snapshot-digest"));
  });

  const snapshotArtifact = await snapshotDownload;
  const snapshotPath = await snapshotArtifact.path();
  expect(snapshotPath).not.toBeNull();
  const snapshotEntries = storedZipEntries(await readFile(snapshotPath!));
  const jsonEntry = snapshotEntries.find((entry) => entry.name.endsWith(".json"));
  expect(jsonEntry).toBeDefined();
  const snapshot = JSON.parse(new TextDecoder().decode(jsonEntry!.data)) as {
    configuration: {
      prefilterMode: string;
      expectedProfile?: string;
      declaredTxFps?: number;
      requestedCamera: { width: number | string; height?: number; fps: number };
      actualCamera?: { width?: number; height?: number; fps?: number };
    };
    conditions: { label?: string; expectedTxFps?: number; prefilterMode?: string };
    experiment?: { vision?: { conditions?: { label?: string; prefilterMode?: string } } };
  };
  expect(snapshot).toMatchObject({
    configuration: {
      prefilterMode: "enabled",
      expectedProfile: "ROBUST",
      declaredTxFps: 5,
      requestedCamera: { width: 1920, height: 1440, fps: 30 },
      actualCamera: { width: 1280, height: 960, fps: 5 },
    },
    conditions: {
      label: "snapshot-context-before-teardown",
      expectedTxFps: 5,
      prefilterMode: "enabled",
    },
    experiment: {
      vision: {
        conditions: {
          label: "snapshot-context-before-teardown",
          prefilterMode: "enabled",
        },
      },
    },
  });
  await expect(page.locator("#debug-snapshot-status")).toContainText("Snapshot ZIP downloaded");
  await expect(page.locator("#preview")).toBeHidden();
  await expect(page.locator("#vision-debug-output")).toBeHidden();
  expect(errors).toEqual([]);
});

test("the COLOR_4 camera worker reconstructs a complete file", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "Chromium provides Playwright's deterministic fake camera.");
  test.setTimeout(120_000);
  await expectColor4CameraReconstruction(page);
});

test("the hosted PWA app shell is available offline", async ({ page, context, browserName }) => {
  await page.goto("/send/");
  await page.evaluate(async () => {
    if (!("serviceWorker" in navigator)) throw new Error("Service workers unavailable");
    await navigator.serviceWorker.ready;
  });
  await context.setOffline(true);
  try {
    if (browserName === "webkit") {
      // Playwright WebKit currently reports an internal inspector error for
      // any offline navigation, even when a controlling service worker has
      // the response. Verify the actual precached response while the network
      // is disabled; Chromium below additionally exercises navigation.
      const cachedShell = await page.evaluate(async () => {
        for (const cacheName of await caches.keys()) {
          const cache = await caches.open(cacheName);
          const request = (await cache.keys()).find(
            (candidate) => new URL(candidate.url).pathname.endsWith("/send/index.html"),
          );
          if (!request) continue;
          const response = await cache.match(request);
          if (response && (await response.text()).includes('id="tool-title"')) return true;
        }
        return false;
      });
      expect(cachedShell).toBe(true);
    } else {
      await page.reload({ waitUntil: "domcontentloaded" });
      await expect(page.locator("#tool-title")).toBeVisible();
      await expect(page.locator("#carrier-picker")).toBeVisible();
    }
  } finally {
    await context.setOffline(false);
  }
});

test("a service-worker update waits for an active transfer lease", async ({ page }) => {
  await page.goto("/send/");
  const controlled = await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    return navigator.serviceWorker.controller !== null;
  });
  if (!controlled) {
    await page.reload();
    await page.evaluate(() => navigator.serviceWorker.ready);
  }

  // In WebKit, serviceWorker.ready can resolve before the sender finishes its
  // asynchronous preference bootstrap. Wait for existing UI behavior that is
  // wired at the end of that bootstrap; otherwise applyMode()'s normal startup
  // cleanup can race a synthetic transfer-active class and correctly release
  // the lease before this test observes it.
  const fileMode = page.locator('label:has(input[name="send-mode"][value="file"])');
  const snippetMode = page.locator('label:has(input[name="send-mode"][value="snippet"])');
  await expect.poll(async () => {
    await fileMode.click();
    await snippetMode.click();
    return page.locator("#pane-snippet").isVisible();
  }).toBe(true);
  await fileMode.click();
  await expect(page.locator("#pane-file")).toBeVisible();
  await expect(page.locator("#cfg-file")).toBeEnabled();

  await page.evaluate(() => {
    document.body.classList.add("transfer-active");
    (window as typeof window & { updateProbe?: boolean }).updateProbe = true;
    navigator.serviceWorker.dispatchEvent(new Event("controllerchange"));
  });
  await page.waitForTimeout(300);
  expect(
    await page.evaluate(() => (window as typeof window & { updateProbe?: boolean }).updateProbe),
  ).toBe(true);

  const navigated = page.waitForEvent("framenavigated", (frame) => frame === page.mainFrame());
  await page.evaluate(() => document.body.classList.remove("transfer-active"));
  await navigated;
  await expect(page.locator("#carrier-picker")).toBeVisible();
});

test("standalone artifacts are QR-only and contain no OpenCV payload", async ({ page }) => {
  for (const fileName of ["cvtp-sender.html", "cvtp-receiver.html"]) {
    const path = resolve("dist-standalone", fileName);
    const html = await readFile(path, "utf8");
    expect(Buffer.byteLength(html)).toBeLessThan(8 * 1024 * 1024);
    expect(html).toContain("Color Visual Transfer Protocol");
    expect(html).toContain(">CVTP<");
    expect(html).not.toContain(retiredPrimaryBrand);
    expect(html).not.toContain("@techstark/opencv-js");
    expect(html).not.toContain("OpenCV.js is ready");
    expect(html).not.toContain("COLOR_4");
    expect(html).not.toContain("color4-worker");
    expect(html).not.toContain("createColor4");
    expect(html).not.toContain("KCMY");
    expect(html).not.toContain("KRGB");
    expect(html).not.toContain("cfg-color-profile");
    expect(html).not.toContain("cfg-color-palette");
    expect(html).not.toContain("carrier-color-option");
    expect(html).not.toContain("data-color-setting");
    expect(html).not.toContain("data-color-debug");
    expect(html).not.toContain("Debug Vision");
    expect(html).not.toContain("capture-debug-snapshot");
    expect(html).not.toContain("last vision stage");
    expect(html).not.toContain("m-reason");
    expect(html).not.toContain("m-pipeline");
    expect(html).not.toContain("m-fiducials");
    expect(html).not.toContain("createStoredZip");
    expect(html).not.toContain("cvtp-vision-");
    expect(html).not.toContain("zip-store");
    expect(html).not.toContain('"color4"');

    await page.goto(pathToFileURL(path).href);
    await expect(page.locator("#carrier-picker")).toBeHidden();
    await expect(page.locator('input[name="carrier"][value="qr"]')).toBeChecked();
  }
});

test("Signal Workshop stays usable at desktop and mobile viewports", async ({ page }) => {
  const cases = [
    {
      path: "/",
      controls: [".mode-nav a", 'main a[href="./send/"]', 'main a[href="./receive/"]', "#share-open"],
    },
    {
      path: "/send/",
      controls: [
        ".mode-nav a",
        "#mode-picker label",
        "#carrier-picker label",
        "#pane-file",
        "details.settings > summary",
      ],
    },
    {
      path: "/receive/",
      controls: [
        ".mode-nav a",
        "#carrier-picker label",
        "#start",
        "#settings > summary",
      ],
    },
  ] as const;

  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    for (const entry of cases) {
      await page.goto(entry.path);
      await expect(page.locator("main h1")).toBeVisible();

      const layout = await page.evaluate((selectors) => {
        const visible = (element: Element): element is HTMLElement => {
          if (!(element instanceof HTMLElement)) return false;
          const style = getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
        };
        const main = document.querySelector("main");
        const mainRect = main?.getBoundingClientRect();
        const seen = new Set<HTMLElement>();
        const undersized: string[] = [];
        for (const selector of selectors) {
          for (const element of document.querySelectorAll(selector)) {
            if (!visible(element) || seen.has(element)) continue;
            seen.add(element);
            const rect = element.getBoundingClientRect();
            if (rect.width + 0.5 < 44 || rect.height + 0.5 < 44) {
              undersized.push(
                `${element.tagName.toLowerCase()}#${element.id || "-"}.${element.className || "-"} ${rect.width.toFixed(1)}×${rect.height.toFixed(1)}`,
              );
            }
          }
        }
        return {
          horizontalOverflow:
            Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) -
            document.documentElement.clientWidth,
          mainVisible: Boolean(
            mainRect &&
              mainRect.width > 0 &&
              mainRect.height > 0 &&
              mainRect.right > 0 &&
              mainRect.left < window.innerWidth,
          ),
          checkedControls: seen.size,
          undersized,
        };
      }, entry.controls);

      expect(layout.horizontalOverflow, `${entry.path} at ${viewport.width}px overflows`).toBeLessThanOrEqual(1);
      expect(layout.mainVisible, `${entry.path} at ${viewport.width}px hides main content`).toBe(true);
      expect(layout.checkedControls, `${entry.path} at ${viewport.width}px has no key controls`).toBeGreaterThan(0);
      expect(layout.undersized, `${entry.path} at ${viewport.width}px has touch targets under 44px`).toEqual([]);
    }

    await page.goto("/receive/");
    await page.locator("#carrier-color-option").click();
    await page.locator("details:has(> summary:text-is('Debug Vision')) > summary").click();
    const debugLayout = await page.evaluate(() => {
      const selectors = [
        ".debug-toggle",
        "#cfg-debug-view",
        "#cfg-debug-scale",
        "#cfg-debug-detection",
        "#cfg-debug-label",
        "#cfg-debug-tx",
        "#cfg-debug-distance",
        "#cfg-debug-angle",
        "#cfg-debug-brightness",
        "#capture-debug-snapshot",
      ];
      const undersized: string[] = [];
      for (const selector of selectors) {
        const element = document.querySelector<HTMLElement>(selector);
        if (!element) {
          undersized.push(`${selector} missing`);
          continue;
        }
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        if (style.display === "none" || style.visibility === "hidden") {
          undersized.push(`${selector} hidden`);
        } else if (rect.width + 0.5 < 44 || rect.height + 0.5 < 44) {
          undersized.push(`${selector} ${rect.width.toFixed(1)}×${rect.height.toFixed(1)}`);
        }
      }
      return {
        overflow: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) -
          document.documentElement.clientWidth,
        undersized,
      };
    });
    expect(debugLayout.overflow, `Debug Vision at ${viewport.width}px overflows`).toBeLessThanOrEqual(1);
    expect(debugLayout.undersized, `Debug Vision at ${viewport.width}px has inaccessible controls`).toEqual([]);
  }
});
