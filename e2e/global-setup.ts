import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { LTDecoder, LTEncoder } from "../shared/fountain";
import { fnv1a, packFile, packFrame } from "../shared/protocol";
import {
  EXPERIMENTAL_PROFILE,
  ROBUST_PROFILE,
  rasterizeColor4,
  wrapColor4Frame,
} from "../shared/color4";

export const COLOR4_CAMERA_FIXTURE = join(tmpdir(), "cvtp-color4-playwright.y4m");
export const COLOR4_CAMERA_DEGRADED_FIXTURE = join(
  tmpdir(),
  "cvtp-color4-playwright-degraded.y4m",
);
export const COLOR4_CAMERA_EXPERIMENTAL_FIXTURE = join(
  tmpdir(),
  "cvtp-color4-playwright-experimental.y4m",
);

/**
 * The fake camera must exercise the fountain receiver, not just the optical
 * carrier. For k=2, sequences 1/2/3 are redundant degree-two equations and
 * sequence 0 is the final degree-one equation that starts the peeling cascade.
 * Holds make every optical sequence visible long enough for the single vision
 * worker, and the second appearance of sequence 1 exercises duplicate handling.
 */
export const COLOR4_CAMERA_SCHEDULE = [
  { sequence: 1, hold: 4 },
  { sequence: 2, hold: 4 },
  { sequence: 1, hold: 4 },
  { sequence: 3, hold: 4 },
  { sequence: 0, hold: 4 },
] as const;

function incompressiblePayload(length: number, seed: number): Uint8Array {
  const bytes = new Uint8Array(length);
  let state = seed >>> 0;
  for (let index = 0; index < bytes.length; index++) {
    // Deterministic xorshift32 output is deliberately incompressible enough to
    // keep packFile() on the uncompressed path and the fixture at k > 1.
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    bytes[index] = state >>> 24;
  }
  return bytes;
}

export const COLOR4_CAMERA_PAYLOAD = incompressiblePayload(2_048, 0x6d2b79f5);

/**
 * EXPERIMENTAL carries 3,306 bytes per LT block against ROBUST's 1,298, so the
 * ROBUST payload would collapse this fixture to k = 1 and stop exercising the
 * fountain. 5,000 bytes packs to a 5,100-byte container, which is k = 2 — the
 * same shape the schedule above is written for.
 */
export const COLOR4_EXPERIMENTAL_PAYLOAD = incompressiblePayload(5_000, 0x1b8f3c27);

const WIDTH = 1280;
const HEIGHT = 960;
type CameraQuad = readonly [
  Readonly<{ x: number; y: number }>,
  Readonly<{ x: number; y: number }>,
  Readonly<{ x: number; y: number }>,
  Readonly<{ x: number; y: number }>,
];
const BASELINE_CAMERA_QUAD: CameraQuad = [
  { x: 285, y: 110 },
  { x: 1015, y: 170 },
  { x: 975, y: 845 },
  { x: 235, y: 790 },
];
const DEGRADED_CAMERA_QUAD: CameraQuad = [
  { x: 210, y: 75 },
  { x: 1090, y: 140 },
  { x: 1050, y: 885 },
  { x: 165, y: 820 },
];
/**
 * EXPERIMENTAL packs 120x119 data cells into the same 172-module frame, so it
 * needs the code to fill more of the camera view than ROBUST does. This quad
 * spans roughly 860 px, about 5.0 camera pixels per module — the regime the
 * physical exports actually report, rather than a comfortable one.
 */
const EXPERIMENTAL_CAMERA_QUAD: CameraQuad = [
  { x: 208, y: 48 },
  { x: 1072, y: 76 },
  { x: 1048, y: 912 },
  { x: 186, y: 884 },
];

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

