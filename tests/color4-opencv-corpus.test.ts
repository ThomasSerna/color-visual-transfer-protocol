import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import test, { type TestContext } from "node:test";
import {
  ROBUST_PROFILE,
  decodeCanonicalColor4Raster,
  rasterizeColor4,
  unwrapColor4Frame,
  wrapColor4Frame,
} from "../shared/color4/index.ts";
import { packFrame } from "../shared/protocol.ts";
import {
  normalizeColor4WithOpenCv,
  type OpenCvRuntime,
  type VisionHomographyMethod,
  type VisionWarpInterpolation,
} from "../receive/color4-vision.ts";
import { color4SequencePhaseMatches } from "../receive/color4-binding.ts";
import { runColor4ErasurePolicy } from "../receive/color4-erasure-policy.ts";

interface Point {
  readonly x: number;
  readonly y: number;
}

type Quad = readonly [Point, Point, Point, Point];
type Raster = ReturnType<typeof rasterizeColor4>;

interface CameraImage {
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint8ClampedArray;
}

interface CorpusCv extends OpenCvRuntime {
  readonly BORDER_DEFAULT: number;
  GaussianBlur(...values: unknown[]): void;
}

interface CameraScenario {
  readonly name: string;
  readonly width?: number;
  readonly height?: number;
  readonly turns?: 0 | 1 | 2 | 3;
  readonly quad?: Quad;
  readonly spatialPhotometry?: boolean;
  readonly blurKernel?: 3 | 7;
  readonly exposure?: number;
  readonly noise?: number;
  readonly yuv420?: boolean;
  readonly radialK1?: number;
  readonly glare?: "data" | "fiducial";
}

interface CorpusOutcome {
  readonly scenario: string;
  readonly status: "valid" | "rejected";
  readonly reason: string;
  readonly totalMs: number;
  readonly erasureBytes?: number;
  readonly fiducialErrorMax?: number;
  readonly residualRmsModules?: number;
  readonly homographyMethod: VisionHomographyMethod;
}

interface InterpolationSummary {
  readonly interpolation: VisionWarpInterpolation;
  readonly valid: number;
  readonly rejected: number;
  readonly erasureBytes: number;
  readonly fingerprint: readonly string[];
}

function installImageData(): void {
  if (typeof ImageData !== "undefined") return;
  class CorpusImageData {
    readonly data: Uint8ClampedArray;
    readonly width: number;
    readonly height: number;

    constructor(data: Uint8ClampedArray, width: number, height: number) {
      this.data = data;
      this.width = width;
      this.height = height;
    }
  }
  Object.defineProperty(globalThis, "ImageData", {
    configurable: true,
    value: CorpusImageData,
  });
}

async function loadOpenCv(): Promise<CorpusCv> {
  const imported = (await import("@techstark/opencv-js")) as unknown as Record<string, unknown>;
  const candidate = (imported.default ?? imported) as Record<string, unknown> | Promise<Record<string, unknown>>;
  const runtime: Record<string, unknown> = await Promise.resolve(candidate);
  if (runtime.ready && typeof (runtime.ready as Promise<unknown>).then === "function") {
    await runtime.ready;
  }
  return runtime as unknown as CorpusCv;
}

function innerFrame(sequence: number): Uint8Array {
  const block = new Uint8Array(ROBUST_PROFILE.blockBytes);
  let state = (0x9e37_79b9 ^ sequence) >>> 0;
  for (let index = 0; index < block.length; index++) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    block[index] = state >>> 24;
  }
  return packFrame(
    {
      sessionId: 0x7319,
      seq: sequence,
      k: 1,
      blockLen: block.length,
      totalLen: block.length,
      payloadFnv: 0x81f0_4a2d,
    },
    block,
  );
}

function physicalRaster(sequence: number): { inner: Uint8Array; raster: Raster } {
  const inner = innerFrame(sequence);
  const encoded = wrapColor4Frame(inner, { profileId: ROBUST_PROFILE.id, paletteId: 0 });
  return {
    inner,
    raster: rasterizeColor4(encoded.codedBytes, {
      profile: ROBUST_PROFILE,
      paletteId: 0,
      sequence,
      moduleScale: 4,
    }),
  };
}

