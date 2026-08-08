import {
  FIDUCIALS,
  QUIET_MODULES,
  TOTAL_MODULES,
  fiducialModule,
  type FiducialId,
} from "../shared/color4/physical";
import type {
  VisionCandidateStatus,
  VisionCandidateTrace,
  VisionCanonicalScale,
  VisionContourCounters,
  VisionDebugArtifacts,
  VisionDebugView,
  VisionDetectionLimit,
  VisionDiagnostics,
  VisionEffectiveConfig,
  VisionFiducialMatch,
  VisionOptions,
  VisionPlane,
  VisionPlaneId,
  VisionPoint,
  VisionQuad,
  VisionRejectReason,
  VisionResult,
  VisionStageTimings,
} from "./color4-vision-types";

export type {
  VisionCandidateStatus,
  VisionCandidateTrace,
  VisionCanonicalScale,
  VisionContourCounters,
  VisionDebugArtifacts,
  VisionDebugMetadata,
  VisionDebugView,
  VisionDetectionLimit,
  VisionDiagnostics,
  VisionEffectiveConfig,
  VisionFiducialMatch,
  VisionOptions,
  VisionPlane,
  VisionPlaneId,
  VisionPoint,
  VisionQuad,
  VisionRejectReason,
  VisionResult,
  VisionStageTimings,
} from "./color4-vision-types";

interface CvMat {
  rows: number;
  cols: number;
  data: Uint8Array;
  data32S: Int32Array;
  delete(): void;
}

interface CvMatVector {
  size(): number;
  get(index: number): CvMat;
  delete(): void;
}

export interface OpenCvRuntime {
  Mat: new () => CvMat;
  MatVector: new () => CvMatVector;
  Size: new (width: number, height: number) => unknown;
  Scalar: new (...values: number[]) => unknown;
  CV_32FC2: unknown;
  COLOR_RGBA2GRAY: number;
  INTER_AREA: number;
  INTER_LINEAR: number;
  ADAPTIVE_THRESH_GAUSSIAN_C: number;
  THRESH_BINARY_INV: number;
  THRESH_BINARY: number;
  THRESH_OTSU: number;
  RETR_LIST: number;
  CHAIN_APPROX_SIMPLE: number;
  BORDER_CONSTANT: number;
  matFromImageData(image: ImageData): CvMat;
  matFromArray(rows: number, cols: number, type: unknown, values: number[]): CvMat;
  cvtColor(source: CvMat, destination: CvMat, code: number): void;
  resize(source: CvMat, destination: CvMat, size: unknown, fx?: number, fy?: number, interpolation?: number): void;
  adaptiveThreshold(
    source: CvMat,
    destination: CvMat,
    maximum: number,
    adaptiveMethod: number,
    thresholdType: number,
    blockSize: number,
    constant: number,
  ): void;
  threshold(source: CvMat, destination: CvMat, threshold: number, maximum: number, type: number): void;
  findContours(
    image: CvMat,
    contours: CvMatVector,
    hierarchy: CvMat,
    mode: number,
    method: number,
  ): void;
  contourArea(contour: CvMat): number;
  arcLength(curve: CvMat, closed: boolean): number;
  approxPolyDP(curve: CvMat, output: CvMat, epsilon: number, closed: boolean): void;
  isContourConvex(contour: CvMat): boolean;
  getPerspectiveTransform(source: CvMat, destination: CvMat): CvMat;
  warpPerspective(
    source: CvMat,
    destination: CvMat,
    transform: CvMat,
    size: unknown,
    flags?: number,
    borderMode?: number,
    borderValue?: unknown,
  ): void;
}

type Point = VisionPoint;

interface MarkerCandidate {
  id: FiducialId;
  center: Point;
  errors: number;
  rotation: 0 | 1 | 2 | 3;
  traceIndex?: number;
}

interface MutableTimings {
  grayscaleMs: number;
  resizeMs: number;
  thresholdMs: number;
  contoursMs: number;
  fiducialDecodeMs: number;
  homographyMs: number;
  totalMs: number;
}

interface MutableCounters {
  contoursTotal: number;
  areaTooSmall: number;
  areaTooLarge: number;
  nonQuad: number;
  nonConvex: number;
  quads: number;
  decoded: number;
  duplicateIds: number;
  ambiguous: number;
  tooManyErrors: number;
  decodeFailures: number;
}