function addDataGlare(rgba: Uint8ClampedArray): void {
  // Small clipped highlight over data cells: FEC must correct or reject it;
  // the E2E only passes when the recovered file remains byte-exact.
  for (let y = 455; y < 478; y++) {
    for (let x = 630; x < 642; x++) {
      const destination = (y * WIDTH + x) * 4;
      rgba[destination] = 0xff;
      rgba[destination + 1] = 0xff;
      rgba[destination + 2] = 0xff;
    }
  }
}

function addDegradedDataGlare(rgba: Uint8ClampedArray): void {
  // Keep the combined fixture's highlight within one projected data module;
  // the baseline above retains the larger multi-module glare case.
  for (let y = 464; y < 468; y++) {
    for (let x = 634; x < 638; x++) {
      const destination = (y * WIDTH + x) * 4;
      rgba[destination] = 0xff;
      rgba[destination + 1] = 0xff;
      rgba[destination + 2] = 0xff;
    }
  }
}

function cameraRgba(
  frame: ReturnType<typeof rasterizeColor4>,
  includeGlare = true,
  quad: CameraQuad = BASELINE_CAMERA_QUAD,
): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(WIDTH * HEIGHT * 4);
  for (let offset = 0; offset < rgba.length; offset += 4) {
    rgba[offset] = 0xf4;
    rgba[offset + 1] = 0xf4;
    rgba[offset + 2] = 0xf4;
    rgba[offset + 3] = 0xff;
  }
  // A projective camera view, not a canonical fast-path fixture. The corner
  // displacement exercises contour detection, orientation and homography.
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
  if (includeGlare) addDataGlare(rgba);
  return rgba;
}

/**
 * Apply the deterministic degraded-camera scenario after projective rendering.
 * The separable [1 2 1] kernel is OpenCV's 3x3 Gaussian blur, followed by the
 * requested 0.9 exposure and integer noise in [-2, 2]. The YUV420 conversion
 * remains the final step when the fake-camera frame is serialized.
 */
function degradedCameraRgba(
  frame: ReturnType<typeof rasterizeColor4>,
  sequence: number,
): Uint8ClampedArray {
  const source = cameraRgba(frame, false, DEGRADED_CAMERA_QUAD);
  const horizontal = new Uint16Array(WIDTH * HEIGHT * 3);
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const left = (y * WIDTH + Math.max(0, x - 1)) * 4;
      const center = (y * WIDTH + x) * 4;
      const right = (y * WIDTH + Math.min(WIDTH - 1, x + 1)) * 4;
      const destination = (y * WIDTH + x) * 3;
      for (let channel = 0; channel < 3; channel++) {
        horizontal[destination + channel] =
          source[left + channel]! + 2 * source[center + channel]! + source[right + channel]!;
      }
    }
  }

  const degraded = new Uint8ClampedArray(source.length);
  let noiseState = (0x9e3779b9 ^ sequence) >>> 0;
  const noise = (): number => {
    noiseState ^= noiseState << 13;
    noiseState ^= noiseState >>> 17;
    noiseState ^= noiseState << 5;
    return (noiseState >>> 0) % 5 - 2;
  };
  for (let y = 0; y < HEIGHT; y++) {
    const aboveY = Math.max(0, y - 1);
    const belowY = Math.min(HEIGHT - 1, y + 1);
    for (let x = 0; x < WIDTH; x++) {
      const above = (aboveY * WIDTH + x) * 3;
      const center = (y * WIDTH + x) * 3;
      const below = (belowY * WIDTH + x) * 3;
      const destination = (y * WIDTH + x) * 4;
      for (let channel = 0; channel < 3; channel++) {
        const blurred =
          (horizontal[above + channel]! +
            2 * horizontal[center + channel]! +
            horizontal[below + channel]!) /
          16;
        degraded[destination + channel] = clampByte(blurred * 0.9 + noise());
      }
      degraded[destination + 3] = 0xff;
    }
  }
  addDegradedDataGlare(degraded);
  return degraded;
}