function scaledDefaultQuad(width: number, height: number): Quad {
  const x = width / 1280;
  const y = height / 960;
  return [
    { x: 285 * x, y: 110 * y },
    { x: 1015 * x, y: 170 * y },
    { x: 975 * x, y: 845 * y },
    { x: 235 * x, y: 790 * y },
  ];
}

function destinationQuad(scenario: CameraScenario, width: number, height: number): Quad {
  const quad = scenario.quad ?? scaledDefaultQuad(width, height);
  const turns = scenario.turns ?? 0;
  return [0, 1, 2, 3].map((index) => quad[(index + turns) % 4]!) as unknown as Quad;
}

function clampByte(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

interface PhotometricAnchors {
  readonly black: number;
  readonly white: number;
}

const SPATIAL_ANCHOR_NEAR = 11;
const SPATIAL_ANCHOR_FAR = 148;
const CAPTURE_EQUIVALENT_ANCHORS = Object.freeze({
  TL: Object.freeze({ black: 85.63, white: 179.59 }),
  TR: Object.freeze({ black: 125.65, white: 206.97 }),
  BR: Object.freeze({ black: 91.69, white: 174.03 }),
  BL: Object.freeze({ black: 89.96, white: 176.38 }),
});

function interpolate(left: number, right: number, weight: number): number {
  return left + (right - left) * weight;
}

function spatialAnchorsAtActive(activeX: number, activeY: number): PhotometricAnchors {
  const span = SPATIAL_ANCHOR_FAR - SPATIAL_ANCHOR_NEAR;
  const u = Math.max(0, Math.min(1, (activeX - SPATIAL_ANCHOR_NEAR) / span));
  const v = Math.max(0, Math.min(1, (activeY - SPATIAL_ANCHOR_NEAR) / span));
  const topBlack = interpolate(
    CAPTURE_EQUIVALENT_ANCHORS.TL.black,
    CAPTURE_EQUIVALENT_ANCHORS.TR.black,
    u,
  );
  const bottomBlack = interpolate(
    CAPTURE_EQUIVALENT_ANCHORS.BL.black,
    CAPTURE_EQUIVALENT_ANCHORS.BR.black,
    u,
  );
  const topWhite = interpolate(
    CAPTURE_EQUIVALENT_ANCHORS.TL.white,
    CAPTURE_EQUIVALENT_ANCHORS.TR.white,
    u,
  );
  const bottomWhite = interpolate(
    CAPTURE_EQUIVALENT_ANCHORS.BL.white,
    CAPTURE_EQUIVALENT_ANCHORS.BR.white,
    u,
  );
  return {
    black: interpolate(topBlack, bottomBlack, v),
    white: interpolate(topWhite, bottomWhite, v),
  };
}

/** Models the measured corner-dependent display channel before camera projection. */
function applySpatialPhotometry(frame: Raster): Uint8ClampedArray<ArrayBuffer> {
  const output = Uint8ClampedArray.from(frame.pixels);
  for (let y = 0; y < frame.height; y++) {
    const activeY = Math.floor(y / frame.moduleScale) - frame.layout.quietModules;
    for (let x = 0; x < frame.width; x++) {
      const activeX = Math.floor(x / frame.moduleScale) - frame.layout.quietModules;
      const anchors = spatialAnchorsAtActive(activeX, activeY);
      const range = anchors.white - anchors.black;
      const offset = (y * frame.width + x) * 4;
      output[offset] = clampByte(anchors.black + frame.pixels[offset]! / 255 * range);
      output[offset + 1] = clampByte(anchors.black + frame.pixels[offset + 1]! / 255 * range);
      output[offset + 2] = clampByte(anchors.black + frame.pixels[offset + 2]! / 255 * range);
      output[offset + 3] = 255;
    }
  }
  return output;
}

function yuv420RoundTrip(
  source: Uint8ClampedArray,
  width: number,
  height: number,
): Uint8ClampedArray {
  const output = Uint8ClampedArray.from(source);
  for (let y = 0; y < height; y += 2) {
    for (let x = 0; x < width; x += 2) {
      let u = 0;
      let v = 0;
      const luminance = new Array<number>(4);
      for (let dy = 0; dy < 2; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          const sourceX = Math.min(width - 1, x + dx);
          const sourceY = Math.min(height - 1, y + dy);
          const pixel = (sourceY * width + sourceX) * 4;
          const red = source[pixel]!;
          const green = source[pixel + 1]!;
          const blue = source[pixel + 2]!;
          const sample = dy * 2 + dx;
          luminance[sample] = 16 + 0.257 * red + 0.504 * green + 0.098 * blue;
          u += 128 - 0.148 * red - 0.291 * green + 0.439 * blue;
          v += 128 + 0.439 * red - 0.368 * green - 0.071 * blue;
        }
      }
      u = clampByte(u / 4);
      v = clampByte(v / 4);
      for (let dy = 0; dy < 2; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          const targetX = x + dx;
          const targetY = y + dy;
          if (targetX >= width || targetY >= height) continue;
          const sample = dy * 2 + dx;
          const yy = clampByte(luminance[sample]!);
          const pixel = (targetY * width + targetX) * 4;
          output[pixel] = clampByte(1.164 * (yy - 16) + 1.596 * (v - 128));
          output[pixel + 1] = clampByte(
            1.164 * (yy - 16) - 0.392 * (u - 128) - 0.813 * (v - 128),
          );
          output[pixel + 2] = clampByte(1.164 * (yy - 16) + 2.017 * (u - 128));
          output[pixel + 3] = 255;
        }
      }
    }
  }
  return output;
}

