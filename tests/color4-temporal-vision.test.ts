import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { PNG } from "pngjs";
import {
  decodeCanonicalColor4Raster,
  decodeCanonicalColor4Samples,
  unwrapColor4Frame,
} from "../shared/color4/index.ts";
import {
  Color4CompactSamplerWithOpenCv,
  acquireColor4TemporalGeometryWithOpenCv,
  createVisionGrayscaleFrameWithOpenCv,
  createVisionTemporalHint,
  normalizeColor4WithOpenCv,
  trackVisionTemporalHintWithOpenCv,
  validateVisionTemporalTracking,
  type VisionHomography,
  type OpenCvRuntime,
  type VisionQuad,
  type VisionTemporalTrackCandidate,
} from "../receive/color4-vision.ts";
import { installImageData, loadOpenCvRuntime } from "./helpers/opencv-runtime.ts";

const PHYSICAL_FIXTURE = new URL(
  "./fixtures/color4/physical/capture-000017/raw-frame.png",
  import.meta.url,
);

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[sorted.length >> 1]!;
}

function percentile(values: readonly number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const weight = position - lower;
  return sorted[lower]! * (1 - weight) + sorted[upper]! * weight;
}

function compactSamplerFakeCv(): OpenCvRuntime & { readonly liveMats: () => number } {
  const CV_32FC1 = 1;
  const CV_32FC2 = 2;
  let liveMats = 0;

  class Mat {
    rows: number;
    cols: number;
    data = new Uint8Array();
    data32S = new Int32Array();
    data32F?: Float32Array;
    private deleted = false;

    constructor(rows = 0, cols = 0, type?: unknown) {
      this.rows = rows;
      this.cols = cols;
      if (type === CV_32FC1) this.data32F = new Float32Array(rows * cols);
      if (type === CV_32FC2) this.data32F = new Float32Array(rows * cols * 2);
      liveMats++;
    }

    delete(): void {
      if (this.deleted) return;
      this.deleted = true;
      liveMats--;
    }
  }

  class MatVector {
    size(): number { return 0; }
    get(): Mat { return new Mat(); }
    delete(): void {}
  }

  class Size {
    constructor(readonly width: number, readonly height: number) {}
  }

  class Scalar extends Array<number> {
    constructor(...values: number[]) { super(...values); }
  }

  const runtime = {
    Mat,
    MatVector,
    Size,
    Scalar,
    CV_32FC1,
    CV_32FC2,
    CV_16SC2: 3,
    COLOR_RGBA2GRAY: 1,
    COLOR_RGBA2RGB: 2,
    INTER_AREA: 1,
    INTER_LINEAR: 2,
    INTER_CUBIC: 3,
    ADAPTIVE_THRESH_GAUSSIAN_C: 0,
    THRESH_BINARY_INV: 0,
    THRESH_BINARY: 0,
    THRESH_OTSU: 0,
    RETR_LIST: 0,
    CHAIN_APPROX_SIMPLE: 0,
    BORDER_CONSTANT: 0,
    matFromImageData(image: ImageData): Mat {
      const mat = new Mat(image.height, image.width);
      mat.data = Uint8Array.from(image.data);
      return mat;
    },
    matFromArray(rows: number, cols: number, _type: unknown, values: number[]): Mat {
      const mat = new Mat(rows, cols, CV_32FC1);
      mat.data32F!.set(values);
      return mat;
    },
    cvtColor(source: Mat, destination: Mat): void {
      destination.rows = source.rows;
      destination.cols = source.cols;
      destination.data = new Uint8Array(source.rows * source.cols * 3);
    },
    perspectiveTransform(source: Mat, destination: Mat): void {
      destination.rows = source.rows;
      destination.cols = source.cols;
      destination.data32F = Float32Array.from(source.data32F ?? []);
    },
    convertMaps(source: Mat, _map2: Mat, destination1: Mat, destination2: Mat): void {
      destination1.rows = source.rows;
      destination1.cols = source.cols;
      destination2.rows = source.rows;
      destination2.cols = source.cols;
    },
    remap(_source: Mat, destination: Mat, map1: Mat): void {
      destination.rows = map1.rows;
      destination.cols = map1.cols;
      destination.data = new Uint8Array(destination.rows * destination.cols * 3);
      for (let pixel = 0; pixel < destination.rows * destination.cols; pixel++) {
        destination.data[pixel * 3] = 10;
        destination.data[pixel * 3 + 1] = 20;
        destination.data[pixel * 3 + 2] = 30;
      }
    },
    liveMats: () => liveMats,
  };
  return runtime as unknown as OpenCvRuntime & { readonly liveMats: () => number };
}

