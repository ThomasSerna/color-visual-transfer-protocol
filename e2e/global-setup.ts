import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { LTEncoder } from "../shared/fountain";
import { fnv1a, packFile, packFrame } from "../shared/protocol";
import {
  ROBUST_PROFILE,
  rasterizeColor4,
  wrapColor4Frame,
} from "../shared/color4";

export const COLOR4_CAMERA_FIXTURE = join(tmpdir(), "decimen-color4-playwright.y4m");

const WIDTH = 1280;
const HEIGHT = 960;

function clampByte(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

/** Convert an RGBA frame to the YUV420 stream Chromium accepts as a fake camera. */
function rgbaToI420(rgba: Uint8ClampedArray): Uint8Array {
  const yPlane = new Uint8Array(WIDTH * HEIGHT);
  const uPlane = new Uint8Array((WIDTH / 2) * (HEIGHT / 2));
  const vPlane = new Uint8Array(uPlane.length);
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const offset = (y * WIDTH + x) * 4;
      const red = rgba[offset]!;
      const green = rgba[offset + 1]!;
      const blue = rgba[offset + 2]!;
      yPlane[y * WIDTH + x] = clampByte(16 + 0.257 * red + 0.504 * green + 0.098 * blue);
    }
  }
  for (let y = 0; y < HEIGHT; y += 2) {
    for (let x = 0; x < WIDTH; x += 2) {
      let red = 0;
      let green = 0;
      let blue = 0;
      for (let dy = 0; dy < 2; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          const offset = ((y + dy) * WIDTH + x + dx) * 4;
          red += rgba[offset]!;
          green += rgba[offset + 1]!;
          blue += rgba[offset + 2]!;
        }
      }
      red /= 4;
      green /= 4;
      blue /= 4;
      const chroma = (y / 2) * (WIDTH / 2) + x / 2;
      uPlane[chroma] = clampByte(128 - 0.148 * red - 0.291 * green + 0.439 * blue);
      vPlane[chroma] = clampByte(128 + 0.439 * red - 0.368 * green - 0.071 * blue);
    }
  }
  const out = new Uint8Array(yPlane.length + uPlane.length + vPlane.length);
  out.set(yPlane);
  out.set(uPlane, yPlane.length);
  out.set(vPlane, yPlane.length + uPlane.length);
  return out;
}