/** Deterministic inverse-map radial lens model in normalized image coordinates. */
function radialDistort(
  source: Uint8ClampedArray,
  width: number,
  height: number,
  k1: number,
): Uint8ClampedArray {
  const output = new Uint8ClampedArray(source.length);
  const centerX = (width - 1) / 2;
  const centerY = (height - 1) / 2;
  const focalScale = Math.max(width, height);
  const fallback = 244;
  for (let y = 0; y < height; y++) {
    const normalizedY = (y - centerY) / focalScale;
    for (let x = 0; x < width; x++) {
      const normalizedX = (x - centerX) / focalScale;
      // Normalized camera coordinates use an approximate focal length of one
      // image width; this keeps the synthetic k1 values camera-realistic.
      const radiusSquared = normalizedX * normalizedX + normalizedY * normalizedY;
      const factor = 1 + k1 * radiusSquared;
      const sourceX = centerX + (x - centerX) * factor;
      const sourceY = centerY + (y - centerY) * factor;
      const target = (y * width + x) * 4;
      if (sourceX < 0 || sourceY < 0 || sourceX >= width - 1 || sourceY >= height - 1) {
        output[target] = fallback;
        output[target + 1] = fallback;
        output[target + 2] = fallback;
        output[target + 3] = 255;
        continue;
      }
      const left = Math.floor(sourceX);
      const top = Math.floor(sourceY);
      const xWeight = sourceX - left;
      const yWeight = sourceY - top;
      const topLeft = (top * width + left) * 4;
      const topRight = topLeft + 4;
      const bottomLeft = topLeft + width * 4;
      const bottomRight = bottomLeft + 4;
      for (let channel = 0; channel < 3; channel++) {
        const upper = source[topLeft + channel]! * (1 - xWeight) +
          source[topRight + channel]! * xWeight;
        const lower = source[bottomLeft + channel]! * (1 - xWeight) +
          source[bottomRight + channel]! * xWeight;
        output[target + channel] = clampByte(upper * (1 - yWeight) + lower * yWeight);
      }
      output[target + 3] = 255;
    }
  }
  return output;
}

function quadPoint(quad: Quad, u: number, v: number): Point {
  const topX = quad[0].x * (1 - u) + quad[1].x * u;
  const topY = quad[0].y * (1 - u) + quad[1].y * u;
  const bottomX = quad[3].x * (1 - u) + quad[2].x * u;
  const bottomY = quad[3].y * (1 - u) + quad[2].y * u;
  return {
    x: topX * (1 - v) + bottomX * v,
    y: topY * (1 - v) + bottomY * v,
  };
}

function meanQuadSide(quad: Quad): number {
  let sum = 0;
  for (let index = 0; index < 4; index++) {
    const current = quad[index]!;
    const next = quad[(index + 1) % 4]!;
    sum += Math.hypot(next.x - current.x, next.y - current.y);
  }
  return sum / 4;
}

