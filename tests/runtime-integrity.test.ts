import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));

interface RuntimePin {
  readonly name: string;
  readonly version: string;
  readonly packageJson: string;
  readonly asset: string;
  readonly sha256: string;
}

const runtimePins: readonly RuntimePin[] = [
  {
    name: "zxing-wasm",
    version: "2.2.4",
    packageJson: "node_modules/zxing-wasm/package.json",
    asset: "node_modules/zxing-wasm/dist/reader/zxing_reader.wasm",
    sha256: "85d46f55d7c86a4d09bb04273367408b19c324f582d040d018aecb25a9a82942",
  },
  {
    name: "@techstark/opencv-js",
    version: "5.0.0-release.1",
    packageJson: "node_modules/@techstark/opencv-js/package.json",
    asset: "node_modules/@techstark/opencv-js/dist/opencv.js",
    sha256: "b873c8211421da7b9bf41ae157a923f05a46a0b8d3e5904c44c6f3ad6d39a1bd",
  },
];

test("NOTICE pins the exact self-hosted optical runtime assets installed by npm ci", async () => {
  const notice = await readFile(path.join(projectRoot, "NOTICE.md"), "utf8");

  for (const pin of runtimePins) {
    const packageMetadata = JSON.parse(
      await readFile(path.join(projectRoot, pin.packageJson), "utf8"),
    ) as { version?: string };
    const asset = await readFile(path.join(projectRoot, pin.asset));
    const actualHash = createHash("sha256").update(asset).digest("hex");

    assert.equal(packageMetadata.version, pin.version, `${pin.name} version drifted`);
    assert.equal(
      actualHash,
      pin.sha256,
      `${pin.name} runtime asset drifted; audit it before intentionally updating NOTICE`,
    );
    assert.ok(
      notice.includes(`\`${pin.name}\` ${pin.version}`),
      `${pin.name} version is missing from NOTICE.md`,
    );
    assert.ok(notice.includes(pin.sha256), `${pin.name} SHA-256 is missing from NOTICE.md`);
  }
});
