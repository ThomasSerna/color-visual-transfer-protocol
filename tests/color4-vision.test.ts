import assert from "node:assert/strict";
import test from "node:test";
import { TOTAL_MODULES, fiducialModule, type FiducialId } from "../shared/color4/physical.ts";
import {
  analyzeFiducialModules,
  identifyFiducialModules,
  normalizeColor4WithOpenCv,
  projectiveQuadCenter,
  selectVisionRejectReason,
  type OpenCvRuntime,
} from "../receive/color4-vision.ts";
import { color4SequencePhaseMatches } from "../receive/color4-binding.ts";

function marker(id: "TL" | "TR" | "BR" | "BL"): Uint8Array {
  const modules = new Uint8Array(81);
  for (let y = 0; y < 9; y++) {
    for (let x = 0; x < 9; x++) modules[y * 9 + x] = fiducialModule(id, x, y);
  }
  return modules;
}

test("fiducial identification corrects at most four module errors", () => {
  const modules = marker("TL");
  for (const index of [20, 21, 22, 23]) modules[index] = modules[index]! ^ 1;
  assert.deepEqual(identifyFiducialModules(modules), { id: "TL", errors: 4 });
  modules[24] = modules[24]! ^ 1;
  assert.equal(identifyFiducialModules(modules), null);
});

test("fiducial midpoint between two IDs is rejected as ambiguous", () => {
  const between = marker("TL");
  const other = marker("TR");
  const differences = [...between.keys()].filter((index) => between[index] !== other[index]);
  assert.ok(differences.length >= 10);
  for (const index of differences.slice(0, Math.floor(differences.length / 2))) {
    between[index] = other[index]!;
  }
  assert.equal(identifyFiducialModules(between), null);
  const analysis = analyzeFiducialModules(between);
  assert.equal(analysis.status, "ambiguous");
  assert.equal(analysis.best.errors, analysis.second.errors);
});

test("fiducial analysis exposes rotation and the second-best distinct ID", () => {
  const source = marker("BR");
  const rotated = new Uint8Array(81);
  for (let y = 0; y < 9; y++) {
    for (let x = 0; x < 9; x++) rotated[y * 9 + x] = source[(8 - x) * 9 + y]!;
  }
  const analysis = analyzeFiducialModules(rotated);
  assert.equal(analysis.status, "valid");
  assert.equal(analysis.best.id, "BR");
  assert.notEqual(analysis.best.rotation, 0);
  assert.notEqual(analysis.second.id, analysis.best.id);
});

test("geometry rejection precedence is deterministic", () => {
  const classify = (
    overrides: Partial<Parameters<typeof selectVisionRejectReason>[0]>,
  ) => selectVisionRejectReason({
    quads: 5,
    uniqueIds: 0,
    duplicateIds: 0,
    ambiguous: 0,
    tooManyErrors: 0,
    ...overrides,
  });
  assert.equal(classify({ quads: 0, uniqueIds: 4 }), "NO_CONTOUR_CANDIDATES");
  assert.equal(classify({ uniqueIds: 4, duplicateIds: 2 }), undefined);
  assert.equal(classify({ uniqueIds: 2, duplicateIds: 1 }), "DUPLICATE_IDS");
  assert.equal(classify({ uniqueIds: 1, ambiguous: 3 }), "ONLY_1_FIDUCIAL");
  assert.equal(classify({ uniqueIds: 2 }), "ONLY_2_FIDUCIALS");
  assert.equal(classify({ uniqueIds: 3 }), "ONLY_3_FIDUCIALS");
  assert.equal(classify({ ambiguous: 1, tooManyErrors: 1 }), "FIDUCIAL_AMBIGUOUS");
  assert.equal(classify({ tooManyErrors: 1 }), "FIDUCIAL_TOO_MANY_ERRORS");
  assert.equal(classify({}), "QUADS_FOUND_NO_MARKERS");
});

