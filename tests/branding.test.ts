import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";

const root = resolve(".");
const text = (path: string) => readFile(join(root, path), "utf8");
const retiredPrimaryBrand = ["Decimen", "COLOR_4"].join(" ");

test("public source identifies the product as Color Visual Transfer Protocol", async () => {
  const [packageSource, nvmrc, vite, assetBuilder, mark, ...pages] = await Promise.all([
    text("package.json"),
    text(".nvmrc"),
    text("vite.config.ts"),
    text("build/make-icons.ts"),
    text("public/cvtp-mark.svg"),
    text("index.html"),
    text("send/index.html"),
    text("receive/index.html"),
  ]);
  const packageJson = JSON.parse(packageSource) as {
    name?: string;
    description?: string;
    engines?: { node?: string };
    devDependencies?: Record<string, string>;
  };

  assert.equal(packageJson.name, "color-visual-transfer-protocol");
  assert.match(packageJson.description ?? "", /Color Visual Transfer Protocol/);
  assert.match(packageJson.engines?.node ?? "", /22/);
  assert.equal(nvmrc.trim(), "22");
  assert.equal(packageJson.devDependencies?.["@resvg/resvg-js"], "2.6.2");

  assert.match(vite, /name:\s*"Color Visual Transfer Protocol"/);
  assert.match(vite, /short_name:\s*"CVTP"/);
  assert.match(vite, /cvtp-\$\{page === "send" \? "sender" : "receiver"\}\.html/);
  assert.equal(vite.includes(retiredPrimaryBrand), false);

  assert.match(assetBuilder, /@resvg\/resvg-js/);
  assert.match(assetBuilder, /"og\.png"/);
  assert.doesNotMatch(assetBuilder, /rsvg-convert/i);
  assert.match(mark, /#27D9D4/i);
  assert.match(mark, /#ED63C7/i);
  assert.match(mark, /#F2CC52/i);
  assert.doesNotMatch(mark, /Decimen|decimen_logo/);

  for (const page of pages) {
    assert.match(page, /<title>[^<]*(?:CVTP|Color Visual Transfer Protocol)[^<]*<\/title>/);
    assert.match(page, /<meta name="theme-color" content="#0B0D10" \/>/);
    assert.match(page, /<a class="brand" data-brand/);
    assert.match(page, /class="brand-wordmark">CVTP<\/span>/);
    assert.equal(page.includes(retiredPrimaryBrand), false);
  }
});

test("the generated CVTP social card has the declared 1200 by 630 canvas", async () => {
  const png = await readFile(join(root, "public/og.png"));
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(png.toString("ascii", 12, 16), "IHDR");
  assert.equal(png.readUInt32BE(16), 1200);
  assert.equal(png.readUInt32BE(20), 630);
  assert.ok(png.byteLength > 10_000, "social card should contain more than a flat placeholder");
});