interface FiducialAnalysis {
  status: "valid" | "ambiguous" | "too-many-errors";
  best: VisionFiducialMatch;
  second: VisionFiducialMatch;
}

interface DetectionResult {
  markers: Map<FiducialId, MarkerCandidate>;
  candidates: number;
  reason?: Exclude<VisionRejectReason, "HOMOGRAPHY_FAILED">;
  detectionWidth: number;
  detectionHeight: number;
  detectionScale: number;
  traces: VisionCandidateTrace[];
  tracesTruncated: boolean;
  thresholdPlane?: VisionPlane;
}

const MARKER_SAMPLE = 90;
const DEFAULT_CANONICAL_SCALE: VisionCanonicalScale = 4;
const DEFAULT_DETECTION_LIMIT: VisionDetectionLimit = 960;
const TRACE_LIMIT = 64;
const MINIMUM_AREA_FRACTION = 0.00008;
const MAXIMUM_AREA_FRACTION = 0.08;
const POLYGON_EPSILON_FRACTION = 0.045;
const ADAPTIVE_BLOCK_SIZE = 31;
const ADAPTIVE_CONSTANT = 7;
const MAXIMUM_FIDUCIAL_ERRORS = 4;

function deleteMat(value: CvMat | undefined): void {
  value?.delete();
}

function orderQuad(points: Point[]): VisionQuad {
  const center = points.reduce(
    (sum, point) => ({ x: sum.x + point.x / points.length, y: sum.y + point.y / points.length }),
    { x: 0, y: 0 },
  );
  const ordered = [...points].sort(
    (left, right) =>
      Math.atan2(left.y - center.y, left.x - center.x) -
      Math.atan2(right.y - center.y, right.x - center.x),
  );
  const topLeft = ordered.reduce(
    (best, point, index) =>
      point.x + point.y < ordered[best]!.x + ordered[best]!.y ? index : best,
    0,
  );
  const result = [...ordered.slice(topLeft), ...ordered.slice(0, topLeft)];
  if (result.length !== 4) throw new RangeError("A quadrilateral must contain four points.");
  return [result[0]!, result[1]!, result[2]!, result[3]!];
}

function pointsFromContour(contour: CvMat): VisionQuad {
  const points: Point[] = [];
  for (let row = 0; row < contour.rows; row++) {
    points.push({ x: contour.data32S[row * 2]!, y: contour.data32S[row * 2 + 1]! });
  }
  return orderQuad(points);
}

/** Perspective preserves diagonal intersections, but not vertex averages. */
export function projectiveQuadCenter(quad: readonly Point[]): Point {
  const topLeft = quad[0]!;
  const topRight = quad[1]!;
  const bottomRight = quad[2]!;
  const bottomLeft = quad[3]!;
  const diagonalA = {
    x: bottomRight.x - topLeft.x,
    y: bottomRight.y - topLeft.y,
  };
  const diagonalB = {
    x: bottomLeft.x - topRight.x,
    y: bottomLeft.y - topRight.y,
  };
  const denominator = diagonalA.x * diagonalB.y - diagonalA.y * diagonalB.x;
  if (Math.abs(denominator) < 1e-6) {
    return quad.reduce(
      (sum, point) => ({ x: sum.x + point.x / 4, y: sum.y + point.y / 4 }),
      { x: 0, y: 0 },
    );
  }
  const offset = {
    x: topRight.x - topLeft.x,
    y: topRight.y - topLeft.y,
  };
  const position = (offset.x * diagonalB.y - offset.y * diagonalB.x) / denominator;
  return {
    x: topLeft.x + position * diagonalA.x,
    y: topLeft.y + position * diagonalA.y,
  };
}

function sampleMarker(warped: CvMat): Uint8Array {
  const modules = new Uint8Array(81);
  for (let moduleY = 0; moduleY < 9; moduleY++) {
    for (let moduleX = 0; moduleX < 9; moduleX++) {
      let dark = 0;
      let count = 0;
      const startX = moduleX * 10 + 3;
      const startY = moduleY * 10 + 3;
      for (let y = startY; y < startY + 4; y++) {
        for (let x = startX; x < startX + 4; x++) {
          if (warped.data[y * warped.cols + x]! < 128) dark++;
          count++;
        }
      }
      modules[moduleY * 9 + moduleX] = dark * 2 >= count ? 1 : 0;
    }
  }
  return modules;
}