function cameraRgba(frame: ReturnType<typeof rasterizeColor4>): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(WIDTH * HEIGHT * 4);
  for (let offset = 0; offset < rgba.length; offset += 4) {
    rgba[offset] = 0xf4;
    rgba[offset + 1] = 0xf4;
    rgba[offset + 2] = 0xf4;
    rgba[offset + 3] = 0xff;
  }
  // A projective camera view, not a canonical fast-path fixture. The corner
  // displacement exercises contour detection, orientation and homography.
  const quad = [
    { x: 285, y: 110 },
    { x: 1015, y: 170 },
    { x: 975, y: 845 },
    { x: 235, y: 790 },
  ] as const;
  const [topLeft, topRight, bottomRight, bottomLeft] = quad;
  const dx1 = topRight.x - bottomRight.x;
  const dx2 = bottomLeft.x - bottomRight.x;
  const dx3 = topLeft.x - topRight.x + bottomRight.x - bottomLeft.x;
  const dy1 = topRight.y - bottomRight.y;
  const dy2 = bottomLeft.y - bottomRight.y;
  const dy3 = topLeft.y - topRight.y + bottomRight.y - bottomLeft.y;
  const denominator = dx1 * dy2 - dx2 * dy1;
  const g = (dx3 * dy2 - dx2 * dy3) / denominator;
  const h = (dx1 * dy3 - dx3 * dy1) / denominator;
  const matrix: readonly [number, number, number, number, number, number, number, number, number] = [
    topRight.x - topLeft.x + g * topRight.x,
    bottomLeft.x - topLeft.x + h * bottomLeft.x,
    topLeft.x,
    topRight.y - topLeft.y + g * topRight.y,
    bottomLeft.y - topLeft.y + h * bottomLeft.y,
    topLeft.y,
    g,
    h,
    1,
  ];
  const [a, b, c, d, e, f, p, q, r] = matrix;
  const determinant =
    a * (e * r - f * q) - b * (d * r - f * p) + c * (d * q - e * p);
  const inverse = [
    (e * r - f * q) / determinant,
    (c * q - b * r) / determinant,
    (b * f - c * e) / determinant,
    (f * p - d * r) / determinant,
    (a * r - c * p) / determinant,
    (c * d - a * f) / determinant,
    (d * q - e * p) / determinant,
    (b * p - a * q) / determinant,
    (a * e - b * d) / determinant,
  ];
  const minX = Math.floor(Math.min(...quad.map((point) => point.x)));
  const maxX = Math.ceil(Math.max(...quad.map((point) => point.x)));
  const minY = Math.floor(Math.min(...quad.map((point) => point.y)));
  const maxY = Math.ceil(Math.max(...quad.map((point) => point.y)));
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const scale = inverse[6]! * x + inverse[7]! * y + inverse[8]!;
      const u = (inverse[0]! * x + inverse[1]! * y + inverse[2]!) / scale;
      const v = (inverse[3]! * x + inverse[4]! * y + inverse[5]!) / scale;
      if (u < 0 || u > 1 || v < 0 || v > 1) continue;
      const sourceX = Math.min(frame.width - 1, Math.floor(u * frame.width));
      const sourceY = Math.min(frame.height - 1, Math.floor(v * frame.height));
      const source = (sourceY * frame.width + sourceX) * 4;
      const destination = (y * WIDTH + x) * 4;
      rgba[destination] = frame.pixels[source]!;
      rgba[destination + 1] = frame.pixels[source + 1]!;
      rgba[destination + 2] = frame.pixels[source + 2]!;
    }
  }
  // Small clipped highlight over data cells: FEC must correct or reject it;
  // this fixture only passes when the recovered file remains byte-exact.
  for (let y = 455; y < 478; y++) {
    for (let x = 630; x < 642; x++) {
      const destination = (y * WIDTH + x) * 4;
      rgba[destination] = 0xff;
      rgba[destination + 1] = 0xff;
      rgba[destination + 2] = 0xff;
    }
  }
  return rgba;
}

export default async function globalSetup(): Promise<void> {
  const original = Uint8Array.from({ length: 96 }, (_, index) => (index * 61 + 17) & 0xff);
  const packed = await packFile("camera-e2e.bin", "application/octet-stream", original);
  const sessionId = 0x4242;
  const sequence = 0;
  const fountain = new LTEncoder(packed.container, ROBUST_PROFILE.blockBytes, sessionId);
  const inner = packFrame(
    {
      sessionId,
      seq: sequence,
      k: fountain.k,
      blockLen: ROBUST_PROFILE.blockBytes,
      totalLen: packed.container.length,
      payloadFnv: fnv1a(packed.container),
    },
    fountain.encode(sequence),
  );
  const encoded = wrapColor4Frame(inner, { profileId: ROBUST_PROFILE.id, paletteId: 0 });
  const raster = rasterizeColor4(encoded.codedBytes, {
    profile: ROBUST_PROFILE,
    paletteId: 0,
    sequence,
    moduleScale: 4,
  });
  const i420 = rgbaToI420(cameraRgba(raster));
  const header = new TextEncoder().encode(
    `YUV4MPEG2 W${WIDTH} H${HEIGHT} F30:1 Ip A1:1 C420jpeg\n`,
  );
  const frameHeader = new TextEncoder().encode("FRAME\n");
  const fixture = new Uint8Array(header.length + 3 * (frameHeader.length + i420.length));
  let offset = 0;
  fixture.set(header, offset);
  offset += header.length;
  for (let frame = 0; frame < 3; frame++) {
    fixture.set(frameHeader, offset);
    offset += frameHeader.length;
    fixture.set(i420, offset);
    offset += i420.length;
  }
  await writeFile(COLOR4_CAMERA_FIXTURE, fixture);
}