function baseTemporalGeometry(): Readonly<{
  hint: ReturnType<typeof createVisionTemporalHint>;
  candidate: VisionTemporalTrackCandidate;
}> {
  const sourceWidth = 200;
  const sourceHeight = 200;
  const canonicalMaximum = 172 * 6 - 1;
  const sourceLeft = 20;
  const sourceTop = 20;
  const sourceSize = 159;
  const factor = canonicalMaximum / sourceSize;
  const homography: VisionHomography = [
    factor, 0, -sourceLeft * factor,
    0, factor, -sourceTop * factor,
    0, 0, 1,
  ];
  const corners = Array.from({ length: 16 }, (_, index) => ({
    x: 45 + (index % 4) * 35,
    y: 45 + Math.floor(index / 4) * 35,
  }));
  const hint = createVisionTemporalHint({
    sourceWidth,
    sourceHeight,
    canonicalScale: 6,
    corners,
    homography,
  });
  const translatedHomography: VisionHomography = [
    factor, 0, -(sourceLeft + 1) * factor,
    0, factor, -(sourceTop + 1) * factor,
    0, 0, 1,
  ];
  const frameQuad: VisionQuad = [
    { x: 21, y: 21 },
    { x: 180, y: 21 },
    { x: 180, y: 180 },
    { x: 21, y: 180 },
  ];
  return {
    hint,
    candidate: {
      sourceWidth,
      sourceHeight,
      corners: corners.map(({ x, y }) => ({ x: x + 1, y: y + 1 })),
      tracked: new Array<boolean>(16).fill(true),
      forwardBackwardErrorsPx: new Array<number>(16).fill(0.25),
      homography: translatedHomography,
      residualRmsModules: 0.2,
      residualMaxModules: 0.35,
      frameQuad,
    },
  };
}

function shiftGrayRight(
  frame: ReturnType<typeof createVisionGrayscaleFrameWithOpenCv>,
  pixels: number,
): ReturnType<typeof createVisionGrayscaleFrameWithOpenCv> {
  const shifted = new Uint8Array(frame.pixels.length).fill(255);
  for (let y = 0; y < frame.height; y++) {
    const copy = Math.max(0, frame.width - pixels);
    shifted.set(
      frame.pixels.subarray(y * frame.width, y * frame.width + copy),
      y * frame.width + Math.min(pixels, frame.width),
    );
  }
  return {
    sourceWidth: frame.sourceWidth,
    sourceHeight: frame.sourceHeight,
    width: frame.width,
    height: frame.height,
    pixels: shifted,
  };
}

function shiftRgbaRight(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  shift: number,
): Uint8ClampedArray {
  const shifted = new Uint8ClampedArray(pixels.length).fill(255);
  const copyBytes = Math.max(0, width - shift) * 4;
  for (let y = 0; y < height; y++) {
    shifted.set(
      pixels.subarray(y * width * 4, y * width * 4 + copyBytes),
      (y * width + Math.min(shift, width)) * 4,
    );
  }
  return shifted;
}