function rotatedModule(modules: Uint8Array, x: number, y: number, rotation: number): number {
  if (rotation === 0) return modules[y * 9 + x]!;
  if (rotation === 1) return modules[(8 - x) * 9 + y]!;
  if (rotation === 2) return modules[(8 - y) * 9 + (8 - x)]!;
  return modules[x * 9 + (8 - y)]!;
}

export function identifyFiducialModules(
  modules: Uint8Array,
): { id: FiducialId; errors: number } | null {
  const analysis = analyzeFiducialModules(modules);
  return analysis.status === "valid"
    ? { id: analysis.best.id, errors: analysis.best.errors }
    : null;
}

/** Returns the two best distinct marker IDs for bounded debug instrumentation. */
export function analyzeFiducialModules(modules: Uint8Array): FiducialAnalysis {
  if (modules.length !== 81) throw new RangeError("A fiducial sample must contain 81 modules.");
  const ranked: VisionFiducialMatch[] = [];
  for (const marker of FIDUCIALS) {
    let bestForId: VisionFiducialMatch | undefined;
    for (let rotation = 0; rotation < 4; rotation++) {
      let errors = 0;
      for (let y = 0; y < 9; y++) {
        for (let x = 0; x < 9; x++) {
          if (rotatedModule(modules, x, y, rotation) !== fiducialModule(marker.id, x, y)) {
            errors++;
          }
        }
      }
      if (bestForId === undefined || errors < bestForId.errors) {
        bestForId = {
          id: marker.id,
          errors,
          rotation: rotation as 0 | 1 | 2 | 3,
        };
      }
    }
    ranked.push(bestForId!);
  }
  ranked.sort((left, right) => left.errors - right.errors || left.id.localeCompare(right.id));
  const best = ranked[0]!;
  const second = ranked[1]!;
  // dmin=10 across the frozen marker family: floor((dmin-1)/2)=4.
  if (best.errors === second.errors) return { status: "ambiguous", best, second };
  if (best.errors > MAXIMUM_FIDUCIAL_ERRORS) return { status: "too-many-errors", best, second };
  return { status: "valid", best, second };
}

function decodeCandidate(
  cv: OpenCvRuntime,
  gray: CvMat,
  quad: VisionQuad,
): FiducialAnalysis | null {
  let source: CvMat | undefined;
  let destination: CvMat | undefined;
  let transform: CvMat | undefined;
  let warped: CvMat | undefined;
  let binary: CvMat | undefined;
  try {
    source = cv.matFromArray(4, 1, cv.CV_32FC2, quad.flatMap((point) => [point.x, point.y]));
    destination = cv.matFromArray(4, 1, cv.CV_32FC2, [
      0, 0,
      MARKER_SAMPLE - 1, 0,
      MARKER_SAMPLE - 1, MARKER_SAMPLE - 1,
      0, MARKER_SAMPLE - 1,
    ]);
    transform = cv.getPerspectiveTransform(source, destination);
    warped = new cv.Mat();
    cv.warpPerspective(
      gray,
      warped,
      transform,
      new cv.Size(MARKER_SAMPLE, MARKER_SAMPLE),
      cv.INTER_LINEAR,
      cv.BORDER_CONSTANT,
      new cv.Scalar(255),
    );
    binary = new cv.Mat();
    cv.threshold(warped, binary, 0, 255, cv.THRESH_BINARY | cv.THRESH_OTSU);
    return analyzeFiducialModules(sampleMarker(binary));
  } catch {
    return null;
  } finally {
    deleteMat(binary);
    deleteMat(warped);
    deleteMat(transform);
    deleteMat(destination);
    deleteMat(source);
  }
}

function elapsed(now: () => number, started: number): number {
  return Math.max(0, now() - started);
}

function planeFromMat(mat: CvMat, channels: 1 | 4): VisionPlane {
  return {
    width: mat.cols,
    height: mat.rows,
    channels,
    pixels: Uint8ClampedArray.from(mat.data),
  };
}

function sourceQuad(quad: VisionQuad, scale: number): VisionQuad {
  return quad.map((point) => ({ x: point.x / scale, y: point.y / scale })) as unknown as VisionQuad;
}