function addGlare(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  scenario: CameraScenario,
): void {
  if (scenario.glare === undefined) return;
  const quad = destinationQuad(scenario, width, height);
  const fiducialFraction = (6 + 7 + 4.5) / 172;
  const center = scenario.glare === "fiducial"
    ? quadPoint(quad, fiducialFraction, fiducialFraction)
    : quadPoint(quad, 0.53, 0.49);
  const side = meanQuadSide(quad);
  const halfWidth = side * (scenario.glare === "fiducial" ? 0.038 : 0.026);
  const halfHeight = side * (scenario.glare === "fiducial" ? 0.038 : 0.018);
  const left = Math.max(0, Math.floor(center.x - halfWidth));
  const right = Math.min(width, Math.ceil(center.x + halfWidth));
  const top = Math.max(0, Math.floor(center.y - halfHeight));
  const bottom = Math.min(height, Math.ceil(center.y + halfHeight));
  for (let y = top; y < bottom; y++) {
    for (let x = left; x < right; x++) {
      const offset = (y * width + x) * 4;
      pixels[offset] = 255;
      pixels[offset + 1] = 255;
      pixels[offset + 2] = 255;
      pixels[offset + 3] = 255;
    }
  }
}

function degrade(
  source: Uint8ClampedArray,
  width: number,
  height: number,
  scenario: CameraScenario,
): Uint8ClampedArray {
  const output = scenario.radialK1 === undefined
    ? Uint8ClampedArray.from(source)
    : radialDistort(source, width, height, scenario.radialK1);
  const exposure = scenario.exposure ?? 1;
  const amplitude = scenario.noise ?? 0;
  let state = 0xa341_316c;
  for (let offset = 0; offset < output.length; offset += 4) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    const noise = amplitude === 0 ? 0 : ((state & 0xff) / 255 * 2 - 1) * amplitude;
    output[offset] = clampByte(output[offset]! * exposure + noise);
    output[offset + 1] = clampByte(output[offset + 1]! * exposure + noise * 0.8);
    output[offset + 2] = clampByte(output[offset + 2]! * exposure - noise * 0.5);
  }
  addGlare(output, width, height, scenario);
  return scenario.yuv420 ? yuv420RoundTrip(output, width, height) : output;
}

function projectWithOpenCv(
  cv: CorpusCv,
  frame: Raster,
  scenario: CameraScenario,
): CameraImage {
  const width = scenario.width ?? 1280;
  const height = scenario.height ?? 960;
  const rotatedDestination = destinationQuad(scenario, width, height);
  const sourcePixels = scenario.spatialPhotometry
    ? applySpatialPhotometry(frame)
    : Uint8ClampedArray.from(frame.pixels);
  const source = cv.matFromImageData(
    new ImageData(sourcePixels, frame.width, frame.height),
  );
  const sourcePoints = cv.matFromArray(4, 1, cv.CV_32FC2, [
    0, 0,
    frame.width - 1, 0,
    frame.width - 1, frame.height - 1,
    0, frame.height - 1,
  ]);
  const destinationPoints = cv.matFromArray(
    4,
    1,
    cv.CV_32FC2,
    rotatedDestination.flatMap((point) => [point.x, point.y]),
  );
  const transform = cv.getPerspectiveTransform(sourcePoints, destinationPoints);
  const projected = new cv.Mat();
  let blurred: InstanceType<CorpusCv["Mat"]> | undefined;
  try {
    cv.warpPerspective(
      source,
      projected,
      transform,
      new cv.Size(width, height),
      cv.INTER_LINEAR,
      cv.BORDER_CONSTANT,
      new cv.Scalar(244, 244, 244, 255),
    );
    let selected = projected;
    if (scenario.blurKernel !== undefined) {
      blurred = new cv.Mat();
      cv.GaussianBlur(
        projected,
        blurred,
        new cv.Size(scenario.blurKernel, scenario.blurKernel),
        0,
        0,
        cv.BORDER_DEFAULT,
      );
      selected = blurred;
    }
    return {
      width,
      height,
      pixels: degrade(Uint8ClampedArray.from(selected.data), width, height, scenario),
    };
  } finally {
    blurred?.delete();
    projected.delete();
    transform.delete();
    destinationPoints.delete();
    sourcePoints.delete();
    source.delete();
  }
}