test("temporal geometry enforces every tracking safety gate", () => {
  const { hint, candidate } = baseTemporalGeometry();
  const accepted = validateVisionTemporalTracking(hint, candidate);
  assert.equal(accepted.status, "tracked");
  if (accepted.status === "tracked") {
    assert.equal(accepted.hint.generation, hint.generation + 1);
    assert.equal(accepted.diagnostics.trackedCorners, 16);
    assert.equal(accepted.diagnostics.forwardBackwardP95Px, 0.25);
    assert.ok(Math.abs((accepted.diagnostics.areaRatio ?? 0) - 1) < 1e-12);
  }

  const rejection = (overrides: Partial<VisionTemporalTrackCandidate>) =>
    validateVisionTemporalTracking(hint, { ...candidate, ...overrides });
  const tooFew = rejection({
    tracked: candidate.tracked.map((value, index) => index < 5 ? false : value),
  });
  assert.equal(tooFew.status, "rejected");
  if (tooFew.status === "rejected") assert.equal(tooFew.reason, "TOO_FEW_TRACKED_CORNERS");
  const forwardBackward = rejection({
    forwardBackwardErrorsPx: candidate.forwardBackwardErrorsPx.map((value, index) =>
      index === 15 ? 1.51 : value),
  });
  assert.equal(forwardBackward.status, "rejected");
  if (forwardBackward.status === "rejected") {
    assert.equal(forwardBackward.reason, "FORWARD_BACKWARD_ERROR");
  }
  const residual = rejection({ residualRmsModules: 0.500_001 });
  assert.equal(residual.status, "rejected");
  if (residual.status === "rejected") assert.equal(residual.reason, "HOMOGRAPHY_RESIDUAL");
  const nonConvex = rejection({
    frameQuad: [
      { x: 21, y: 21 },
      { x: 180, y: 180 },
      { x: 180, y: 21 },
      { x: 21, y: 180 },
    ],
  });
  assert.equal(nonConvex.status, "rejected");
  if (nonConvex.status === "rejected") assert.equal(nonConvex.reason, "FRAME_QUAD_NON_CONVEX");
  const outside = rejection({
    frameQuad: [
      { x: -0.01, y: 21 },
      { x: 180, y: 21 },
      { x: 180, y: 180 },
      { x: -0.01, y: 180 },
    ],
  });
  assert.equal(outside.status, "rejected");
  if (outside.status === "rejected") assert.equal(outside.reason, "FRAME_QUAD_OUT_OF_BOUNDS");
  const area = rejection({
    frameQuad: [
      { x: 45, y: 45 },
      { x: 145, y: 45 },
      { x: 145, y: 145 },
      { x: 45, y: 145 },
    ],
  });
  assert.equal(area.status, "rejected");
  if (area.status === "rejected") assert.equal(area.reason, "FRAME_AREA_CHANGED");
});

test("compact sampler reuses its maps and releases every OpenCV Mat", () => {
  installImageData();
  const cv = compactSamplerFakeCv();
  const { hint } = baseTemporalGeometry();
  const sampler = new Color4CompactSamplerWithOpenCv(cv);
  const pixels = new Uint8ClampedArray(hint.sourceWidth * hint.sourceHeight * 4);
  const first = sampler.sample(hint.sourceWidth, hint.sourceHeight, pixels, hint);
  assert.deepEqual(Array.from(first.rgb.slice(0, 6)), [10, 20, 30, 10, 20, 30]);
  assert.equal(sampler.diagnostics?.mapReused, false);
  assert.equal(
    cv.liveMats(),
    8,
    "only three projection maps, two fixed maps, and three sampling Mats may remain",
  );
  sampler.sample(hint.sourceWidth, hint.sourceHeight, pixels, hint);
  assert.equal(sampler.diagnostics?.mapReused, true);
  assert.equal(cv.liveMats(), 8, "a repeated sample must reuse every retained Mat");
  const resizedHint = createVisionTemporalHint({
    sourceWidth: hint.sourceWidth + 1,
    sourceHeight: hint.sourceHeight,
    canonicalScale: hint.canonicalScale,
    corners: hint.corners,
    homography: hint.homography,
  });
  sampler.sample(
    resizedHint.sourceWidth,
    resizedHint.sourceHeight,
    new Uint8ClampedArray(resizedHint.sourceWidth * resizedHint.sourceHeight * 4),
    resizedHint,
  );
  assert.equal(cv.liveMats(), 8, "a resolution change must replace, not accumulate, sampling Mats");
  sampler.dispose();
  sampler.dispose();
  assert.equal(cv.liveMats(), 0);
});