function y4mFixture(
  frames: readonly Uint8Array[],
): Uint8Array {
  const header = new TextEncoder().encode(
    `YUV4MPEG2 W${WIDTH} H${HEIGHT} F5:1 Ip A1:1 C420jpeg\n`,
  );
  const frameHeader = new TextEncoder().encode("FRAME\n");
  const frameBytes = WIDTH * HEIGHT * 3 / 2;
  const fixture = new Uint8Array(
    header.length + frames.length * (frameHeader.length + frameBytes),
  );
  let offset = 0;
  fixture.set(header, offset);
  offset += header.length;
  for (const i420 of frames) {
    fixture.set(frameHeader, offset);
    offset += frameHeader.length;
    fixture.set(i420, offset);
    offset += i420.length;
  }
  return fixture;
}

/**
 * Deterministic rolling-display surrogate: old symbol on top, new on bottom,
 * with a short dark blanking band at the scan boundary. A plain KCMY split can
 * remain below the frozen 0.025 luma threshold because much of the carrier is
 * photometrically unchanged; the band makes this fixture an actual transition
 * test instead of silently exercising the redundant-stable path.
 */
function splitTransitionI420(previous: Uint8Array, current: Uint8Array): Uint8Array {
  const yBytes = WIDTH * HEIGHT;
  const chromaBytes = yBytes / 4;
  const output = new Uint8Array(current.length);
  const copySplitPlane = (offset: number, length: number): void => {
    const half = length / 2;
    output.set(previous.subarray(offset, offset + half), offset);
    output.set(current.subarray(offset + half, offset + length), offset + half);
  };
  copySplitPlane(0, yBytes);
  copySplitPlane(yBytes, chromaBytes);
  copySplitPlane(yBytes + chromaBytes, chromaBytes);
  const bandStart = Math.floor(HEIGHT * 5 / 12);
  const bandEnd = Math.ceil(HEIGHT * 7 / 12);
  for (let y = bandStart; y < bandEnd; y++) {
    output.fill(16, y * WIDTH, (y + 1) * WIDTH);
  }
  const chromaStart = Math.floor(bandStart / 2);
  const chromaEnd = Math.ceil(bandEnd / 2);
  const chromaWidth = WIDTH / 2;
  for (const planeOffset of [yBytes, yBytes + chromaBytes]) {
    for (let y = chromaStart; y < chromaEnd; y++) {
      output.fill(128, planeOffset + y * chromaWidth, planeOffset + (y + 1) * chromaWidth);
    }
  }
  return output;
}

function cameraTimeline(frames: ReadonlyMap<number, Uint8Array>): Uint8Array[] {
  const timeline: Uint8Array[] = [];
  let previous: Uint8Array | undefined;
  for (const entry of COLOR4_CAMERA_SCHEDULE) {
    const current = frames.get(entry.sequence);
    if (!current) throw new Error(`Missing fake-camera raster for sequence ${entry.sequence}.`);
    if (previous && previous !== current) timeline.push(splitTransitionI420(previous, current));
    for (let held = 0; held < entry.hold; held++) timeline.push(current);
    previous = current;
  }
  return timeline;
}

interface CameraFixtureVariant {
  /** Name for the y4m rasters this variant produces. */
  readonly label: string;
  readonly renderer: (
    raster: ReturnType<typeof rasterizeColor4>,
    sequence: number,
  ) => Uint8ClampedArray;
  readonly path: string;
}

/**
 * Render one profile's fountain stream into every requested camera variant.
 *
 * The LT probe is deliberately run against the same schedule the timeline uses:
 * a fixture that cannot reconstruct its own container is a broken gate, and it
 * should fail here rather than as a mysterious browser timeout.
 */