function evaluateCamera(
  cv: CorpusCv,
  scenario: string,
  camera: CameraImage,
  expected: Uint8Array,
  warpInterpolation?: VisionWarpInterpolation,
): CorpusOutcome {
  const started = performance.now();
  const normalized = normalizeColor4WithOpenCv(
    cv,
    camera.width,
    camera.height,
    camera.pixels,
    warpInterpolation === undefined ? {} : { warpInterpolation },
  );
  const homographyMethod = normalized.diagnostics.homography.method;
  const residualRmsModules = normalized.diagnostics.homography.residualRmsModules;
  if (normalized.status === "rejected") {
    return {
      scenario,
      status: "rejected",
      reason: `vision:${normalized.reason}`,
      totalMs: performance.now() - started,
      homographyMethod,
      ...(residualRmsModules === undefined ? {} : { residualRmsModules }),
    };
  }
  assert.equal(normalized.diagnostics.config.canonicalScale, 6, "the corpus must exercise production scale");
  assert.equal(
    normalized.diagnostics.config.maxDetectionDimension,
    1280,
    "the corpus must exercise the production detection limit",
  );
  assert.equal(homographyMethod, "corners-16", `${scenario}: OpenCV must use all marker corners`);
  const raster = decodeCanonicalColor4Raster(normalized.image);
  const fiducialErrorMax = raster.diagnostics.fiducialErrorMax;
  const erasureBytes = raster.diagnostics.erasureBytes;
  if (raster.status === "rejected") {
    return {
      scenario,
      status: "rejected",
      reason: `raster:${raster.reason}`,
      totalMs: performance.now() - started,
      erasureBytes,
      fiducialErrorMax,
      homographyMethod,
      ...(residualRmsModules === undefined ? {} : { residualRmsModules }),
    };
  }
  const direct = unwrapColor4Frame(raster.codedBytes, {
    profileId: raster.profile.id,
    paletteId: raster.paletteId,
    erasures: raster.byteErasures,
  });
  if (direct.status === "valid") {
    assert.deepEqual(
      direct.innerFrame,
      expected,
      `${scenario}: a direct all-erasure unwrap must be byte exact`,
    );
  }
  const coordinated = runColor4ErasurePolicy({
    codedBytes: raster.codedBytes,
    profile: raster.profile,
    paletteId: raster.paletteId,
    erasureCandidates: raster.byteErasureCandidates,
    expectedSequencePhase: raster.sequencePhase,
  });
  const unwrapped = coordinated.result;
  if (unwrapped.status === "rejected") {
    return {
      scenario,
      status: "rejected",
      reason: `fec:${unwrapped.reason}`,
      totalMs: performance.now() - started,
      erasureBytes,
      fiducialErrorMax,
      homographyMethod,
      ...(residualRmsModules === undefined ? {} : { residualRmsModules }),
    };
  }
  if (!color4SequencePhaseMatches(unwrapped.header.sequence, raster.sequencePhase)) {
    return {
      scenario,
      status: "rejected",
      reason: "fec:sequence-phase-mismatch",
      totalMs: performance.now() - started,
      erasureBytes,
      fiducialErrorMax,
      homographyMethod,
      ...(residualRmsModules === undefined ? {} : { residualRmsModules }),
    };
  }
  assert.deepEqual(
    unwrapped.innerFrame,
    expected,
    `${scenario}: a confident OpenCV result must be byte exact`,
  );
  return {
    scenario,
    status: "valid",
    reason: "-",
    totalMs: performance.now() - started,
    erasureBytes,
    fiducialErrorMax,
    homographyMethod,
    ...(residualRmsModules === undefined ? {} : { residualRmsModules }),
  };
}

function eraseTopLeftFiducial(source: Raster): Raster {
  const marker = source.layout.fiducials.find((candidate) => candidate.id === "TL")!;
  const pixels = Uint8ClampedArray.from(source.pixels);
  const startX = (source.layout.quietModules + marker.x) * source.moduleScale;
  const startY = (source.layout.quietModules + marker.y) * source.moduleScale;
  const endX = startX + marker.width * source.moduleScale;
  const endY = startY + marker.height * source.moduleScale;
  for (let y = startY; y < endY; y++) {
    for (let x = startX; x < endX; x++) {
      const offset = (y * source.width + x) * 4;
      pixels[offset] = 255;
      pixels[offset + 1] = 255;
      pixels[offset + 2] = 255;
      pixels[offset + 3] = 255;
    }
  }
  return { ...source, pixels };
}