test("compact sampler has a complete float-map fallback without native projection", () => {
  installImageData();
  const cv = compactSamplerFakeCv();
  delete cv.perspectiveTransform;
  delete cv.convertMaps;
  delete cv.CV_16SC2;
  const { hint } = baseTemporalGeometry();
  const sampler = new Color4CompactSamplerWithOpenCv(cv);
  const pixels = new Uint8ClampedArray(hint.sourceWidth * hint.sourceHeight * 4);
  const first = sampler.sample(hint.sourceWidth, hint.sourceHeight, pixels, hint);
  assert.deepEqual(Array.from(first.rgb.slice(0, 3)), [10, 20, 30]);
  assert.equal(sampler.diagnostics?.mapFormat, "float");
  assert.equal(sampler.diagnostics?.mapReused, false);
  assert.equal(
    cv.liveMats(),
    5,
    "only the reusable X/Y maps and three sampling Mats may remain",
  );
  sampler.sample(hint.sourceWidth, hint.sourceHeight, pixels, hint);
  assert.equal(sampler.diagnostics?.mapReused, true);
  assert.equal(cv.liveMats(), 5, "the fallback must reuse every retained Mat");
  sampler.dispose();
  assert.equal(cv.liveMats(), 0);
});

test("compact sampler calculates the exact even median for every RGB channel", () => {
  installImageData();
  const cv = compactSamplerFakeCv();
  cv.remap = (_source, destination, map1): void => {
    destination.rows = map1.rows;
    destination.cols = map1.cols;
    destination.data = new Uint8Array(destination.rows * destination.cols * 4);
    for (let y = 0; y < destination.rows; y++) {
      for (let x = 0; x < destination.cols; x++) {
        const sample = (y & 3) * 4 + (x & 3);
        const offset = (y * destination.cols + x) * 4;
        destination.data[offset] = sample;
        destination.data[offset + 1] = 15 - sample;
        destination.data[offset + 2] = sample < 8 ? 1 : 201;
        destination.data[offset + 3] = 255;
      }
    }
  };
  const { hint } = baseTemporalGeometry();
  const sampler = new Color4CompactSamplerWithOpenCv(cv);
  const samples = sampler.sample(
    hint.sourceWidth,
    hint.sourceHeight,
    new Uint8ClampedArray(hint.sourceWidth * hint.sourceHeight * 4),
    hint,
  );
  assert.deepEqual(Array.from(samples.rgb.slice(0, 6)), [7.5, 7.5, 101, 7.5, 7.5, 101]);
  sampler.dispose();
  assert.equal(cv.liveMats(), 0);
});