function shouldCapturePlane(
  options: VisionOptions,
  plane: VisionPlaneId,
): boolean {
  if (options.snapshot) return plane === "raw" || plane === "threshold" || plane === "warped";
  if (!options.debug) return false;
  const view: VisionDebugView | undefined = options.debugView;
  if (view === plane) return true;
  if ((view === "contours" || view === "fiducials") && plane === "threshold") return true;
  return view === "calibration" && plane === "warped";
}

export interface VisionFiducialSummary {
  readonly quads: number;
  readonly uniqueIds: number;
  readonly duplicateIds: number;
  readonly ambiguous: number;
  readonly tooManyErrors: number;
}

/** Applies the normative, deterministic geometry-rejection precedence. */
export function selectVisionRejectReason(
  summary: VisionFiducialSummary,
): Exclude<VisionRejectReason, "HOMOGRAPHY_FAILED"> | undefined {
  if (summary.quads === 0) return "NO_CONTOUR_CANDIDATES";
  if (summary.uniqueIds >= 4) return undefined;
  if (summary.duplicateIds > 0) return "DUPLICATE_IDS";
  if (summary.uniqueIds === 1) return "ONLY_1_FIDUCIAL";
  if (summary.uniqueIds === 2) return "ONLY_2_FIDUCIALS";
  if (summary.uniqueIds === 3) return "ONLY_3_FIDUCIALS";
  if (summary.ambiguous > 0) return "FIDUCIAL_AMBIGUOUS";
  if (summary.tooManyErrors > 0) return "FIDUCIAL_TOO_MANY_ERRORS";
  return "QUADS_FOUND_NO_MARKERS";
}

function tracePriority(status: VisionCandidateStatus): number {
  if (status === "DECODED") return 3;
  if (status === "DUPLICATE_ID") return 2;
  if (status === "FIDUCIAL_DECODE_FAILED") return 0;
  return 1;
}

function retainCandidateTrace(
  traces: VisionCandidateTrace[],
  trace: VisionCandidateTrace,
): number | undefined {
  if (traces.length < TRACE_LIMIT) {
    traces.push(trace);
    return traces.length - 1;
  }
  const incomingPriority = tracePriority(trace.status);
  let replacement = -1;
  let lowestPriority = incomingPriority;
  for (let index = traces.length - 1; index >= 0; index--) {
    const priority = tracePriority(traces[index]!.status);
    if (priority < lowestPriority) {
      lowestPriority = priority;
      replacement = index;
    }
  }
  if (replacement < 0) return undefined;
  traces[replacement] = trace;
  return replacement;
}