async function writeCameraFixtures(
  profile: typeof ROBUST_PROFILE,
  fileName: string,
  payload: Uint8Array,
  sessionId: number,
  variants: readonly CameraFixtureVariant[],
): Promise<void> {
  const packed = await packFile(fileName, "application/octet-stream", payload);
  const fountain = new LTEncoder(packed.container, profile.blockBytes, sessionId);
  if (fountain.k <= 1) {
    throw new Error(`The ${profile.name} camera E2E fixture must span multiple LT blocks.`);
  }

  const framesByVariant = variants.map(() => new Map<number, Uint8Array>());
  const probe = new LTDecoder(
    fountain.k,
    profile.blockBytes,
    sessionId,
    packed.container.length,
  );
  for (const entry of COLOR4_CAMERA_SCHEDULE) {
    const block = fountain.encode(entry.sequence);
    for (let held = 0; held < entry.hold; held++) {
      probe.addFrame(entry.sequence, block);
    }
    if (framesByVariant[0]!.has(entry.sequence)) continue;
    const inner = packFrame(
      {
        sessionId,
        seq: entry.sequence,
        k: fountain.k,
        blockLen: profile.blockBytes,
        totalLen: packed.container.length,
        payloadFnv: fnv1a(packed.container),
      },
      block,
    );
    const encoded = wrapColor4Frame(inner, { profileId: profile.id, paletteId: 0 });
    const raster = rasterizeColor4(encoded.codedBytes, {
      profile,
      paletteId: 0,
      sequence: entry.sequence,
      moduleScale: 4,
    });
    variants.forEach((variant, index) => {
      framesByVariant[index]!.set(
        entry.sequence,
        rgbaToI420(variant.renderer(raster, entry.sequence)),
      );
    });
  }
  if (!probe.isComplete || probe.framesNew < 2 || probe.framesDup < 1) {
    throw new Error(
      `The ${profile.name} camera E2E schedule must reconstruct with new and duplicate LT frames.`,
    );
  }
  const assembled = probe.assemble();
  if (!assembled || !assembled.every((byte, index) => byte === packed.container[index])) {
    throw new Error(
      `The ${profile.name} camera E2E schedule did not reconstruct its DCF2 container exactly.`,
    );
  }

  await Promise.all(variants.map((variant, index) =>
    writeFile(variant.path, y4mFixture(cameraTimeline(framesByVariant[index]!)))
  ));
}

export default async function globalSetup(): Promise<void> {
  await writeCameraFixtures(
    ROBUST_PROFILE,
    "camera-e2e.bin",
    COLOR4_CAMERA_PAYLOAD,
    0x4242,
    [
      {
        label: "baseline",
        renderer: (raster) => cameraRgba(raster),
        path: COLOR4_CAMERA_FIXTURE,
      },
      {
        label: "degraded",
        renderer: (raster, sequence) => degradedCameraRgba(raster, sequence),
        path: COLOR4_CAMERA_DEGRADED_FIXTURE,
      },
    ],
  );

  // EXPERIMENTAL had no end-to-end coverage at all: every fake-camera project
  // exercised ROBUST, so nothing caught a regression that only reached the
  // denser profile. It uses the single-module glare rather than the baseline's
  // multi-module highlight, because 16 parity symbols per shard cannot absorb
  // the same damage 32 can.
  await writeCameraFixtures(
    EXPERIMENTAL_PROFILE,
    "camera-e2e-experimental.bin",
    COLOR4_EXPERIMENTAL_PAYLOAD,
    // The LT degree distribution is seeded from the session id, so a schedule
    // that peels for one session need not peel for another. This one makes
    // sequences 1/2/3 redundant degree-two equations and sequence 0 the
    // degree-one equation that starts the cascade, matching the schedule's
    // intent; the probe below fails the build if that ever stops holding.
    0x4300,
    [
      {
        label: "experimental",
        renderer: (raster) => {
          const rgba = cameraRgba(raster, false, EXPERIMENTAL_CAMERA_QUAD);
          addDegradedDataGlare(rgba);
          return rgba;
        },
        path: COLOR4_CAMERA_EXPERIMENTAL_FIXTURE,
      },
    ],
  );
}