function solidCamera(width: number, height: number, value: number): CameraImage {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let offset = 0; offset < pixels.length; offset += 4) {
    pixels[offset] = value;
    pixels[offset + 1] = value;
    pixels[offset + 2] = value;
    pixels[offset + 3] = 255;
  }
  return { width, height, pixels };
}

function randomCamera(width: number, height: number): CameraImage {
  const pixels = new Uint8ClampedArray(width * height * 4);
  let state = 0x6d2b_79f5;
  for (let offset = 0; offset < pixels.length; offset += 4) {
    state = Math.imul(state ^ (state >>> 15), 1 | state);
    state ^= state + Math.imul(state ^ (state >>> 7), 61 | state);
    const value = (state ^ (state >>> 14)) >>> 0;
    pixels[offset] = value & 0xff;
    pixels[offset + 1] = (value >>> 8) & 0xff;
    pixels[offset + 2] = (value >>> 16) & 0xff;
    pixels[offset + 3] = 255;
  }
  return { width, height, pixels };
}

function mixedPhaseRaster(first: Raster, second: Raster): Raster {
  const pixels = Uint8ClampedArray.from(first.pixels);
  const rowBytes = first.width * 4;
  const split = Math.floor(first.height / 2);
  pixels.set(second.pixels.subarray(split * rowBytes), split * rowBytes);
  return { ...first, pixels };
}

function diagnosticsTable(rows: readonly CorpusOutcome[]): string {
  const headings = ["scenario", "outcome/reason", "ms", "erasures", "fid-max", "residual", "method"];
  const cells = rows.map((row) => [
    row.scenario,
    row.status === "valid" ? "valid" : row.reason,
    row.totalMs.toFixed(1),
    row.erasureBytes?.toString() ?? "-",
    row.fiducialErrorMax?.toString() ?? "-",
    row.residualRmsModules?.toFixed(3) ?? "-",
    row.homographyMethod,
  ]);
  const widths = headings.map((heading, column) =>
    Math.max(heading.length, ...cells.map((row) => row[column]!.length))
  );
  const format = (row: readonly string[]): string =>
    row.map((value, column) => value.padEnd(widths[column]!)).join(" | ");
  return [
    format(headings),
    widths.map((width) => "-".repeat(width)).join("-|-"),
    ...cells.map(format),
  ].join("\n");
}

const PERSPECTIVE_PLUS_10: Quad = [
  { x: 305, y: 100 }, { x: 1025, y: 185 }, { x: 950, y: 850 }, { x: 245, y: 775 },
];
const PERSPECTIVE_MINUS_10: Quad = [
  { x: 265, y: 175 }, { x: 1005, y: 105 }, { x: 1025, y: 790 }, { x: 290, y: 840 },
];
const PERSPECTIVE_PLUS_15: Quad = [
  { x: 320, y: 95 }, { x: 1035, y: 195 }, { x: 930, y: 850 }, { x: 250, y: 760 },
];
const PERSPECTIVE_MINUS_15: Quad = [
  { x: 250, y: 190 }, { x: 990, y: 100 }, { x: 1040, y: 770 }, { x: 310, y: 850 },
];