test("physical acquisition seeds LK and compact samples preserve the decoded frame", {
  timeout: 120_000,
}, async () => {
  const cv = await loadOpenCvRuntime();
  const png = PNG.sync.read(await readFile(PHYSICAL_FIXTURE));
  const pixels = Uint8ClampedArray.from(png.data);
  const acquisitionStarted = performance.now();
  const temporalAcquired = acquireColor4TemporalGeometryWithOpenCv(
    cv,
    png.width,
    png.height,
    Uint8ClampedArray.from(pixels),
    { canonicalScale: 6, maxDetectionDimension: 1280 },
  );
  const acquisitionMs = performance.now() - acquisitionStarted;
  assert.equal(temporalAcquired.status, "valid");
  if (temporalAcquired.status !== "valid") return;
  const acquired = normalizeColor4WithOpenCv(
    cv,
    png.width,
    png.height,
    Uint8ClampedArray.from(pixels),
    { canonicalScale: 6, maxDetectionDimension: 1280 },
  );
  assert.equal(acquired.status, "valid");
  if (acquired.status !== "valid") return;
  const hint = temporalAcquired.temporalHint;
  assert.equal(hint.corners.length, 16);
  assert.equal(JSON.parse(JSON.stringify(hint)).version, 1);

  const gray = createVisionGrayscaleFrameWithOpenCv(cv, png.width, png.height, pixels);
  const tracked = trackVisionTemporalHintWithOpenCv(cv, gray, gray, hint);
  assert.equal(tracked.status, "tracked", tracked.status === "rejected" ? tracked.reason : "");
  if (tracked.status === "tracked") {
    assert.equal(tracked.diagnostics.trackedCorners, 16);
    assert.ok((tracked.diagnostics.forwardBackwardP95Px ?? Infinity) <= 1.5);
    assert.ok((tracked.diagnostics.residualRmsModules ?? Infinity) <= 0.5);
  }
  const changedSourceResolution = trackVisionTemporalHintWithOpenCv(
    cv,
    gray,
    { ...gray, sourceWidth: gray.sourceWidth * 2, sourceHeight: gray.sourceHeight * 2 },
    hint,
  );
  assert.equal(changedSourceResolution.status, "rejected");
  if (changedSourceResolution.status === "rejected") {
    assert.equal(changedSourceResolution.reason, "FRAME_SIZE_CHANGED");
  }
  const shiftedPixels = shiftRgbaRight(pixels, png.width, png.height, 2);
  const shiftedGray = createVisionGrayscaleFrameWithOpenCv(
    cv,
    png.width,
    png.height,
    shiftedPixels,
  );
  const gradual = trackVisionTemporalHintWithOpenCv(cv, gray, shiftedGray, hint);
  assert.equal(gradual.status, "tracked", gradual.status === "rejected" ? gradual.reason : "");
  if (gradual.status === "tracked") {
    const meanShiftX = gradual.hint.corners.reduce(
      (sum, point, index) => sum + (point.x - hint.corners[index]!.x) / 16,
      0,
    );
    assert.ok(meanShiftX > 1.5 && meanShiftX < 2.5);
  }
  const jump = trackVisionTemporalHintWithOpenCv(cv, gray, shiftGrayRight(gray, 150), hint);
  assert.equal(jump.status, "rejected");

  const rasterDecoded = decodeCanonicalColor4Raster(acquired.image);
  assert.equal(rasterDecoded.status, "valid");
  const sampler = new Color4CompactSamplerWithOpenCv(cv);
  try {
    const samples = sampler.sample(
      png.width,
      png.height,
      Uint8ClampedArray.from(pixels),
      hint,
    );
    const compactDecoded = decodeCanonicalColor4Samples(samples);
    assert.equal(compactDecoded.status, "valid");
    if (rasterDecoded.status === "valid" && compactDecoded.status === "valid") {
      assert.equal(compactDecoded.profile.id, rasterDecoded.profile.id);
      assert.equal(compactDecoded.paletteId, rasterDecoded.paletteId);
      assert.equal(compactDecoded.sequencePhase, rasterDecoded.sequencePhase);
      const unwrap = (classified: typeof compactDecoded) => unwrapColor4Frame(
        classified.codedBytes,
        {
          profileId: classified.profile.id,
          paletteId: classified.paletteId,
          erasures: classified.byteErasures,
        },
      );
      const compactFrame = unwrap(compactDecoded);
      const rasterFrame = unwrap(rasterDecoded);
      assert.equal(compactFrame.status, "valid");
      assert.equal(rasterFrame.status, "valid");
      if (compactFrame.status === "valid" && rasterFrame.status === "valid") {
        assert.deepEqual(compactFrame.innerFrame, rasterFrame.innerFrame);
      }
    }
    assert.equal(sampler.diagnostics?.remapWidth, 688);
    assert.equal(sampler.diagnostics?.mapReused, false);
    sampler.sample(png.width, png.height, Uint8ClampedArray.from(pixels), hint);
    assert.equal(sampler.diagnostics?.mapReused, true);
    if (gradual.status === "tracked" && rasterDecoded.status === "valid") {
      const moved = decodeCanonicalColor4Samples(sampler.sample(
        png.width,
        png.height,
        shiftedPixels,
        gradual.hint,
      ));
      assert.equal(sampler.diagnostics?.mapReused, false);
      assert.equal(moved.status, "valid");
      if (moved.status === "valid") {
        const movedFrame = unwrapColor4Frame(moved.codedBytes, {
          profileId: moved.profile.id,
          paletteId: moved.paletteId,
          erasures: moved.byteErasures,
        });
        const referenceFrame = unwrapColor4Frame(rasterDecoded.codedBytes, {
          profileId: rasterDecoded.profile.id,
          paletteId: rasterDecoded.paletteId,
          erasures: rasterDecoded.byteErasures,
        });
        assert.equal(movedFrame.status, "valid");
        assert.equal(referenceFrame.status, "valid");
        if (movedFrame.status === "valid" && referenceFrame.status === "valid") {
          assert.deepEqual(movedFrame.innerFrame, referenceFrame.innerFrame);
        }
      }
      sampler.sample(png.width, png.height, shiftedPixels, gradual.hint);
      assert.equal(sampler.diagnostics?.mapReused, true);
    }

    let benchmarkPreviousGray = gray;
    let benchmarkHint = hint;
    let benchmarkShifted = true;
    const geometryRun = (): Readonly<{
      samples: typeof samples;
      geometryMs: number;
      grayscaleMs: number;
      trackingMs: number;
      samplingMs: number;
      mapMs: number;
      sourceMs: number;
      remapMs: number;
      medianMs: number;
      mapReused: boolean;
    }> => {
      const started = performance.now();
      const currentPixels = benchmarkShifted ? shiftedPixels : pixels;
      const grayscaleStarted = performance.now();
      const current = createVisionGrayscaleFrameWithOpenCv(
        cv,
        png.width,
        png.height,
        currentPixels,
      );
      const grayscaleMs = performance.now() - grayscaleStarted;
      const trackingStarted = performance.now();
      const movement = trackVisionTemporalHintWithOpenCv(
        cv,
        benchmarkPreviousGray,
        current,
        benchmarkHint,
      );
      const trackingMs = performance.now() - trackingStarted;
      assert.equal(
        movement.status,
        "tracked",
        movement.status === "rejected" ? movement.reason : "",
      );
      if (movement.status !== "tracked") {
        return {
          samples,
          geometryMs: Number.POSITIVE_INFINITY,
          grayscaleMs,
          trackingMs,
          samplingMs: 0,
          mapMs: 0,
          sourceMs: 0,
          remapMs: 0,
          medianMs: 0,
          mapReused: false,
        };
      }
      const samplingStarted = performance.now();
      const fastSamples = sampler.sample(
        png.width,
        png.height,
        currentPixels,
        movement.hint,
      );
      const samplingMs = performance.now() - samplingStarted;
      const sampling = sampler.diagnostics;
      benchmarkPreviousGray = current;
      benchmarkHint = movement.hint;
      benchmarkShifted = !benchmarkShifted;
      return {
        samples: fastSamples,
        geometryMs: performance.now() - started,
        grayscaleMs,
        trackingMs,
        samplingMs,
        mapMs: sampling?.mapMs ?? 0,
        sourceMs: sampling?.sourceMs ?? 0,
        remapMs: sampling?.remapMs ?? 0,
        medianMs: sampling?.medianMs ?? 0,
        mapReused: sampling?.mapReused ?? false,
      };
    };
    for (let warmup = 0; warmup < 2; warmup++) geometryRun();
    const geometryRuns = Array.from({ length: 7 }, geometryRun);
    assert.ok(
      geometryRuns.every((run) => !run.mapReused),
      "every measured moving frame must rebuild its remap values",
    );
    const benchmarkSamples = geometryRuns.at(-1)!.samples;
    const classifierRun = (): number => {
      const started = performance.now();
      const classified = decodeCanonicalColor4Samples(benchmarkSamples);
      assert.equal(classified.status, "valid");
      return performance.now() - started;
    };
    for (let warmup = 0; warmup < 2; warmup++) classifierRun();
    const classifierRuns = Array.from({ length: 7 }, classifierRun);
    const rasterClassifierRun = (): number => {
      const started = performance.now();
      const classified = decodeCanonicalColor4Raster(acquired.image);
      assert.equal(classified.status, "valid");
      return performance.now() - started;
    };
    for (let warmup = 0; warmup < 2; warmup++) rasterClassifierRun();
    const rasterClassifierRuns = Array.from({ length: 7 }, rasterClassifierRun);
    const geometryP50 = median(geometryRuns.map((run) => run.geometryMs));
    const geometryP95 = percentile(geometryRuns.map((run) => run.geometryMs), 0.95);
    const classifierP50 = median(classifierRuns);
    const classifierP95 = percentile(classifierRuns, 0.95);
    const rasterClassifierP50 = median(rasterClassifierRuns);
    console.log(`TEMPORAL_VISION_BENCH ${JSON.stringify({
      acquisitionMs,
      geometryP50,
      geometryP95,
      classifierP50,
      classifierP95,
      rasterClassifierP50,
      classifierVsRasterRatio: classifierP50 / rasterClassifierP50,
      ratio: geometryP50 / acquisitionMs,
      estimatedCapacityFps: Math.min(1_000 / geometryP95, 2_000 / classifierP95),
      stagesP50: {
        grayscaleMs: median(geometryRuns.map((run) => run.grayscaleMs)),
        trackingMs: median(geometryRuns.map((run) => run.trackingMs)),
        samplingMs: median(geometryRuns.map((run) => run.samplingMs)),
        mapMs: median(geometryRuns.map((run) => run.mapMs)),
        sourceMs: median(geometryRuns.map((run) => run.sourceMs)),
        remapMs: median(geometryRuns.map((run) => run.remapMs)),
        medianMs: median(geometryRuns.map((run) => run.medianMs)),
      },
      stagesP95: {
        grayscaleMs: percentile(geometryRuns.map((run) => run.grayscaleMs), 0.95),
        trackingMs: percentile(geometryRuns.map((run) => run.trackingMs), 0.95),
        samplingMs: percentile(geometryRuns.map((run) => run.samplingMs), 0.95),
        mapMs: percentile(geometryRuns.map((run) => run.mapMs), 0.95),
        sourceMs: percentile(geometryRuns.map((run) => run.sourceMs), 0.95),
        remapMs: percentile(geometryRuns.map((run) => run.remapMs), 0.95),
        medianMs: percentile(geometryRuns.map((run) => run.medianMs), 0.95),
      },
    })}`);
    assert.ok(
      geometryP50 <= acquisitionMs * 0.6,
      `tracked geometry p50 ${geometryP50} ms is not <=60% of acquisition ${acquisitionMs} ms`,
    );
    assert.ok(
      geometryP95 / geometryP50 <= 1.5,
      `tracked geometry p95/p50 ${geometryP95 / geometryP50} exceeds 1.5`,
    );
    // The classifier's independent 2-warmup/7-run test owns its ratio and
    // variability gates. Keep these values in the end-to-end vision breakdown
    // without duplicating a load-sensitive assertion in the OpenCV benchmark.
  } finally {
    sampler.dispose();
  }
  assert.throws(
    () => sampler.sample(png.width, png.height, pixels, hint),
    /disposed/,
  );
});