test("fiducial center uses the perspective-invariant diagonal intersection", () => {
  const quad = [
    { x: 285, y: 110 },
    { x: 1015, y: 170 },
    { x: 975, y: 845 },
    { x: 235, y: 790 },
  ];
  const center = projectiveQuadCenter(quad);
  assert.ok(Math.abs(center.x - 629.20737189092) < 1e-9);
  assert.ok(Math.abs(center.y - 476.65567875337126) < 1e-9);
  const arithmeticX = quad.reduce((sum, point) => sum + point.x / 4, 0);
  const arithmeticY = quad.reduce((sum, point) => sum + point.y / 4, 0);
  assert.ok(Math.hypot(center.x - arithmeticX, center.y - arithmeticY) > 2);
});

interface FakeMatShape {
  rows: number;
  cols: number;
  data: Uint8Array;
  data32S: Int32Array;
  values?: number[];
  markerId?: FiducialId;
  delete(): void;
}

function installImageDataForNode(): void {
  if (typeof ImageData !== "undefined") return;
  class TestImageData {
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
    value: TestImageData,
  });
}

function fakeOpenCv(failCanonicalWarp = false): OpenCvRuntime {
  const quads = [10, 30, 50, 70].map((left) => new Int32Array([
    left, 10,
    left + 9, 10,
    left + 9, 19,
    left, 19,
  ]));
  const ids: FiducialId[] = ["TL", "TR", "BR", "BL"];

  class Mat implements FakeMatShape {
    rows = 0;
    cols = 0;
    data = new Uint8Array();
    data32S = new Int32Array();
    values?: number[];
    markerId?: FiducialId;
    delete(): void {}
  }

  class MatVector {
    size(): number {
      return quads.length;
    }
    get(index: number): Mat {
      const contour = new Mat();
      contour.rows = 4;
      contour.cols = 1;
      contour.data32S = quads[index]!;
      return contour;
    }
    delete(): void {}
  }

  class Size {
    constructor(readonly width: number, readonly height: number) {}
  }

  class Scalar {
    constructor(..._values: number[]) {}
  }

  return {
    Mat,
    MatVector,
    Size,
    Scalar,
    CV_32FC2: 0,
    COLOR_RGBA2GRAY: 0,
    INTER_AREA: 0,
    INTER_LINEAR: 0,
    ADAPTIVE_THRESH_GAUSSIAN_C: 0,
    THRESH_BINARY_INV: 0,
    THRESH_BINARY: 0,
    THRESH_OTSU: 0,
    RETR_LIST: 0,
    CHAIN_APPROX_SIMPLE: 0,
    BORDER_CONSTANT: 0,
    matFromImageData(image) {
      const mat = new Mat();
      mat.rows = image.height;
      mat.cols = image.width;
      mat.data = Uint8Array.from(image.data);
      return mat;
    },
    matFromArray(rows, cols, _type, values) {
      const mat = new Mat();
      mat.rows = rows;
      mat.cols = cols;
      mat.values = values;
      return mat;
    },
    cvtColor(source, destination) {
      destination.rows = source.rows;
      destination.cols = source.cols;
      destination.data = new Uint8Array(source.rows * source.cols).fill(255);
    },
    resize(_source, destination, size) {
      const dimensions = size as Size;
      destination.cols = dimensions.width;
      destination.rows = dimensions.height;
      destination.data = new Uint8Array(dimensions.width * dimensions.height).fill(255);
    },
    adaptiveThreshold(source, destination) {
      destination.rows = source.rows;
      destination.cols = source.cols;
      destination.data = new Uint8Array(source.rows * source.cols);
    },
    threshold(source, destination) {
      destination.rows = source.rows;
      destination.cols = source.cols;
      destination.data = Uint8Array.from(source.data);
    },
    findContours() {},
    contourArea() {
      return 100;
    },
    arcLength() {
      return 40;
    },
    approxPolyDP(curve, output) {
      output.rows = curve.rows;
      output.cols = curve.cols;
      output.data32S = Int32Array.from(curve.data32S);
    },
    isContourConvex() {
      return true;
    },
    getPerspectiveTransform(source) {
      const transform = new Mat();
      const left = (source as FakeMatShape).values?.[0];
      const markerIndex = left === undefined ? -1 : quads.findIndex((quad) => quad[0] === left);
      if (markerIndex >= 0) transform.markerId = ids[markerIndex];
      return transform;
    },
    warpPerspective(_source, destination, transform, size) {
      const dimensions = size as Size;
      if (dimensions.width !== 90) {
        if (failCanonicalWarp) throw new Error("synthetic homography failure");
        destination.rows = dimensions.height;
        destination.cols = dimensions.width;
        destination.data = new Uint8Array(dimensions.width * dimensions.height * 4).fill(255);
        return;
      }
      destination.rows = 90;
      destination.cols = 90;
      destination.data = new Uint8Array(90 * 90).fill(255);
      const id = (transform as FakeMatShape).markerId!;
      for (let moduleY = 0; moduleY < 9; moduleY++) {
        for (let moduleX = 0; moduleX < 9; moduleX++) {
          const value = fiducialModule(id, moduleX, moduleY) === 1 ? 0 : 255;
          for (let y = moduleY * 10; y < moduleY * 10 + 10; y++) {
            destination.data.fill(value, y * 90 + moduleX * 10, y * 90 + moduleX * 10 + 10);
          }
        }
      }
    },
  } as OpenCvRuntime;
}