test("required OpenCV corpus stays valid and extreme frames are exact-or-rejected", {
  timeout: 60_000,
}, async (context: TestContext) => {
  installImageData();
  const cv = await loadOpenCv();
  const base = physicalRaster(0);
  const required: readonly CameraScenario[] = [
    { name: "capture-960", width: 960, height: 720 },
    { name: "capture-1280", width: 1280, height: 960 },
    { name: "capture-1920", width: 1920, height: 1440 },
    { name: "rotation-0", turns: 0 },
    { name: "rotation-90", turns: 1 },
    { name: "rotation-180", turns: 2 },
    { name: "rotation-270", turns: 3 },
    { name: "perspective-plus-10", quad: PERSPECTIVE_PLUS_10 },
    { name: "perspective-minus-10", quad: PERSPECTIVE_MINUS_10 },
    { name: "perspective-plus-15", quad: PERSPECTIVE_PLUS_15 },
    { name: "perspective-minus-15", quad: PERSPECTIVE_MINUS_15 },
    {
      name: "apparent-frame-480",
      quad: [{ x: 410, y: 230 }, { x: 890, y: 245 }, { x: 875, y: 730 }, { x: 395, y: 710 }],
    },
    { name: "yuv420", yuv420: true },
    { name: "gaussian-blur-3", blurKernel: 3 },
    { name: "exposure-0.85", exposure: 0.85 },
    { name: "exposure-1.15", exposure: 1.15 },
    { name: "noise-3", noise: 3 },
    { name: "radial-minus-0.05", radialK1: -0.05 },
    { name: "radial-plus-0.05", radialK1: 0.05 },
    { name: "glare-data", glare: "data" },
    { name: "spatial-photometry", spatialPhotometry: true },
    {
      name: "spatial-photometry-blur-yuv420",
      spatialPhotometry: true,
      blurKernel: 3,
      yuv420: true,
    },
    {
      name: "combined-required",
      blurKernel: 3,
      exposure: 0.9,
      noise: 2,
      yuv420: true,
      glare: "data",
    },
  ];
  const extremes: readonly CameraScenario[] = [
    { name: "extreme-blur-7", blurKernel: 7 },
    {
      name: "extreme-perspective-plus-25",
      quad: [{ x: 365, y: 75 }, { x: 1060, y: 240 }, { x: 865, y: 870 }, { x: 225, y: 720 }],
    },
    {
      name: "extreme-perspective-minus-25",
      quad: [{ x: 205, y: 240 }, { x: 950, y: 70 }, { x: 1080, y: 720 }, { x: 350, y: 885 }],
    },
    { name: "extreme-noise-18", noise: 18 },
    { name: "extreme-exposure-0.65", exposure: 0.65 },
    { name: "extreme-exposure-1.35", exposure: 1.35 },
    { name: "extreme-glare-fiducial", glare: "fiducial" },
    { name: "extreme-radial-minus-0.16", radialK1: -0.16 },
    { name: "extreme-radial-plus-0.16", radialK1: 0.16 },
  ];
  const rows: CorpusOutcome[] = [];
  for (const scenario of required) {
    const outcome = evaluateCamera(
      cv,
      scenario.name,
      projectWithOpenCv(cv, base.raster, scenario),
      base.inner,
    );
    rows.push(outcome);
    assert.equal(outcome.status, "valid", `${scenario.name}: ${outcome.reason}`);
  }

  for (let sequence = 1; sequence <= 3; sequence++) {
    const phase = physicalRaster(sequence);
    const scenario = { name: `sequence-phase-${sequence}` } as const;
    const outcome = evaluateCamera(
      cv,
      scenario.name,
      projectWithOpenCv(cv, phase.raster, scenario),
      phase.inner,
    );
    rows.push(outcome);
    assert.equal(outcome.status, "valid", `${scenario.name}: ${outcome.reason}`);
  }

  for (const scenario of extremes) {
    rows.push(evaluateCamera(
      cv,
      scenario.name,
      projectWithOpenCv(cv, base.raster, scenario),
      base.inner,
    ));
  }

  const next = physicalRaster(1);
  const negativeCameras: readonly (readonly [string, CameraImage])[] = [
    ["negative-white", solidCamera(640, 480, 255)],
    ["negative-black", solidCamera(640, 480, 0)],
    ["negative-random", randomCamera(320, 240)],
    [
      "negative-invalid-fiducial",
      projectWithOpenCv(cv, eraseTopLeftFiducial(base.raster), { name: "invalid-fiducial" }),
    ],
    [
      "negative-mixed-phase",
      projectWithOpenCv(cv, mixedPhaseRaster(base.raster, next.raster), { name: "mixed-phase" }),
    ],
    [
      "negative-severe-crop",
      projectWithOpenCv(cv, base.raster, {
        name: "severe-crop",
        quad: [{ x: -90, y: 110 }, { x: 935, y: 80 }, { x: 1000, y: 875 }, { x: -65, y: 840 }],
      }),
    ],
  ];
  for (const [name, camera] of negativeCameras) {
    const outcome = evaluateCamera(cv, name, camera, base.inner);
    rows.push(outcome);
    assert.equal(outcome.status, "rejected", `${name} must never reach LT`);
  }

  context.diagnostic(`\n${diagnosticsTable(rows)}`);
});

