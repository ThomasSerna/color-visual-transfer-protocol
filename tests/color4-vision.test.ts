import assert from "node:assert/strict";
import test from "node:test";
import {
  FIDUCIALS,
  QUIET_MODULES,
  TOTAL_MODULES,
  fiducialModule,
  type FiducialId,
} from "../shared/color4/physical.ts";
import {
  analyzeFiducialModules,
  identifyFiducialModules,
  normalizeColor4WithOpenCv,
  projectiveQuadCenter,
  refinementImprovesHomography,
  selectVisionRejectReason,
  shouldRefineHomography,
  uniformlySampledContourIndices,
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

test("fiducial midpoint between two orientations is rejected as ambiguous", () => {
  const between = marker("TL");
  const rotated = new Uint8Array(81);
  for (let y = 0; y < 9; y++) {
    for (let x = 0; x < 9; x++) rotated[y * 9 + x] = between[(8 - x) * 9 + y]!;
  }
  const differences = [...between.keys()].filter((index) => between[index] !== rotated[index]);
  assert.equal(differences.length % 2, 0);
  for (const index of differences.slice(0, differences.length / 2)) between[index] = rotated[index]!;

  const analysis = analyzeFiducialModules(between);
  assert.equal(analysis.status, "ambiguous");
  assert.equal(analysis.best.id, analysis.second.id);
  assert.notEqual(analysis.best.rotation, analysis.second.rotation);
  assert.equal(analysis.best.errors, analysis.second.errors);
});

test("fiducial analysis exposes rotation and a distinct second hypothesis", () => {
  const source = marker("BR");
  const rotated = new Uint8Array(81);
  for (let y = 0; y < 9; y++) {
    for (let x = 0; x < 9; x++) rotated[y * 9 + x] = source[(8 - x) * 9 + y]!;
  }
  const analysis = analyzeFiducialModules(rotated);
  assert.equal(analysis.status, "valid");
  assert.equal(analysis.best.id, "BR");
  assert.notEqual(analysis.best.rotation, 0);
  assert.notDeepEqual(
    [analysis.second.id, analysis.second.rotation],
    [analysis.best.id, analysis.best.rotation],
  );
});

test("geometry rejection precedence is deterministic", () => {
  const classify = (
    overrides: Partial<Parameters<typeof selectVisionRejectReason>[0]>,
  ) => selectVisionRejectReason({
    quads: 5,
    uniqueIds: 0,
    duplicateIds: 0,
    lowContrast: 0,
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
  assert.equal(classify({ lowContrast: 1 }), "FIDUCIAL_LOW_CONTRAST");
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

test("homography refinement is bounded to one recoverable residual", () => {
  assert.equal(shouldRefineHomography(undefined), false);
  assert.equal(shouldRefineHomography(0.25), false);
  assert.equal(shouldRefineHomography(0.5), true);
  assert.equal(shouldRefineHomography(1.25), true);
  assert.equal(shouldRefineHomography(1.26), false);
  assert.equal(refinementImprovesHomography(1, 0.5), true);
  assert.equal(refinementImprovesHomography(1, 0.76), false);
  assert.equal(refinementImprovesHomography(0.4, 0.3), true);
  assert.equal(refinementImprovesHomography(0.4, 0.31), false);
});

test("contour over-budget sampling is uniform, bounded, and includes both endpoints", () => {
  assert.deepEqual(uniformlySampledContourIndices(4, 8), [0, 1, 2, 3]);
  const sampled = uniformlySampledContourIndices(50_001, 50_000);
  assert.equal(sampled.length, 50_000);
  assert.equal(sampled[0], 0);
  assert.equal(sampled.at(-1), 50_000);
  assert.ok(sampled.every((value, index) => index === 0 || value > sampled[index - 1]!));
});

interface FakeMatShape {
  rows: number;
  cols: number;
  data: Uint8Array;
  data32S: Int32Array;
  data32F?: Float32Array;
  values?: number[];
  projectedValues?: number[];
  residualPixels?: number;
  syntheticArea?: number;
  markerId?: FiducialId;
  passIndex?: number;
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

function fakeOpenCv(
  failCanonicalWarp = false,
  splitPasses = false,
  excessiveContours = false,
  refinement: "none" | "apply" | "reject" = "none",
  invalidCenterHomography = false,
  lowContrast = false,
  candidateFlood = false,
  treeSupported = true,
): OpenCvRuntime & {
  fakeStats: {
    homographyCalls: number;
    canonicalWarps: number;
    findContoursCalls: number;
    candidateWarps: number;
    contourModes: number[];
    liveMats: number;
    peakMats: number;
  };
} {
  const quads = [
    new Int32Array([10, 10, 19, 10, 19, 19, 10, 19]),
    new Int32Array([80, 10, 89, 10, 89, 19, 80, 19]),
    new Int32Array([80, 80, 89, 80, 89, 89, 80, 89]),
    new Int32Array([10, 80, 19, 80, 19, 89, 10, 89]),
  ];
  const ids: FiducialId[] = ["TL", "TR", "BR", "BL"];
  const refinementQuads = FIDUCIALS.map((marker) => {
    const left = (QUIET_MODULES + marker.x) * 6 + 3;
    const top = (QUIET_MODULES + marker.y) * 6;
    const right = (QUIET_MODULES + marker.x + marker.width) * 6 - 1 + 3;
    const bottom = (QUIET_MODULES + marker.y + marker.height) * 6 - 1;
    return new Int32Array([left, top, right, top, right, bottom, left, bottom]);
  });
  const fakeStats = {
    homographyCalls: 0,
    canonicalWarps: 0,
    findContoursCalls: 0,
    candidateWarps: 0,
    contourModes: [] as number[],
    liveMats: 0,
    peakMats: 0,
  };
  let refinementActive = false;

  class Mat implements FakeMatShape {
    rows = 0;
    cols = 0;
    data = new Uint8Array();
    data32S = new Int32Array();
    data32F?: Float32Array;
    values?: number[];
    projectedValues?: number[];
    residualPixels?: number;
    private deleted = false;
    constructor() {
      fakeStats.liveMats++;
      fakeStats.peakMats = Math.max(fakeStats.peakMats, fakeStats.liveMats);
    }
    markerId?: FiducialId;
    syntheticArea?: number;
    delete(): void {
      if (this.deleted) return;
      this.deleted = true;
      fakeStats.liveMats--;
    }
  }

  class MatVector {
    selected = quads.map((_, index) => index);
    reportedSize = quads.length;
    floodKind: "none" | "contours" | "candidates" = "none";
    size(): number {
      return this.reportedSize;
    }
    get(index: number): Mat {
      const contour = new Mat();
      contour.rows = 4;
      contour.cols = 1;
      if (this.floodKind === "contours") {
        const signalIndex = [0, 16_666, 33_333, 50_000].indexOf(index);
        contour.data32S = signalIndex >= 0
          ? quads[signalIndex]!
          : new Int32Array([0, 0, 1, 0, 1, 1, 0, 1]);
        contour.syntheticArea = signalIndex >= 0 ? 100 : 0;
      } else if (this.floodKind === "candidates" && index >= quads.length) {
        const side = [10, 25, 60, 150][index % 4]!;
        const left = 20 + index % 40 * 24;
        const top = 20 + Math.floor(index / 40) % 35 * 24;
        contour.data32S = new Int32Array([
          left, top,
          left + side, top,
          left + side, top + side,
          left, top + side,
        ]);
        contour.syntheticArea = side * side;
      } else {
        contour.data32S = (refinementActive ? refinementQuads : quads)[this.selected[index]!]!;
        contour.syntheticArea = 100;
      }
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

  let thresholdPass = 0;
  const runtime: OpenCvRuntime = {
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
      refinementActive = refinement !== "none" &&
        source.rows === TOTAL_MODULES * 6 && source.cols === TOTAL_MODULES * 6;
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
      (destination as FakeMatShape).passIndex = thresholdPass++;
    },
    threshold(source, destination) {
      destination.rows = source.rows;
      destination.cols = source.cols;
      destination.data = Uint8Array.from(source.data);
      (destination as FakeMatShape).passIndex = thresholdPass++;
    },
    findContours(image, contours, hierarchy, mode) {
      fakeStats.findContoursCalls++;
      const vector = contours as unknown as MatVector;
      fakeStats.contourModes.push(mode);
      if (excessiveContours && fakeStats.findContoursCalls === 1) {
        vector.reportedSize = 50_001;
        vector.floodKind = "contours";
      } else if (candidateFlood && !refinementActive) {
        vector.reportedSize = 700;
        vector.floodKind = "candidates";
      } else {
        vector.reportedSize = vector.selected.length;
        vector.floodKind = "none";
      }
      if (splitPasses) {
        const pass = (image as FakeMatShape).passIndex;
        vector.selected = pass === 0 ? [0, 1] : pass === 1 ? [2] : [3];
        vector.reportedSize = vector.selected.length;
      }
      hierarchy.rows = 1;
      hierarchy.cols = vector.reportedSize;
      hierarchy.data32S = new Int32Array(vector.reportedSize * 4).fill(-1);
      if (candidateFlood && treeSupported && vector.reportedSize > 7) {
        for (let index = 0; index < 4; index++) hierarchy.data32S[index * 4 + 3] = 4;
        hierarchy.data32S[4 * 4 + 3] = 5;
        hierarchy.data32S[5 * 4 + 3] = 6;
      }
    },
    contourArea(contour) {
      return (contour as FakeMatShape).syntheticArea ?? 100;
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
      transform.rows = 3;
      transform.cols = 3;
      const left = (source as FakeMatShape).values?.[0];
      const top = (source as FakeMatShape).values?.[1];
      const markerIndex = left === undefined || top === undefined
        ? -1
        : (refinementActive ? refinementQuads : quads).findIndex(
          (quad) => quad[0] === left && quad[1] === top,
        );
      if (markerIndex >= 0) transform.markerId = ids[markerIndex];
      else if (invalidCenterHomography) transform.data32F = new Float32Array(9).fill(Number.NaN);
      return transform;
    },
    warpPerspective(_source, destination, transform, size) {
      const dimensions = size as Size;
      if (dimensions.width !== 90) {
        fakeStats.canonicalWarps++;
        if (failCanonicalWarp) throw new Error("synthetic homography failure");
        destination.rows = dimensions.height;
        destination.cols = dimensions.width;
        destination.data = new Uint8Array(dimensions.width * dimensions.height * 4).fill(255);
        return;
      }
      destination.rows = 90;
      fakeStats.candidateWarps++;
      destination.cols = 90;
      destination.data = new Uint8Array(90 * 90).fill(255);
      const id = (transform as FakeMatShape).markerId;
      if (!id) {
        destination.data.fill(128);
        return;
      }
      for (let moduleY = 0; moduleY < 9; moduleY++) {
        for (let moduleX = 0; moduleX < 9; moduleX++) {
          const value = fiducialModule(id, moduleX, moduleY) === 1
            ? (lowContrast ? 100 : 0)
            : (lowContrast ? 120 : 255);
          for (let y = moduleY * 10; y < moduleY * 10 + 10; y++) {
            destination.data.fill(value, y * 90 + moduleX * 10, y * 90 + moduleX * 10 + 10);
          }
        }
      }
    },
  };
  if (treeSupported) runtime.RETR_TREE = 3;
  const instrumented = runtime as OpenCvRuntime & {
    fakeStats: {
      homographyCalls: number;
      canonicalWarps: number;
      findContoursCalls: number;
      candidateWarps: number;
      contourModes: number[];
      liveMats: number;
      peakMats: number;
    };
  };
  instrumented.fakeStats = fakeStats;
  if (refinement !== "none") {
    runtime.findHomography = (_source, destination) => {
      fakeStats.homographyCalls++;
      const transform = new Mat();
      transform.rows = 3;
      transform.cols = 3;
      transform.projectedValues = [...((destination as FakeMatShape).values ?? [])];
      transform.residualPixels = fakeStats.homographyCalls === 1
        ? 3
        : refinement === "apply"
          ? 0.6
          : 2.4;
      return transform;
    };
    runtime.perspectiveTransform = (_source, destination, transform) => {
      const fakeTransform = transform as FakeMatShape;
      const values = fakeTransform.projectedValues ?? [];
      destination.rows = values.length / 2;
      destination.cols = 1;
      destination.data32F = Float32Array.from(
        values,
        (value, index) => value + (index % 2 === 0 ? fakeTransform.residualPixels ?? 0 : 0),
      );
    };
  }
  return instrumented;
}

test("vision defaults to 1280 detection and canonical scale six", () => {
  installImageDataForNode();
  let tick = 0;
  const cv = fakeOpenCv();
  const result = normalizeColor4WithOpenCv(
    cv,
    1600,
    800,
    new Uint8ClampedArray(1600 * 800 * 4),
    { now: () => ++tick },
  );
  assert.equal(result.status, "valid");
  assert.equal(result.candidates, 4);
  assert.equal(result.diagnostics.config.maxDetectionDimension, 1280);
  assert.equal(result.diagnostics.config.detectionWidth, 1280);
  assert.equal(result.diagnostics.config.detectionHeight, 640);
  assert.equal(result.diagnostics.config.canonicalScale, 6);
  assert.equal(result.diagnostics.config.warpInterpolation, "cubic");
  assert.equal(result.diagnostics.config.maximumContoursPerPass, 50_000);
  assert.equal(result.diagnostics.config.maximumQuadProposals, 256);
  assert.equal(result.diagnostics.config.candidateBucketDivisions, 4);
  assert.equal(result.diagnostics.config.maximumCandidatesPerBucket, 8);
  assert.equal(result.diagnostics.config.contourRetrievalMode, "tree");
  assert.equal(result.diagnostics.config.minimumFiducialContrast, 30);
  assert.equal(result.diagnostics.config.maximumFiducialErrors, 4);
  assert.equal(result.diagnostics.counters.quads, 12);
  assert.equal(result.diagnostics.counters.candidateCountRaw, 12);
  assert.equal(result.diagnostics.counters.mergedCandidates, 4);
  assert.equal(result.diagnostics.counters.candidateCountRanked, 4);
  assert.deepEqual(result.diagnostics.warnings, []);
  assert.ok((result.diagnostics.optical?.minimumPixelsPerModule ?? 0) > 0);
  assert.equal(result.diagnostics.optical?.fiducialContrast, 255);
  assert.ok((result.diagnostics.optical?.blurMetric ?? 0) > 0);
  assert.equal(result.diagnostics.optical?.clippedPixelFraction, 1);
  assert.deepEqual(cv.fakeStats.contourModes, [3, 3, 3]);
  assert.equal(result.diagnostics.homography.method, "centers-4");
  assert.equal(result.debug, undefined);
  if (result.status === "valid") assert.equal(result.image.width, TOTAL_MODULES * 6);
  for (const duration of Object.values(result.diagnostics.timings)) assert.ok(duration >= 0);
});

test("multi-pass detection can assemble four fiducials found by different thresholds", () => {
  installImageDataForNode();
  const result = normalizeColor4WithOpenCv(
    fakeOpenCv(false, true),
    100,
    100,
    new Uint8ClampedArray(100 * 100 * 4),
    { maxDetectionDimension: "source" },
  );
  assert.equal(result.status, "valid");
  assert.equal(result.candidates, 4);
  assert.equal(result.diagnostics.counters.quads, 4);
  assert.equal(result.diagnostics.counters.mergedCandidates, 4);
  assert.equal(Object.keys(result.diagnostics.fiducials).length, 4);
});

test("vision samples an adversarial contour flood without rejecting the frame", () => {
  installImageDataForNode();
  const cv = fakeOpenCv(false, false, true);
  const result = normalizeColor4WithOpenCv(
    cv,
    1280,
    960,
    new Uint8ClampedArray(1280 * 960 * 4),
  );
  assert.equal(result.status, "valid");
  assert.equal(result.candidates, 4);
  assert.equal(result.diagnostics.counters.contoursTotal, 50_009);
  assert.equal(result.diagnostics.counters.candidateCountRaw, 12);
  assert.equal(result.diagnostics.counters.candidateCountRanked, 4);
  assert.equal(result.diagnostics.counters.decoded, 4);
  assert.deepEqual(result.diagnostics.warnings, ["CONTOUR_BUDGET_UNIFORMLY_SAMPLED"]);
  assert.equal(cv.fakeStats.candidateWarps, 4);
});

test("candidate floods are bucketed per threshold pass and only the top 256 are warped", () => {
  installImageDataForNode();
  const cv = fakeOpenCv(false, false, false, "none", false, false, true);
  const result = normalizeColor4WithOpenCv(
    cv,
    1000,
    1000,
    new Uint8ClampedArray(1000 * 1000 * 4),
    { maxDetectionDimension: "source", debug: true, debugView: "fiducials" },
  );
  assert.equal(result.status, "valid");
  assert.equal(result.diagnostics.counters.candidateCountRaw, 2_100);
  assert.ok(result.diagnostics.counters.mergedCandidates > 256);
  assert.equal(result.diagnostics.counters.candidateCountRanked, 256);
  assert.equal(result.candidates, 256);
  assert.ok(result.diagnostics.warnings.includes("CANDIDATE_BUDGET_RANKED"));
  assert.equal(cv.fakeStats.candidateWarps, 256);
  const decoded = result.debug?.traces.filter((trace) => trace.status === "DECODED") ?? [];
  assert.equal(decoded.length, 4);
  assert.ok(decoded.every((trace) => trace.candidateScore?.passSupport === 3));
});

test("camera-stage fiducials require 30 luma levels without relaxing Hamming four", () => {
  installImageDataForNode();
  const cv = fakeOpenCv(false, false, false, "none", false, true);
  const result = normalizeColor4WithOpenCv(
    cv,
    100,
    100,
    new Uint8ClampedArray(100 * 100 * 4),
    { maxDetectionDimension: "source" },
  );
  assert.equal(result.status, "rejected");
  if (result.status === "rejected") assert.equal(result.reason, "FIDUCIAL_LOW_CONTRAST");
  assert.equal(result.diagnostics.config.minimumFiducialContrast, 30);
  assert.equal(result.diagnostics.config.maximumFiducialErrors, 4);
  assert.equal(result.diagnostics.counters.lowContrast, 4);
  assert.equal(result.diagnostics.counters.decoded, 0);
});

test("optical diagnostics use projected outer edges and canonical active clipping", () => {
  installImageDataForNode();
  const result = normalizeColor4WithOpenCv(
    fakeOpenCv(),
    100,
    100,
    new Uint8ClampedArray(100 * 100 * 4),
    { maxDetectionDimension: "source" },
  );
  assert.equal(result.status, "valid");
  const optical = result.diagnostics.optical!;
  const expectedPixelsPerModule = 70 / 137;
  assert.ok(Math.abs(optical.apparentFrameWidthPx - expectedPixelsPerModule * 172) < 1e-8);
  assert.ok(Math.abs(optical.apparentFrameHeightPx - expectedPixelsPerModule * 172) < 1e-8);
  assert.ok(Math.abs(optical.pixelsPerModuleX - expectedPixelsPerModule) < 1e-10);
  assert.ok(Math.abs(optical.pixelsPerModuleY - expectedPixelsPerModule) < 1e-10);
  assert.ok(Math.abs(optical.minimumPixelsPerModule - expectedPixelsPerModule) < 1e-10);
  assert.equal(optical.fiducialWidthPx, 9);
  assert.equal(optical.fiducialHeightPx, 9);
  assert.equal(optical.fiducialContrast, 255);
  assert.ok(optical.blurMetric > 0);
  assert.equal(optical.clippedPixelFraction, 1);
});

test("contour retrieval falls back to RETR_LIST when RETR_TREE is unavailable", () => {
  installImageDataForNode();
  const cv = fakeOpenCv(false, false, false, "none", false, false, false, false);
  const result = normalizeColor4WithOpenCv(
    cv,
    100,
    100,
    new Uint8ClampedArray(100 * 100 * 4),
    { maxDetectionDimension: "source" },
  );
  assert.equal(result.status, "valid");
  assert.equal(result.diagnostics.config.contourRetrievalMode, "list");
  assert.deepEqual(cv.fakeStats.contourModes, [0, 0, 0]);
});

test("invalid fallback homographies reject and release every allocated Mat", () => {
  installImageDataForNode();
  const cv = fakeOpenCv(false, false, false, "none", true);
  const result = normalizeColor4WithOpenCv(
    cv,
    100,
    100,
    new Uint8ClampedArray(100 * 100 * 4),
  );
  assert.equal(result.status, "rejected");
  if (result.status === "rejected") assert.equal(result.reason, "HOMOGRAPHY_FAILED");
  assert.equal(cv.fakeStats.liveMats, 0);
});

for (const [mode, applied, expectedWarps] of [
  ["apply", true, 2],
  ["reject", false, 1],
] as const) {
  test(
    `bounded homography refinement ${mode === "apply" ? "applies" : "rejects"} ` +
      "one measured correction",
    () => {
      installImageDataForNode();
      const cv = fakeOpenCv(false, false, false, mode);
      const result = normalizeColor4WithOpenCv(
        cv,
        100,
        100,
        new Uint8ClampedArray(100 * 100 * 4),
      );
      assert.equal(result.status, "valid");
      assert.equal(result.diagnostics.homography.method, "corners-16");
      assert.equal(result.diagnostics.homography.refinementAttempted, true);
      assert.equal(
        result.diagnostics.homography.refinementApplied,
        applied,
        JSON.stringify({ homography: result.diagnostics.homography, stats: cv.fakeStats }),
      );
      assert.ok(
        Math.abs((result.diagnostics.homography.residualRmsModules ?? 0) - 0.5) < 1e-6,
      );
      assert.ok(
        Math.abs(
          (result.diagnostics.homography.refinementResidualBeforeRmsModules ?? 0) - 0.5,
        ) < 1e-6,
      );
      assert.ok(
        Math.abs(
          (result.diagnostics.homography.refinementResidualAfterRmsModules ?? 0) -
            (mode === "apply" ? 0.1 : 0.4),
        ) < 1e-5,
      );
      assert.equal(cv.fakeStats.homographyCalls, 2);
      assert.equal(cv.fakeStats.canonicalWarps, expectedWarps);
      assert.equal(cv.fakeStats.liveMats, 0);
      assert.ok(cv.fakeStats.peakMats > 0);
    },
  );
}

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
  assert.equal(result.diagnostics.counters.quads, 12);
  assert.equal(result.diagnostics.counters.mergedCandidates, 4);
  assert.equal(result.diagnostics.config.canonicalScale, 8);
  assert.equal(result.diagnostics.config.maxDetectionDimension, "source");
  assert.equal(result.debug?.traces.length, 4);
  assert.ok(result.debug?.traces.every((trace) => trace.thresholdPasses.length === 3));
  assert.ok(result.debug?.traces.every((trace) => trace.candidateScore?.passSupport === 3));
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