test("vision defaults to 960 detection and canonical scale four", () => {
  installImageDataForNode();
  let tick = 0;
  const result = normalizeColor4WithOpenCv(
    fakeOpenCv(),
    1000,
    500,
    new Uint8ClampedArray(1000 * 500 * 4),
    { now: () => ++tick },
  );
  assert.equal(result.status, "valid");
  assert.equal(result.candidates, 4);
  assert.equal(result.diagnostics.config.maxDetectionDimension, 960);
  assert.equal(result.diagnostics.config.detectionWidth, 960);
  assert.equal(result.diagnostics.config.detectionHeight, 480);
  assert.equal(result.diagnostics.config.canonicalScale, 4);
  assert.equal(result.debug, undefined);
  if (result.status === "valid") assert.equal(result.image.width, TOTAL_MODULES * 4);
  for (const duration of Object.values(result.diagnostics.timings)) assert.ok(duration >= 0);
});

test("vision preserves candidates and bounded debug planes when homography fails", () => {
  installImageDataForNode();
  let tick = 0;
  const result = normalizeColor4WithOpenCv(
    fakeOpenCv(true),
    100,
    100,
    new Uint8ClampedArray(100 * 100 * 4),
    {
      canonicalScale: 8,
      maxDetectionDimension: "source",
      snapshot: true,
      now: () => ++tick,
    },
  );
  assert.equal(result.status, "rejected");
  if (result.status === "rejected") assert.equal(result.reason, "HOMOGRAPHY_FAILED");
  assert.equal(result.candidates, 4);
  assert.equal(result.diagnostics.counters.quads, 4);
  assert.equal(result.diagnostics.config.canonicalScale, 8);
  assert.equal(result.diagnostics.config.maxDetectionDimension, "source");
  assert.equal(result.debug?.traces.length, 4);
  assert.equal(result.debug?.planes.raw?.channels, 4);
  assert.equal(result.debug?.planes.threshold?.channels, 1);
  assert.equal(result.debug?.planes.warped, undefined);
  assert.equal(result.debug?.metadata.warpedAvailable, false);
  assert.ok(result.diagnostics.timings.homographyMs > 0);
});

test("the physical Gray phase is bound to sequence modulo four", () => {
  assert.equal(color4SequencePhaseMatches(0x1020_3042, 2), true);
  assert.equal(color4SequencePhaseMatches(0x1020_3042, 0), false);
  assert.equal(color4SequencePhaseMatches(-1, 3), false);
  assert.equal(color4SequencePhaseMatches(0x1_0000_0000, 0), false);
});