function benchmarkInterpolation(
  cv: CorpusCv,
  base: ReturnType<typeof physicalRaster>,
  interpolation: VisionWarpInterpolation,
): InterpolationSummary {
  const scenarios: readonly CameraScenario[] = [
    {
      name: "subpixel-shift",
      quad: [
        { x: 285.35, y: 110.65 }, { x: 1015.45, y: 170.2 },
        { x: 975.7, y: 845.55 }, { x: 235.2, y: 790.4 },
      ],
    },
    {
      name: "subpixel-yuv420",
      quad: [
        { x: 285.25, y: 110.5 }, { x: 1015.75, y: 170.35 },
        { x: 975.4, y: 845.8 }, { x: 235.55, y: 790.15 },
      ],
      yuv420: true,
    },
    {
      name: "subpixel-blur-3",
      quad: [
        { x: 285.35, y: 110.4 }, { x: 1015.7, y: 170.2 },
        { x: 975.25, y: 845.55 }, { x: 235.65, y: 790.3 },
      ],
      blurKernel: 3,
    },
  ];
  const outcomes = scenarios.map((scenario) => evaluateCamera(
    cv,
    `${interpolation}:${scenario.name}`,
    projectWithOpenCv(cv, base.raster, scenario),
    base.inner,
    interpolation,
  ));
  const negative = evaluateCamera(
    cv,
    `${interpolation}:negative-white`,
    solidCamera(640, 480, 255),
    base.inner,
    interpolation,
  );
  assert.equal(negative.status, "rejected", `${interpolation} must have zero negative false positives`);
  return {
    interpolation,
    valid: outcomes.filter((outcome) => outcome.status === "valid").length,
    rejected: outcomes.filter((outcome) => outcome.status === "rejected").length,
    erasureBytes: outcomes.reduce((sum, outcome) => sum + (outcome.erasureBytes ?? 0), 0),
    fingerprint: [...outcomes, negative].map((outcome) =>
      [
        outcome.scenario,
        outcome.status,
        outcome.reason,
        outcome.erasureBytes ?? "-",
        outcome.fiducialErrorMax ?? "-",
        outcome.homographyMethod,
      ].join(":"),
    ),
  };
}

function interpolationOrder(
  left: InterpolationSummary,
  right: InterpolationSummary,
): number {
  if (left.valid !== right.valid) return right.valid - left.valid;
  if (left.erasureBytes !== right.erasureBytes) return left.erasureBytes - right.erasureBytes;
  const tieBreak: Readonly<Record<VisionWarpInterpolation, number>> = {
    linear: 0,
    nearest: 1,
    cubic: 2,
  };
  return tieBreak[left.interpolation] - tieBreak[right.interpolation];
}

test("canonical interpolation benchmark is deterministic and production follows its winner", {
  timeout: 30_000,
}, async (context: TestContext) => {
  installImageData();
  const cv = await loadOpenCv();
  const base = physicalRaster(17);
  const modes: readonly VisionWarpInterpolation[] = ["nearest", "linear", "cubic"];
  const first = modes.map((mode) => benchmarkInterpolation(cv, base, mode));
  const second = modes.map((mode) => benchmarkInterpolation(cv, base, mode));
  assert.deepEqual(second, first, "interpolation outcomes must be deterministic");
  const winner = [...first].sort(interpolationOrder)[0]!;
  assert.equal(winner.interpolation, "cubic", JSON.stringify(first));
  const artificialTie = first.map((result) => ({ ...result, valid: 1, erasureBytes: 0 }));
  assert.equal(
    artificialTie.sort(interpolationOrder)[0]!.interpolation,
    "linear",
    "an exact benchmark tie must preserve the simpler linear default",
  );
  const defaultCamera = projectWithOpenCv(cv, base.raster, { name: "production-default" });
  const production = normalizeColor4WithOpenCv(
    cv,
    defaultCamera.width,
    defaultCamera.height,
    defaultCamera.pixels,
  );
  assert.equal(
    production.diagnostics.config.warpInterpolation,
    winner.interpolation,
    "the production default must match the deterministic corpus winner",
  );
  context.diagnostic(
    `recommended/production=${winner.interpolation}; ${first.map((result) =>
      `${result.interpolation} valid=${result.valid} erasures=${result.erasureBytes}`
    ).join(", ")}`,
  );
});