function findMarkers(
  cv: OpenCvRuntime,
  gray: CvMat,
  maxDetectionDimension: VisionDetectionLimit,
  collectDebug: boolean,
  captureThreshold: boolean,
  timings: MutableTimings,
  counters: MutableCounters,
  now: () => number,
): DetectionResult {
  let detection = gray;
  let resized: CvMat | undefined;
  let binary: CvMat | undefined;
  let contours: CvMatVector | undefined;
  let hierarchy: CvMat | undefined;
  const limit = maxDetectionDimension === "source" ? Number.POSITIVE_INFINITY : maxDetectionDimension;
  const scale = Math.min(1, limit / Math.max(gray.cols, gray.rows));
  const traces: VisionCandidateTrace[] = [];
  let tracesTruncated = false;
  try {
    if (scale < 1) {
      const started = now();
      resized = new cv.Mat();
      cv.resize(
        gray,
        resized,
        new cv.Size(Math.round(gray.cols * scale), Math.round(gray.rows * scale)),
        0,
        0,
        cv.INTER_AREA,
      );
      detection = resized;
      timings.resizeMs += elapsed(now, started);
    }
    let started = now();
    binary = new cv.Mat();
    cv.adaptiveThreshold(
      detection,
      binary,
      255,
      cv.ADAPTIVE_THRESH_GAUSSIAN_C,
      cv.THRESH_BINARY_INV,
      ADAPTIVE_BLOCK_SIZE,
      ADAPTIVE_CONSTANT,
    );
    timings.thresholdMs += elapsed(now, started);
    contours = new cv.MatVector();
    hierarchy = new cv.Mat();
    started = now();
    cv.findContours(binary, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);
    const contourStarted = started;
    counters.contoursTotal = contours.size();
    const imageArea = detection.rows * detection.cols;
    const markers = new Map<FiducialId, MarkerCandidate>();
    for (let index = 0; index < contours.size(); index++) {
      const contour = contours.get(index);
      let approximation: CvMat | undefined;
      try {
        const area = Math.abs(cv.contourArea(contour));
        if (area < imageArea * MINIMUM_AREA_FRACTION) {
          counters.areaTooSmall++;
          continue;
        }
        if (area > imageArea * MAXIMUM_AREA_FRACTION) {
          counters.areaTooLarge++;
          continue;
        }
        const perimeter = cv.arcLength(contour, true);
        approximation = new cv.Mat();
        cv.approxPolyDP(contour, approximation, perimeter * POLYGON_EPSILON_FRACTION, true);
        if (approximation.rows !== 4) {
          counters.nonQuad++;
          continue;
        }
        if (!cv.isContourConvex(approximation)) {
          counters.nonConvex++;
          continue;
        }
        counters.quads++;
        const detectionQuad = pointsFromContour(approximation);
        const quad = sourceQuad(detectionQuad, scale);
        const center = projectiveQuadCenter(quad);
        const decodeStarted = now();
        const identity = decodeCandidate(cv, detection, detectionQuad);
        timings.fiducialDecodeMs += elapsed(now, decodeStarted);

        let status: VisionCandidateStatus = "FIDUCIAL_DECODE_FAILED";
        if (identity === null) {
          counters.decodeFailures++;
        } else if (identity.status === "ambiguous") {
          counters.ambiguous++;
          status = "FIDUCIAL_AMBIGUOUS";
        } else if (identity.status === "too-many-errors") {
          counters.tooManyErrors++;
          status = "FIDUCIAL_TOO_MANY_ERRORS";
        } else {
          counters.decoded++;
          status = "DECODED";
          const existing = markers.get(identity.best.id);
          if (existing) {
            counters.duplicateIds++;
            status = "DUPLICATE_ID";
            if (identity.best.errors < existing.errors) {
              if (existing.traceIndex !== undefined && traces[existing.traceIndex]) {
                traces[existing.traceIndex] = {
                  ...traces[existing.traceIndex]!,
                  status: "DUPLICATE_ID",
                };
              }
              status = "DECODED";
            }
          }
        }
        let traceIndex: number | undefined;
        if (collectDebug) {
          if (traces.length >= TRACE_LIMIT) tracesTruncated = true;
          traceIndex = retainCandidateTrace(traces, {
            contourIndex: index,
            area,
            quad,
            center,
            detectionQuad,
            status,
            ...(identity === null ? {} : { best: identity.best, second: identity.second }),
          });
        }
        if (identity?.status === "valid" && status === "DECODED") {
          markers.set(identity.best.id, {
            ...identity.best,
            center,
            ...(traceIndex === undefined ? {} : { traceIndex }),
          });
        }
      } finally {
        deleteMat(approximation);
        contour.delete();
      }
    }
    timings.contoursMs += Math.max(0, elapsed(now, contourStarted) - timings.fiducialDecodeMs);
    const reason = selectVisionRejectReason({
      quads: counters.quads,
      uniqueIds: markers.size,
      duplicateIds: counters.duplicateIds,
      ambiguous: counters.ambiguous,
      tooManyErrors: counters.tooManyErrors,
    });
    return {
      markers,
      candidates: counters.quads,
      ...(reason === undefined ? {} : { reason }),
      detectionWidth: detection.cols,
      detectionHeight: detection.rows,
      detectionScale: scale,
      traces,
      tracesTruncated,
      ...(captureThreshold ? { thresholdPlane: planeFromMat(binary, 1) } : {}),
    };
  } finally {
    hierarchy?.delete();
    contours?.delete();
    binary?.delete();
    resized?.delete();
  }
}

function emptyTimings(): MutableTimings {
  return {
    grayscaleMs: 0,
    resizeMs: 0,
    thresholdMs: 0,
    contoursMs: 0,
    fiducialDecodeMs: 0,
    homographyMs: 0,
    totalMs: 0,
  };
}

function emptyCounters(): MutableCounters {
  return {
    contoursTotal: 0,
    areaTooSmall: 0,
    areaTooLarge: 0,
    nonQuad: 0,
    nonConvex: 0,
    quads: 0,
    decoded: 0,
    duplicateIds: 0,
    ambiguous: 0,
    tooManyErrors: 0,
    decodeFailures: 0,
  };
}

