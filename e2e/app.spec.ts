import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const retiredPrimaryBrand = ["Decimen", "COLOR_4"].join(" ");

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

test("receiver exposes one explicit carrier and carrier-specific settings", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/receive/");

  const qr = page.locator('input[name="carrier"][value="qr"]');
  const color = page.locator('input[name="carrier"][value="color4"]');
  await expect(qr).toBeChecked();
  await page.locator("#settings > summary").click();
  await expect(page.locator("#cfg-workers")).toBeVisible();
  await page.locator("#carrier-color-option").click();
  await expect(color).toBeChecked();
  await expect(qr).not.toBeChecked();
  await expect(page.locator("#cfg-color-palette")).toBeVisible();
  await expect(page.locator("#cfg-workers")).toBeHidden();
  expect(errors).toEqual([]);
});

test("the COLOR_4 camera worker reconstructs a complete file", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "Chromium provides Playwright's deterministic fake camera.");
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const openCvLoaded = page.waitForResponse(
    (response) => /\/assets\/opencv-[^/]+\.js$/.test(response.url()) && response.status() === 200,
  );
  await page.goto("/receive/");
  await page.locator("#carrier-color-option").click();
  await page.locator("#start").click();
  await openCvLoaded;

  await expect(page.locator("#result .done")).toHaveText("Signal recovered", {
    timeout: 90_000,
  });
  await expect(page.locator('#result a[download="camera-e2e.bin"]')).toHaveText(
    "Save camera-e2e.bin",
  );
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
  expect(metrics.history[0]!.validFrames).toBeGreaterThan(0);
  expect(errors).toEqual([]);
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
  }
});
