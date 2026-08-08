// Regenerate every public brand raster from the checked-in CVTP SVG:
//
//   npm run icons
//
// @resvg/resvg-js is pinned in package.json, so this produces the same assets
// on Windows, macOS, and Linux without a system librsvg installation. The
// social card deliberately uses vector geometry instead of system fonts; that
// keeps raster output independent of which fonts happen to be installed.

import { Resvg } from "@resvg/resvg-js";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const publicDir = fileURLToPath(new URL("../public", import.meta.url));
const markSource = readFileSync(join(publicDir, "cvtp-mark.svg"), "utf8");

const sourceMatch = markSource.match(
  /^<svg\b[^>]*\bviewBox=["']0 0 640 640["'][^>]*>([\s\S]*)<\/svg>\s*$/,
);
if (!sourceMatch) {
  throw new Error("cvtp-mark.svg must keep a 0 0 640 640 viewBox");
}
const markContents = sourceMatch.at(1);
if (markContents === undefined) {
  throw new Error("cvtp-mark.svg is missing its mark contents");
}

const mark = markContents
  .replace(/\s*<title\b[\s\S]*?<\/title>/g, "")
  .replace(/\s*<desc\b[\s\S]*?<\/desc>/g, "")
  .trim();

function iconSvg(scale: number, radius: number): string {
  const offset = (640 - 640 * scale) / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 640">
  <rect width="640" height="640" rx="${radius}" fill="#0B0D10"/>
  <g transform="translate(${offset} ${offset}) scale(${scale})">${mark}</g>
</svg>`;
}

// A font-free social card: the CVTP wordmark is constructed from geometric
// paths and the signal field reuses the exact normative K/C/M/Y brand colors.
function socialCardSvg(): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 630">
  <rect width="1200" height="630" fill="#0B0D10"/>
  <path d="M0 72h1200M0 558h1200" stroke="#F4F1EA" stroke-opacity=".09"/>
  <path d="M72 0v630M1128 0v630" stroke="#F4F1EA" stroke-opacity=".09"/>
  <g transform="translate(62 64) scale(.78)">${mark}</g>
  <path d="M596 112h532" stroke="#F4F1EA" stroke-opacity=".16" stroke-width="2"/>
  <g fill="#F4F1EA">
    <path d="M620 194h110v38h-68v156h68v38H620z"/>
    <path d="M742 194h38l34 164 34-164h38l-50 232h-44z"/>
    <path d="M888 194h100v38h-29v194h-42V232h-29z"/>
  </g>
  <path d="M1002 426V194h112v148h-70v84zm42-194v72h28v-72z" fill="#F4F1EA"/>
  <g>
    <path d="M620 520h118" stroke="#101010" stroke-width="18"/>
    <path d="M744 520h118" stroke="#27D9D4" stroke-width="18"/>
    <path d="M868 520h118" stroke="#ED63C7" stroke-width="18"/>
    <path d="M992 520h122" stroke="#F2CC52" stroke-width="18"/>
  </g>
</svg>`;
}

function render(svg: string, width: number, out: string): void {
  const image = new Resvg(svg, {
    fitTo: { mode: "width", value: width },
  }).render();
  writeFileSync(join(publicDir, out), image.asPng());
  console.log(`public/${out} (${image.width}x${image.height})`);
}

render(iconSvg(0.8, 112), 192, "icon-192.png");
render(iconSvg(0.8, 112), 512, "icon-512.png");
render(iconSvg(0.61, 0), 512, "icon-maskable-512.png");
render(iconSvg(0.8, 0), 180, "apple-touch-icon.png");
render(socialCardSvg(), 1200, "og.png");