function effectiveConfig(
  width: number,
  height: number,
  canonicalScale: VisionCanonicalScale,
  maxDetectionDimension: VisionDetectionLimit,
  found: DetectionResult,
): VisionEffectiveConfig {
  return {
    canonicalScale,
    maxDetectionDimension,
    sourceWidth: width,
    sourceHeight: height,
    detectionWidth: found.detectionWidth,
    detectionHeight: found.detectionHeight,
    detectionScale: found.detectionScale,
    adaptiveBlockSize: ADAPTIVE_BLOCK_SIZE,
    adaptiveConstant: ADAPTIVE_CONSTANT,
    minimumAreaFraction: MINIMUM_AREA_FRACTION,
    maximumAreaFraction: MAXIMUM_AREA_FRACTION,
    polygonEpsilonFraction: POLYGON_EPSILON_FRACTION,
    maximumFiducialErrors: MAXIMUM_FIDUCIAL_ERRORS,
  };
}

function diagnosticsFor(
  config: VisionEffectiveConfig,
  timings: MutableTimings,
  counters: MutableCounters,
  markers: ReadonlyMap<FiducialId, MarkerCandidate>,
): VisionDiagnostics {
  const fiducials: Partial<Record<FiducialId, VisionFiducialMatch>> = {};
  for (const [id, marker] of markers) {
    fiducials[id] = { id, errors: marker.errors, rotation: marker.rotation };
  }
  return {
    config,
    timings: { ...timings } satisfies VisionStageTimings,
    counters: { ...counters } satisfies VisionContourCounters,
    fiducials,
  };
}

function debugArtifacts(
  enabled: boolean,
  config: VisionEffectiveConfig,
  found: DetectionResult,
  planes: Partial<Record<VisionPlaneId, VisionPlane>>,
  warpedAvailable: boolean,
): VisionDebugArtifacts | undefined {
  if (!enabled) return undefined;
  return {
    metadata: {
      sourceWidth: config.sourceWidth,
      sourceHeight: config.sourceHeight,
      detectionWidth: config.detectionWidth,
      detectionHeight: config.detectionHeight,
      detectionScale: config.detectionScale,
      canonicalScale: config.canonicalScale,
      warpedAvailable,
      traceLimit: TRACE_LIMIT,
      tracesTruncated: found.tracesTruncated,
    },
    traces: found.traces,
    planes,
  };
}

