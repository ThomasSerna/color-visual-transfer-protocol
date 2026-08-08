import assert from "node:assert/strict";
import test from "node:test";
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
} from "../receive/color4-vision.ts";

interface Point {
  readonly x: number;
  readonly y: number;
}

type Quad = readonly [Point, Point, Point, Point];
type Raster = ReturnType<typeof rasterizeColor4>;

interface CorpusCv extends OpenCvRuntime {
  readonly BORDER_DEFAULT: number;
  GaussianBlur(...values: unknown[]): void;
}

interface CameraScenario {
  readonly name: string;
  readonly width?: 960 | 1280 | 1920;
  readonly height?: 720 | 960 | 1440;
  readonly turns?: 0 | 1 | 2 | 3;
  readonly quad?: Quad;
  readonly blur?: boolean;
  readonly exposure?: number;
  readonly noise?: number;
  readonly yuv420?: boolean;
  readonly glare?: boolean;
  readonly requireValid?: boolean;
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

function clampByte(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
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
          const pixel = ((y + dy) * width + x + dx) * 4;
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
          const sample = dy * 2 + dx;
          const yy = clampByte(luminance[sample]!);
          const pixel = ((y + dy) * width + x + dx) * 4;
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

function degrade(
  source: Uint8ClampedArray,
  width: number,
  height: number,
  scenario: CameraScenario,
): Uint8ClampedArray {
  const output = Uint8ClampedArray.from(source);
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
  if (scenario.glare) {
    const left = Math.floor(width * 0.49);
    const right = Math.ceil(width * 0.51);
    const top = Math.floor(height * 0.47);
    const bottom = Math.ceil(height * 0.5);
    for (let y = top; y < bottom; y++) {
      for (let x = left; x < right; x++) {
        const offset = (y * width + x) * 4;
        output[offset] = 255;
        output[offset + 1] = 255;
        output[offset + 2] = 255;
      }
    }
  }
  return scenario.yuv420 ? yuv420RoundTrip(output, width, height) : output;
}

function projectWithOpenCv(
  cv: CorpusCv,
  frame: Raster,
  scenario: CameraScenario,
): { width: number; height: number; pixels: Uint8ClampedArray } {
  const width = scenario.width ?? 1280;
  const height = scenario.height ?? 960;
  const quad = scenario.quad ?? scaledDefaultQuad(width, height);
  const turns = scenario.turns ?? 0;
  const rotatedDestination = [0, 1, 2, 3].map((index) => quad[(index + turns) % 4]!);
  const source = cv.matFromImageData(
    new ImageData(Uint8ClampedArray.from(frame.pixels), frame.width, frame.height),
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
    if (scenario.blur) {
      blurred = new cv.Mat();
      cv.GaussianBlur(
        projected,
        blurred,
        new cv.Size(3, 3),
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

function exactOrRejected(
  cv: CorpusCv,
  camera: { width: number; height: number; pixels: Uint8ClampedArray },
  expected: Uint8Array,
): "valid" | "rejected" {
  const normalized = normalizeColor4WithOpenCv(
    cv,
    camera.width,
    camera.height,
    camera.pixels,
    { canonicalScale: 4, maxDetectionDimension: 960 },
  );
  if (normalized.status === "rejected") return "rejected";
  const raster = decodeCanonicalColor4Raster(normalized.image);
  if (raster.status === "rejected") return "rejected";
  const unwrapped = unwrapColor4Frame(raster.codedBytes, {
    profileId: raster.profile.id,
    paletteId: raster.paletteId,
    erasures: raster.byteErasures,
  });
  if (unwrapped.status === "rejected") return "rejected";
  assert.deepEqual(unwrapped.innerFrame, expected, "a confident OpenCV result must be byte exact");
  return "valid";
}

test("real OpenCV corpus is byte-exact or rejected across physical degradations", {
  timeout: 60_000,
}, async () => {
  installImageData();
  const cv = await loadOpenCv();
  const base = physicalRaster(0);
  const scenarios: readonly CameraScenario[] = [
    { name: "rotation-0", turns: 0, requireValid: true },
    { name: "rotation-90", turns: 1, requireValid: true },
    { name: "rotation-180", turns: 2, requireValid: true },
    { name: "rotation-270", turns: 3, requireValid: true },
    { name: "capture-960", width: 960, height: 720 },
    { name: "capture-1920", width: 1920, height: 1440 },
    {
      name: "perspective-plus-15",
      quad: [{ x: 320, y: 95 }, { x: 1035, y: 195 }, { x: 930, y: 850 }, { x: 250, y: 760 }],
    },
    {
      name: "perspective-minus-15",
      quad: [{ x: 250, y: 190 }, { x: 990, y: 100 }, { x: 1040, y: 770 }, { x: 310, y: 850 }],
    },
    {
      name: "smaller-apparent-frame",
      quad: [{ x: 410, y: 230 }, { x: 890, y: 245 }, { x: 875, y: 730 }, { x: 395, y: 710 }],
    },
    {
      name: "blur-noise-exposure-yuv420-glare",
      blur: true,
      exposure: 0.82,
      noise: 3,
      yuv420: true,
      glare: true,
    },
  ];
  const outcomes = new Map<string, "valid" | "rejected">();
  for (const scenario of scenarios) {
    const outcome = exactOrRejected(cv, projectWithOpenCv(cv, base.raster, scenario), base.inner);
    outcomes.set(scenario.name, outcome);
    if (scenario.requireValid) assert.equal(outcome, "valid", scenario.name);
  }
  assert.ok([...outcomes.values()].includes("valid"));

  const next = physicalRaster(1);
  const transitionPixels = Uint8ClampedArray.from(base.raster.pixels);
  const rowBytes = base.raster.width * 4;
  const split = Math.floor(base.raster.height / 2);
  transitionPixels.set(next.raster.pixels.subarray(split * rowBytes), split * rowBytes);
  const transition: Raster = { ...base.raster, pixels: transitionPixels };
  const transitionOutcome = exactOrRejected(
    cv,
    projectWithOpenCv(cv, transition, { name: "transition" }),
    base.inner,
  );
  assert.equal(transitionOutcome, "rejected", "a mixed phase frame must never reach LT");
});