export function normalizeColor4WithOpenCv(
  cv: OpenCvRuntime,
  width: number,
  height: number,
  pixels: Uint8ClampedArray,
  options: VisionOptions = {},
): VisionResult {
  const canonicalScale = options.canonicalScale ?? DEFAULT_CANONICAL_SCALE;
  const maxDetectionDimension = options.maxDetectionDimension ?? DEFAULT_DETECTION_LIMIT;
  const collectDebug = options.debug === true || options.snapshot === true;
  const now = options.now ?? (() => performance.now());
  const totalStarted = now();
  const timings = emptyTimings();
  const counters = emptyCounters();
  const planes: Partial<Record<VisionPlaneId, VisionPlane>> = {};
  let source: CvMat | undefined;
  let gray: CvMat | undefined;
  let sourcePoints: CvMat | undefined;
  let destinationPoints: CvMat | undefined;
  let transform: CvMat | undefined;
  let warped: CvMat | undefined;
  let homographyStarted: number | undefined;
  let activeStage: "grayscale" | "detection" | "homography" = "grayscale";
  let found: DetectionResult = {
    markers: new Map(),
    candidates: 0,
    reason: "NO_CONTOUR_CANDIDATES",
    detectionWidth: width,
    detectionHeight: height,
    detectionScale: 1,
    traces: [],
    tracesTruncated: false,
  };
  const finish = (warpedAvailable: boolean): {
    diagnostics: VisionDiagnostics;
    debug?: VisionDebugArtifacts;
  } => {
    timings.totalMs = elapsed(now, totalStarted);
    const config = effectiveConfig(
      width,
      height,
      canonicalScale,
      maxDetectionDimension,
      found,
    );
    const diagnostics = diagnosticsFor(config, timings, counters, found.markers);
    const debug = debugArtifacts(collectDebug, config, found, planes, warpedAvailable);
    return { diagnostics, ...(debug === undefined ? {} : { debug }) };
  };
  try {
    const grayscaleStarted = now();
    const imagePixels: Uint8ClampedArray<ArrayBuffer> = pixels.buffer instanceof ArrayBuffer
      ? new Uint8ClampedArray(pixels.buffer, pixels.byteOffset, pixels.byteLength)
      : Uint8ClampedArray.from(pixels);
    if (shouldCapturePlane(options, "raw")) {
      planes.raw = { width, height, channels: 4, pixels: Uint8ClampedArray.from(pixels) };
    }
    source = cv.matFromImageData(new ImageData(imagePixels, width, height));
    gray = new cv.Mat();
    cv.cvtColor(source, gray, cv.COLOR_RGBA2GRAY);
    timings.grayscaleMs = elapsed(now, grayscaleStarted);
    if (shouldCapturePlane(options, "grayscale")) planes.grayscale = planeFromMat(gray, 1);
    activeStage = "detection";
    found = findMarkers(
      cv,
      gray,
      maxDetectionDimension,
      collectDebug,
      shouldCapturePlane(options, "threshold"),
      timings,
      counters,
      now,
    );
    if (found.thresholdPlane) planes.threshold = found.thresholdPlane;
    const orderedIds: FiducialId[] = ["TL", "TR", "BR", "BL"];
    if (found.reason !== undefined || orderedIds.some((id) => !found.markers.has(id))) {
      return {
        status: "rejected",
        reason: found.reason ?? "QUADS_FOUND_NO_MARKERS",
        candidates: found.candidates,
        ...finish(false),
      };
    }
    activeStage = "homography";
    homographyStarted = now();
    const sourceValues = orderedIds.flatMap((id) => {
      const point = found.markers.get(id)!.center;
      return [point.x, point.y];
    });
    const destinationValues = orderedIds.flatMap((id) => {
      const marker = FIDUCIALS.find((candidate) => candidate.id === id)!;
      return [
        // OpenCV's point coordinates address pixel centres. The geometric
        // midpoint of an even-sized raster spans two pixel centres, so it is
        // half a pixel before the continuous module boundary coordinate.
        // Keeping that convention here prevents a systematic half-pixel
        // shift that otherwise mixes adjacent 4 px COLOR_4 cells.
        (QUIET_MODULES + marker.x + marker.width / 2) * canonicalScale - 0.5,
        (QUIET_MODULES + marker.y + marker.height / 2) * canonicalScale - 0.5,
      ];
    });
    sourcePoints = cv.matFromArray(4, 1, cv.CV_32FC2, sourceValues);
    destinationPoints = cv.matFromArray(4, 1, cv.CV_32FC2, destinationValues);
    transform = cv.getPerspectiveTransform(sourcePoints, destinationPoints);
    warped = new cv.Mat();
    const canonicalSize = TOTAL_MODULES * canonicalScale;
    cv.warpPerspective(
      source,
      warped,
      transform,
      new cv.Size(canonicalSize, canonicalSize),
      cv.INTER_LINEAR,
      cv.BORDER_CONSTANT,
      new cv.Scalar(255, 255, 255, 255),
    );
    timings.homographyMs = elapsed(now, homographyStarted);
    if (shouldCapturePlane(options, "warped")) planes.warped = planeFromMat(warped, 4);
    const canonicalPixels = Uint8ClampedArray.from(warped.data);
    return {
      status: "valid",
      candidates: found.candidates,
      image: {
        width: canonicalSize,
        height: canonicalSize,
        pixels: canonicalPixels,
      },
      ...finish(true),
    };
  } catch {
    if (homographyStarted !== undefined && timings.homographyMs === 0) {
      timings.homographyMs = elapsed(now, homographyStarted);
    }
    const detectionReason = selectVisionRejectReason({
      quads: counters.quads,
      uniqueIds: found.markers.size,
      duplicateIds: counters.duplicateIds,
      ambiguous: counters.ambiguous,
      tooManyErrors: counters.tooManyErrors,
    }) ?? "QUADS_FOUND_NO_MARKERS";
    const reason: VisionRejectReason = activeStage === "homography"
      ? "HOMOGRAPHY_FAILED"
      : detectionReason;
    if (activeStage !== "homography" && counters.quads !== found.candidates) {
      found = { ...found, candidates: counters.quads, reason: detectionReason };
    }
    return {
      status: "rejected",
      reason,
      candidates: found.candidates,
      ...finish(false),
    };
  } finally {
    warped?.delete();
    transform?.delete();
    destinationPoints?.delete();
    sourcePoints?.delete();
    gray?.delete();
    source?.delete();
  }
}
