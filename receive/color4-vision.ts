import {
  ACTIVE_MODULES,
  COLOR4_MAX_FIDUCIAL_ERRORS,
  FIDUCIALS,
  QUIET_MODULES,
  TOTAL_MODULES,
  fiducialModule,
  type FiducialId,
} from "../shared/color4/physical";
import {
  DEFAULT_COLOR4_CANONICAL_SCALE,
  DEFAULT_COLOR4_DETECTION_DIMENSION,
} from "../shared/receiver-defaults";
import type {
  VisionCandidateScore,
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
  VisionHomographyMethod,
  VisionOpticalMetrics,
  VisionOptions,
  VisionPlane,
  VisionPlaneId,
  VisionPoint,
  VisionQuad,
  VisionRejectReason,
  VisionResult,
  VisionStageTimings,
  VisionThresholdPass,
  VisionWarning,
  VisionWarpInterpolation,
} from "./color4-vision-types";

export type {
  VisionCandidateStatus,
  VisionCandidateScore,
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
  VisionHomographyMethod,
  VisionOpticalMetrics,
  VisionOptions,
  VisionPlane,
  VisionPlaneId,
  VisionPoint,
  VisionQuad,
  VisionRejectReason,
  VisionResult,
  VisionStageTimings,
  VisionThresholdPass,
  VisionWarning,
  VisionWarpInterpolation,
} from "./color4-vision-types";

interface CvMat {
  rows: number;
  cols: number;
  data: Uint8Array;
  data32S: Int32Array;
  data32F?: Float32Array;
  data64F?: Float64Array;
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
  INTER_NEAREST?: number;
  INTER_CUBIC?: number;
  ADAPTIVE_THRESH_GAUSSIAN_C: number;
  THRESH_BINARY_INV: number;
  THRESH_BINARY: number;
  THRESH_OTSU: number;
  RETR_LIST: number;
  RETR_TREE?: number;
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
  findHomography?(
    source: CvMat,
    destination: CvMat,
    method?: number,
    ransacReprojectionThreshold?: number,
  ): CvMat;
  perspectiveTransform?(source: CvMat, destination: CvMat, transform: CvMat): void;
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
  quad: VisionQuad;
  detectionQuad: VisionQuad;
  errors: number;
  rotation: 0 | 1 | 2 | 3;
  score: VisionCandidateScore;
  contrast: number;
  blurMetric: number;
  traceIndex?: number;
}

interface QuadProposal {
  readonly contourIndex: number;
  readonly area: number;
  readonly detectionQuad: VisionQuad;
  readonly thresholdPass: VisionThresholdPass;
  readonly squareness: number;
  readonly borderContrast: number;
  readonly nestingDepth: number;
  readonly prewarpScore: number;
}

interface MergedQuadProposal extends QuadProposal {
  readonly thresholdPasses: readonly VisionThresholdPass[];
  readonly normalizedCornerSpread: number;
}

interface MutableTimings {
  grayscaleMs: number;
  resizeMs: number;
  thresholdMs: number;
  contoursMs: number;
  fiducialDecodeMs: number;
  homographyMs: number;
  refinementMs: number;
  totalMs: number;
}

interface MutableCounters {
  contoursTotal: number;
  areaTooSmall: number;
  areaTooLarge: number;
  nonQuad: number;
  nonConvex: number;
  quads: number;
  mergedCandidates: number;
  candidateCountRaw: number;
  candidateCountRanked: number;
  decoded: number;
  duplicateIds: number;
  lowContrast: number;
  ambiguous: number;
  tooManyErrors: number;
  decodeFailures: number;
}

interface FiducialAnalysis {
  status: "valid" | "ambiguous" | "too-many-errors";
  best: VisionFiducialMatch;
  second: VisionFiducialMatch;
}

interface FiducialWarpResult {
  readonly identity?: FiducialAnalysis;
  readonly lowContrast: boolean;
  readonly contrast: number;
  readonly blurMetric: number;
}

interface MarkerSample {
  readonly luminances: readonly number[];
  readonly black: number;
  readonly white: number;
  readonly contrast: number;
}

interface DetectionResult {
  markers: Map<FiducialId, MarkerCandidate>;
  candidates: number;
  reason?: Exclude<VisionRejectReason, "HOMOGRAPHY_FAILED">;
  detectionWidth: number;
  detectionHeight: number;
  detectionScale: number;
  contourRetrievalMode: "tree" | "list";
  warnings: VisionWarning[];
  traces: VisionCandidateTrace[];
  tracesTruncated: boolean;
  thresholdPlane?: VisionPlane;
}

interface MutableHomographyDiagnostics {
  method: VisionHomographyMethod;
  residualRmsModules?: number;
  residualMaxModules?: number;
  refinementResidualBeforeRmsModules?: number;
  refinementResidualBeforeMaxModules?: number;
  refinementResidualAfterRmsModules?: number;
  refinementResidualAfterMaxModules?: number;
  refinementAttempted: boolean;
  refinementApplied: boolean;
}

const MARKER_SAMPLE = 90;
const TRACE_LIMIT = 64;
const MINIMUM_AREA_FRACTION = 0.00008;
const MAXIMUM_AREA_FRACTION = 0.08;
const POLYGON_EPSILON_FRACTION = 0.045;
const MAXIMUM_CONTOURS_PER_PASS = 50_000;
const MAXIMUM_QUAD_PROPOSALS = 256;
const CANDIDATE_BUCKET_DIVISIONS = 4;
const MAXIMUM_CANDIDATES_PER_BUCKET = 8;
const MINIMUM_FIDUCIAL_CONTRAST = 30;
const ADAPTIVE_BLOCK_SIZE = 31;
const ADAPTIVE_CONSTANT = 7;
const THRESHOLD_PASSES: readonly Readonly<{
  id: VisionThresholdPass;
  kind: "adaptive" | "otsu";
  blockSize?: number;
  constant?: number;
}>[] = Object.freeze([
  Object.freeze({ id: "adaptive-31-7", kind: "adaptive", blockSize: 31, constant: 7 }),
  Object.freeze({ id: "adaptive-21-5", kind: "adaptive", blockSize: 21, constant: 5 }),
  Object.freeze({ id: "otsu", kind: "otsu" }),
]);
const REFINEMENT_MAXIMUM_RMS_MODULES = 1.25;
const REFINEMENT_ACCEPTED_RMS_MODULES = 0.5;
/**
 * Refinement re-runs the whole marker search over the warped canonical frame,
 * which costs more than every other vision stage combined. It is only worth
 * paying when the current warp is worse than the quality a refinement would
 * have to reach to be adopted, so the trigger is tied to the acceptance bar
 * rather than sitting below it.
 *
 * The two used to be independent (trigger above 0.25, adopt only below 0.5 and
 * at least 25% better). Residuals in the 0.25-0.4 band therefore always ran the
 * full second pass and always failed the 25% test: measured on a real capture,
 * 2297 ms of a 5289 ms frame spent to discard the result every time.
 */
const REFINEMENT_MINIMUM_RMS_MODULES = REFINEMENT_ACCEPTED_RMS_MODULES;

export function shouldRefineHomography(residualRmsModules: number | undefined): boolean {
  return residualRmsModules !== undefined &&
    Number.isFinite(residualRmsModules) &&
    residualRmsModules > REFINEMENT_MINIMUM_RMS_MODULES &&
    residualRmsModules <= REFINEMENT_MAXIMUM_RMS_MODULES;
}

export function refinementImprovesHomography(
  initialRmsModules: number,
  correctedRmsModules: number | undefined,
): boolean {
  return correctedRmsModules !== undefined &&
    Number.isFinite(correctedRmsModules) &&
    correctedRmsModules <= REFINEMENT_ACCEPTED_RMS_MODULES &&
    correctedRmsModules <= initialRmsModules * 0.75;
}

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

const MARKER_SAMPLE_OFFSETS = Object.freeze([
  Object.freeze([0, 0] as const),
  Object.freeze([-1, 0] as const),
  Object.freeze([1, 0] as const),
  Object.freeze([0, -1] as const),
  Object.freeze([0, 1] as const),
]);

function medianNumber(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return (sorted.length & 1) === 1
    ? sorted[middle]!
    : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/** Sample one 9x9 marker and retain its local black/white separation. */
function sampleMarker(warped: CvMat, offsetX: number, offsetY: number): MarkerSample {
  const luminances = new Array<number>(81);
  const darkAnchors: number[] = [];
  const lightAnchors: number[] = [];
  for (let moduleY = 0; moduleY < 9; moduleY++) {
    for (let moduleX = 0; moduleX < 9; moduleX++) {
      const samples: number[] = [];
      const startX = moduleX * 10 + 2 + offsetX;
      const startY = moduleY * 10 + 2 + offsetY;
      for (let y = startY; y < startY + 6; y++) {
        for (let x = startX; x < startX + 6; x++) samples.push(warped.data[y * warped.cols + x]!);
      }
      const value = medianNumber(samples);
      luminances[moduleY * 9 + moduleX] = value;
      const isBorder = moduleX === 0 || moduleY === 0 || moduleX === 8 || moduleY === 8;
      const isRing = !isBorder &&
        (moduleX === 1 || moduleY === 1 || moduleX === 7 || moduleY === 7);
      if (isBorder) darkAnchors.push(value);
      else if (isRing) lightAnchors.push(value);
    }
  }
  const black = medianNumber(darkAnchors);
  const white = medianNumber(lightAnchors);
  return { luminances, black, white, contrast: white - black };
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

/**
 * Rank every frozen ID/orientation hypothesis. Orientation is part of the
 * codeword: an equal-distance rotation is just as ambiguous as an equal ID.
 */
export function analyzeFiducialModules(modules: Uint8Array): FiducialAnalysis {
  if (modules.length !== 81) throw new RangeError("A fiducial sample must contain 81 modules.");
  const ranked: VisionFiducialMatch[] = [];
  for (const marker of FIDUCIALS) {
    for (let rotation = 0; rotation < 4; rotation++) {
      let errors = 0;
      for (let y = 0; y < 9; y++) {
        for (let x = 0; x < 9; x++) {
          if (rotatedModule(modules, x, y, rotation) !== fiducialModule(marker.id, x, y)) {
            errors++;
          }
        }
      }
      ranked.push({
        id: marker.id,
        errors,
        rotation: rotation as 0 | 1 | 2 | 3,
      });
    }
  }
  ranked.sort((left, right) => left.errors - right.errors ||
    left.id.localeCompare(right.id) || left.rotation - right.rotation);
  const best = ranked[0]!;
  const second = ranked[1]!;
  // dmin=10 across the frozen marker family: floor((dmin-1)/2)=4.
  if (best.errors === second.errors) return { status: "ambiguous", best, second };
  if (best.errors > COLOR4_MAX_FIDUCIAL_ERRORS) return { status: "too-many-errors", best, second };
  return { status: "valid", best, second };
}

function fiducialWarpQuality(warped: CvMat): Readonly<{ blurMetric: number }> {
  let laplacianCount = 0;
  let laplacianTotal = 0;
  let laplacianSquaredTotal = 0;
  for (let y = 1; y < warped.rows - 1; y++) {
    for (let x = 1; x < warped.cols - 1; x++) {
      const center = warped.data[y * warped.cols + x]!;
      const value = center * 4 -
        warped.data[(y - 1) * warped.cols + x]! -
        warped.data[(y + 1) * warped.cols + x]! -
        warped.data[y * warped.cols + x - 1]! -
        warped.data[y * warped.cols + x + 1]!;
      laplacianCount++;
      laplacianTotal += value;
      laplacianSquaredTotal += value * value;
    }
  }
  const average = laplacianCount === 0 ? 0 : laplacianTotal / laplacianCount;
  const blurMetric = laplacianCount === 0
    ? 0
    : Math.max(0, laplacianSquaredTotal / laplacianCount - average * average);
  return { blurMetric };
}

function analyzeFiducialWarp(warped: CvMat): FiducialWarpResult {
  const ranked = new Map<string, VisionFiducialMatch>();
  const acceptedContrasts: number[] = [];
  let strongestObservedContrast = Number.NEGATIVE_INFINITY;
  for (const [offsetX, offsetY] of MARKER_SAMPLE_OFFSETS) {
    const sample = sampleMarker(warped, offsetX, offsetY);
    strongestObservedContrast = Math.max(strongestObservedContrast, sample.contrast);
    if (!(sample.contrast >= MINIMUM_FIDUCIAL_CONTRAST)) continue;
    acceptedContrasts.push(sample.contrast);
    const threshold = (sample.black + sample.white) / 2;
    const analysis = analyzeFiducialModules(
      Uint8Array.from(sample.luminances, (value) => value <= threshold ? 1 : 0),
    );
    // The pure analysis exposes the two globally closest ID/orientation
    // hypotheses, which is sufficient to preserve any minimum or tie across
    // the five bounded sampling offsets.
    for (const match of [analysis.best, analysis.second]) {
      const key = `${match.id}:${match.rotation}`;
      const existing = ranked.get(key);
      if (existing === undefined || match.errors < existing.errors) ranked.set(key, match);
    }
  }
  const values = [...ranked.values()].sort(
    (left, right) => left.errors - right.errors ||
      left.id.localeCompare(right.id) || left.rotation - right.rotation,
  );
  const quality = fiducialWarpQuality(warped);
  const best = values[0];
  const second = values[1];
  const contrast = acceptedContrasts.length === 0
    ? Math.max(0, Number.isFinite(strongestObservedContrast) ? strongestObservedContrast : 0)
    : medianNumber(acceptedContrasts);
  if (best === undefined || second === undefined) {
    return { lowContrast: acceptedContrasts.length === 0, contrast, ...quality };
  }
  if (best.errors === second.errors) {
    return {
      identity: { status: "ambiguous", best, second },
      lowContrast: false,
      contrast,
      ...quality,
    };
  }
  if (best.errors > COLOR4_MAX_FIDUCIAL_ERRORS) {
    return {
      identity: { status: "too-many-errors", best, second },
      lowContrast: false,
      contrast,
      ...quality,
    };
  }
  return {
    identity: { status: "valid", best, second },
    lowContrast: false,
    contrast,
    ...quality,
  };
}

function decodeCandidate(
  cv: OpenCvRuntime,
  gray: CvMat,
  quad: VisionQuad,
): FiducialWarpResult | null {
  let source: CvMat | undefined;
  let destination: CvMat | undefined;
  let transform: CvMat | undefined;
  let warped: CvMat | undefined;
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
    return analyzeFiducialWarp(warped);
  } catch {
    return null;
  } finally {
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
  readonly lowContrast: number;
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
  if (summary.lowContrast > 0) return "FIDUCIAL_LOW_CONTRAST";
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

function pointDistance(left: Point, right: Point): number {
  return Math.hypot(left.x - right.x, left.y - right.y);
}

function meanQuadSide(quad: VisionQuad): number {
  return quad.reduce(
    (total, point, index) => total + pointDistance(point, quad[(index + 1) % 4]!) / 4,
    0,
  );
}

function meanCornerDistance(left: VisionQuad, right: VisionQuad): number {
  return left.reduce((total, point, index) => total + pointDistance(point, right[index]!) / 4, 0);
}

function unitInterval(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function quadSquareness(quad: VisionQuad): number {
  const sides = quad.map((point, index) => pointDistance(point, quad[(index + 1) % 4]!));
  const horizontal = (sides[0]! + sides[2]!) / 2;
  const vertical = (sides[1]! + sides[3]!) / 2;
  if (!(horizontal > 0) || !(vertical > 0)) return 0;
  const aspect = Math.min(horizontal, vertical) / Math.max(horizontal, vertical);
  const horizontalBalance = Math.min(sides[0]!, sides[2]!) / Math.max(sides[0]!, sides[2]!);
  const verticalBalance = Math.min(sides[1]!, sides[3]!) / Math.max(sides[1]!, sides[3]!);
  return unitInterval(aspect * Math.sqrt(horizontalBalance * verticalBalance));
}

function graySample(gray: CvMat, point: Point): number | undefined {
  const x = Math.round(point.x);
  const y = Math.round(point.y);
  if (x < 0 || y < 0 || x >= gray.cols || y >= gray.rows) return undefined;
  return gray.data[y * gray.cols + x];
}

/** A bounded edge probe used only for ranking, never as a validity decision. */
function quadBorderContrast(gray: CvMat, quad: VisionQuad): number {
  const center = projectiveQuadCenter(quad);
  const differences: number[] = [];
  for (let index = 0; index < 4; index++) {
    const left = quad[index]!;
    const right = quad[(index + 1) % 4]!;
    const midpoint = { x: (left.x + right.x) / 2, y: (left.y + right.y) / 2 };
    const ray = { x: midpoint.x - center.x, y: midpoint.y - center.y };
    const inside = graySample(gray, { x: center.x + ray.x * 0.88, y: center.y + ray.y * 0.88 });
    const outside = graySample(gray, { x: center.x + ray.x * 1.12, y: center.y + ray.y * 1.12 });
    if (inside !== undefined && outside !== undefined) differences.push(Math.abs(inside - outside));
  }
  return medianNumber(differences);
}

function hierarchyDepth(hierarchy: CvMat, contourIndex: number): number {
  const values = hierarchy.data32S;
  if (values.length < (contourIndex + 1) * 4) return 0;
  let depth = 0;
  let parent = values[contourIndex * 4 + 3] ?? -1;
  const visited = new Set<number>();
  while (parent >= 0 && parent * 4 + 3 < values.length && depth < 16 && !visited.has(parent)) {
    visited.add(parent);
    depth++;
    parent = values[parent * 4 + 3] ?? -1;
  }
  return depth;
}

function prewarpScore(squareness: number, borderContrast: number, nestingDepth: number): number {
  return unitInterval(
    squareness * 0.5 +
      unitInterval(borderContrast / 96) * 0.3 +
      unitInterval(nestingDepth / 3) * 0.2,
  );
}

function comparePrewarp(left: QuadProposal, right: QuadProposal): number {
  return right.prewarpScore - left.prewarpScore ||
    right.nestingDepth - left.nestingDepth ||
    right.borderContrast - left.borderContrast ||
    right.squareness - left.squareness ||
    left.contourIndex - right.contourIndex;
}

function candidateBucket(
  proposal: QuadProposal,
  imageWidth: number,
  imageHeight: number,
): number {
  const center = projectiveQuadCenter(proposal.detectionQuad);
  const x = Math.min(
    CANDIDATE_BUCKET_DIVISIONS - 1,
    Math.max(0, Math.floor(center.x / Math.max(1, imageWidth) * CANDIDATE_BUCKET_DIVISIONS)),
  );
  const y = Math.min(
    CANDIDATE_BUCKET_DIVISIONS - 1,
    Math.max(0, Math.floor(center.y / Math.max(1, imageHeight) * CANDIDATE_BUCKET_DIVISIONS)),
  );
  const fraction = proposal.area / Math.max(1, imageWidth * imageHeight);
  const relative = unitInterval(
    Math.log(Math.max(MINIMUM_AREA_FRACTION, fraction) / MINIMUM_AREA_FRACTION) /
      Math.log(MAXIMUM_AREA_FRACTION / MINIMUM_AREA_FRACTION),
  );
  const size = Math.min(
    CANDIDATE_BUCKET_DIVISIONS - 1,
    Math.floor(relative * CANDIDATE_BUCKET_DIVISIONS),
  );
  return (y * CANDIDATE_BUCKET_DIVISIONS + x) * CANDIDATE_BUCKET_DIVISIONS + size;
}

function retainBucketedCandidate(
  buckets: Map<number, QuadProposal[]>,
  proposal: QuadProposal,
  imageWidth: number,
  imageHeight: number,
): boolean {
  const key = candidateBucket(proposal, imageWidth, imageHeight);
  const bucket = buckets.get(key) ?? [];
  if (!buckets.has(key)) buckets.set(key, bucket);
  bucket.push(proposal);
  bucket.sort(comparePrewarp);
  if (bucket.length <= MAXIMUM_CANDIDATES_PER_BUCKET) return false;
  bucket.pop();
  return true;
}

export function uniformlySampledContourIndices(
  contourCount: number,
  maximum: number = MAXIMUM_CONTOURS_PER_PASS,
): number[] {
  if (!Number.isInteger(contourCount) || contourCount < 0) {
    throw new RangeError("contourCount must be a non-negative integer.");
  }
  if (!Number.isInteger(maximum) || maximum <= 0) {
    throw new RangeError("maximum must be a positive integer.");
  }
  if (contourCount <= maximum) return Array.from({ length: contourCount }, (_, index) => index);
  if (maximum === 1) return [Math.floor((contourCount - 1) / 2)];
  return Array.from(
    { length: maximum },
    (_, index) => Math.floor(index * (contourCount - 1) / (maximum - 1)),
  );
}

function medianQuad(proposals: readonly QuadProposal[]): VisionQuad {
  return [0, 1, 2, 3].map((corner) => ({
    x: medianNumber(proposals.map((proposal) => proposal.detectionQuad[corner]!.x)),
    y: medianNumber(proposals.map((proposal) => proposal.detectionQuad[corner]!.y)),
  })) as unknown as VisionQuad;
}

function sameQuadCluster(proposal: QuadProposal, cluster: readonly QuadProposal[]): boolean {
  const representative = medianQuad(cluster);
  const side = Math.min(meanQuadSide(proposal.detectionQuad), meanQuadSide(representative));
  if (side <= 0) return false;
  const centerDistance = pointDistance(
    projectiveQuadCenter(proposal.detectionQuad),
    projectiveQuadCenter(representative),
  );
  const representativeArea = medianNumber(cluster.map((value) => value.area));
  const areaRatio = Math.max(proposal.area, representativeArea) /
    Math.max(1, Math.min(proposal.area, representativeArea));
  return centerDistance <= side * 0.15 &&
    areaRatio <= 1.35 &&
    meanCornerDistance(proposal.detectionQuad, representative) <= side * 0.12;
}

function mergeQuadProposals(proposals: readonly QuadProposal[]): MergedQuadProposal[] {
  const clusters: QuadProposal[][] = [];
  for (const proposal of proposals) {
    const cluster = clusters.find((candidate) => sameQuadCluster(proposal, candidate));
    if (cluster) cluster.push(proposal);
    else clusters.push([proposal]);
  }
  return clusters.map((cluster) => {
    const detectionQuad = medianQuad(cluster);
    const side = Math.max(1, meanQuadSide(detectionQuad));
    const ranked = [...cluster].sort((left, right) =>
      meanCornerDistance(left.detectionQuad, detectionQuad) -
        meanCornerDistance(right.detectionQuad, detectionQuad) ||
      THRESHOLD_PASSES.findIndex((pass) => pass.id === left.thresholdPass) -
        THRESHOLD_PASSES.findIndex((pass) => pass.id === right.thresholdPass) ||
      left.contourIndex - right.contourIndex);
    const primary = ranked[0]!;
    const thresholdPasses = THRESHOLD_PASSES
      .map(({ id }) => id)
      .filter((id) => cluster.some((proposal) => proposal.thresholdPass === id));
    const spread = cluster.reduce(
      (total, proposal) => total + meanCornerDistance(proposal.detectionQuad, detectionQuad),
      0,
    ) / cluster.length / side;
    return {
      ...primary,
      area: medianNumber(cluster.map((proposal) => proposal.area)),
      detectionQuad,
      thresholdPasses,
      normalizedCornerSpread: spread,
      squareness: medianNumber(cluster.map((proposal) => proposal.squareness)),
      borderContrast: Math.max(...cluster.map((proposal) => proposal.borderContrast)),
      nestingDepth: Math.max(...cluster.map((proposal) => proposal.nestingDepth)),
      prewarpScore: Math.max(...cluster.map((proposal) => proposal.prewarpScore)),
    };
  });
}

function compareMergedPrewarp(left: MergedQuadProposal, right: MergedQuadProposal): number {
  return right.thresholdPasses.length - left.thresholdPasses.length ||
    right.prewarpScore - left.prewarpScore ||
    right.nestingDepth - left.nestingDepth ||
    right.borderContrast - left.borderContrast ||
    right.squareness - left.squareness ||
    left.normalizedCornerSpread - right.normalizedCornerSpread ||
    left.contourIndex - right.contourIndex;
}

function candidateIsBetter(incoming: VisionCandidateScore, existing: VisionCandidateScore): boolean {
  return incoming.hammingErrors < existing.hammingErrors ||
    (incoming.hammingErrors === existing.hammingErrors &&
      (incoming.passSupport > existing.passSupport ||
        (incoming.passSupport === existing.passSupport &&
          (incoming.normalizedCornerSpread < existing.normalizedCornerSpread ||
            (incoming.normalizedCornerSpread === existing.normalizedCornerSpread &&
              (incoming.prewarpScore > existing.prewarpScore ||
                (incoming.prewarpScore === existing.prewarpScore && incoming.area > existing.area)))))));
}

function thresholdForPass(
  cv: OpenCvRuntime,
  source: CvMat,
  destination: CvMat,
  pass: (typeof THRESHOLD_PASSES)[number],
): void {
  if (pass.kind === "otsu") {
    cv.threshold(source, destination, 0, 255, cv.THRESH_BINARY_INV | cv.THRESH_OTSU);
    return;
  }
  cv.adaptiveThreshold(
    source,
    destination,
    255,
    cv.ADAPTIVE_THRESH_GAUSSIAN_C,
    cv.THRESH_BINARY_INV,
    pass.blockSize!,
    pass.constant!,
  );
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
  const limit = maxDetectionDimension === "source" ? Number.POSITIVE_INFINITY : maxDetectionDimension;
  const scale = Math.min(1, limit / Math.max(gray.cols, gray.rows));
  const traces: VisionCandidateTrace[] = [];
  let tracesTruncated = false;
  let thresholdPlane: VisionPlane | undefined;
  const retainedProposals: QuadProposal[] = [];
  const warningSet = new Set<VisionWarning>();
  const contourRetrievalMode = cv.RETR_TREE === undefined ? "list" : "tree";
  const contourRetrievalFlag = cv.RETR_TREE ?? cv.RETR_LIST;
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
    const imageArea = detection.rows * detection.cols;
    let globalContourBase = 0;
    for (const pass of THRESHOLD_PASSES) {
      const passBuckets = new Map<number, QuadProposal[]>();
      let binary: CvMat | undefined;
      let contours: CvMatVector | undefined;
      let hierarchy: CvMat | undefined;
      try {
        let started = now();
        binary = new cv.Mat();
        thresholdForPass(cv, detection, binary, pass);
        timings.thresholdMs += elapsed(now, started);
        if (captureThreshold && pass === THRESHOLD_PASSES[0]) {
          thresholdPlane = planeFromMat(binary, 1);
        }
        contours = new cv.MatVector();
        hierarchy = new cv.Mat();
        started = now();
        cv.findContours(binary, contours, hierarchy, contourRetrievalFlag, cv.CHAIN_APPROX_SIMPLE);
        const contourCount = contours.size();
        counters.contoursTotal += contourCount;
        if (contourCount > MAXIMUM_CONTOURS_PER_PASS) {
          warningSet.add("CONTOUR_BUDGET_UNIFORMLY_SAMPLED");
        }
        for (const index of uniformlySampledContourIndices(contourCount)) {
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
            counters.candidateCountRaw++;
            const detectionQuad = pointsFromContour(approximation);
            const squareness = quadSquareness(detectionQuad);
            const borderContrast = quadBorderContrast(detection, detectionQuad);
            const nestingDepth = hierarchyDepth(hierarchy, index);
            const proposal: QuadProposal = {
              contourIndex: globalContourBase + index,
              area,
              detectionQuad,
              thresholdPass: pass.id,
              squareness,
              borderContrast,
              nestingDepth,
              prewarpScore: prewarpScore(squareness, borderContrast, nestingDepth),
            };
            if (retainBucketedCandidate(passBuckets, proposal, detection.cols, detection.rows)) {
              warningSet.add("CANDIDATE_BUDGET_RANKED");
            }
          } finally {
            deleteMat(approximation);
            contour.delete();
          }
        }
        timings.contoursMs += elapsed(now, started);
        globalContourBase += contourCount;
      } finally {
        hierarchy?.delete();
        contours?.delete();
        binary?.delete();
      }
      retainedProposals.push(...[...passBuckets.values()].flat());
    }
    const merged = mergeQuadProposals(retainedProposals);
    counters.mergedCandidates = merged.length;
    const ranked = [...merged].sort(compareMergedPrewarp).slice(0, MAXIMUM_QUAD_PROPOSALS);
    counters.candidateCountRanked = ranked.length;
    if (ranked.length < merged.length) warningSet.add("CANDIDATE_BUDGET_RANKED");
    const markers = new Map<FiducialId, MarkerCandidate>();
    for (const proposal of ranked) {
      // Every candidate costs a perspective warp plus a marker decode, and the
      // ranking already puts genuine fiducials first. Once all four IDs have
      // decoded without a single bit error there is nothing better left to find,
      // so scanning the remaining candidates is pure latency. Debug collection
      // keeps the full sweep because its traces describe every candidate.
      if (!collectDebug && allFiducialsDecodedCleanly(markers)) break;
      const detectionQuad = proposal.detectionQuad;
      const quad = sourceQuad(detectionQuad, scale);
      const center = projectiveQuadCenter(quad);
      const decodeStarted = now();
      const decoded = decodeCandidate(cv, detection, detectionQuad);
      timings.fiducialDecodeMs += elapsed(now, decodeStarted);
      const identity = decoded?.identity;
      const score: VisionCandidateScore | undefined = identity === undefined ? undefined : {
        hammingErrors: identity.best.errors,
        passSupport: proposal.thresholdPasses.length,
        normalizedCornerSpread: proposal.normalizedCornerSpread,
        prewarpScore: proposal.prewarpScore,
        squareness: proposal.squareness,
        borderContrast: proposal.borderContrast,
        nestingDepth: proposal.nestingDepth,
        area: proposal.area,
      };

      let status: VisionCandidateStatus = "FIDUCIAL_DECODE_FAILED";
      let replaceExisting = false;
      if (decoded?.lowContrast) {
        counters.lowContrast++;
        status = "FIDUCIAL_LOW_CONTRAST";
      } else if (identity === undefined) {
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
          replaceExisting = candidateIsBetter(score!, existing.score);
          if (replaceExisting) {
            if (existing.traceIndex !== undefined && traces[existing.traceIndex]) {
              traces[existing.traceIndex] = { ...traces[existing.traceIndex]!, status: "DUPLICATE_ID" };
            }
            status = "DECODED";
          }
        }
      }
      let traceIndex: number | undefined;
      if (collectDebug) {
        if (traces.length >= TRACE_LIMIT) tracesTruncated = true;
        traceIndex = retainCandidateTrace(traces, {
          contourIndex: proposal.contourIndex,
          area: proposal.area,
          quad,
          center,
          detectionQuad,
          thresholdPass: proposal.thresholdPass,
          thresholdPasses: proposal.thresholdPasses,
          ...(score === undefined ? {} : { candidateScore: score }),
          status,
          ...(identity === undefined ? {} : { best: identity.best, second: identity.second }),
        });
      }
      if (identity?.status === "valid" && (status === "DECODED" || replaceExisting)) {
        markers.set(identity.best.id, {
          ...identity.best,
          center,
          quad,
          detectionQuad,
          score: score!,
          contrast: decoded!.contrast,
          blurMetric: decoded!.blurMetric,
          ...(traceIndex === undefined ? {} : { traceIndex }),
        });
      }
    }
    const reason = selectVisionRejectReason({
      quads: counters.quads,
      uniqueIds: markers.size,
      duplicateIds: counters.duplicateIds,
      lowContrast: counters.lowContrast,
      ambiguous: counters.ambiguous,
      tooManyErrors: counters.tooManyErrors,
    });
    return {
      markers,
      candidates: ranked.length,
      ...(reason === undefined ? {} : { reason }),
      detectionWidth: detection.cols,
      detectionHeight: detection.rows,
      detectionScale: scale,
      contourRetrievalMode,
      warnings: [...warningSet],
      traces,
      tracesTruncated,
      ...(thresholdPlane === undefined ? {} : { thresholdPlane }),
    };
  } finally {
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
    refinementMs: 0,
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
    mergedCandidates: 0,
    candidateCountRaw: 0,
    candidateCountRanked: 0,
    decoded: 0,
    duplicateIds: 0,
    lowContrast: 0,
    ambiguous: 0,
    tooManyErrors: 0,
    decodeFailures: 0,
  };
}

function solveLinearSystem(rows: number[][]): number[] | undefined {
  const size = rows.length;
  if (size === 0 || rows.some((row) => row.length !== size + 1)) return undefined;
  const matrix = rows.map((row) => [...row]);
  for (let column = 0; column < size; column++) {
    let pivot = column;
    for (let row = column + 1; row < size; row++) {
      if (Math.abs(matrix[row]![column]!) > Math.abs(matrix[pivot]![column]!)) pivot = row;
    }
    if (Math.abs(matrix[pivot]![column]!) < 1e-9) return undefined;
    [matrix[column], matrix[pivot]] = [matrix[pivot]!, matrix[column]!];
    const divisor = matrix[column]![column]!;
    for (let value = column; value <= size; value++) matrix[column]![value]! /= divisor;
    for (let row = 0; row < size; row++) {
      if (row === column) continue;
      const factor = matrix[row]![column]!;
      if (factor === 0) continue;
      for (let value = column; value <= size; value++) {
        matrix[row]![value]! -= factor * matrix[column]![value]!;
      }
    }
  }
  const result = matrix.map((row) => row[size]!);
  return result.every(Number.isFinite) ? result : undefined;
}

function projectiveFrameQuad(markers: ReadonlyMap<FiducialId, MarkerCandidate>): VisionQuad | undefined {
  const rows: number[][] = [];
  for (const placement of FIDUCIALS) {
    const observed = markers.get(placement.id)?.center;
    if (!observed) return undefined;
    const x = QUIET_MODULES + placement.x + placement.width / 2;
    const y = QUIET_MODULES + placement.y + placement.height / 2;
    rows.push([x, y, 1, 0, 0, 0, -observed.x * x, -observed.x * y, observed.x]);
    rows.push([0, 0, 0, x, y, 1, -observed.y * x, -observed.y * y, observed.y]);
  }
  const coefficients = solveLinearSystem(rows);
  if (!coefficients) return undefined;
  const project = (x: number, y: number): Point | undefined => {
    const denominator = coefficients[6]! * x + coefficients[7]! * y + 1;
    if (!Number.isFinite(denominator) || Math.abs(denominator) < 1e-9) return undefined;
    const point = {
      x: (coefficients[0]! * x + coefficients[1]! * y + coefficients[2]!) / denominator,
      y: (coefficients[3]! * x + coefficients[4]! * y + coefficients[5]!) / denominator,
    };
    return Number.isFinite(point.x) && Number.isFinite(point.y) ? point : undefined;
  };
  const projected = [
    project(0, 0),
    project(TOTAL_MODULES, 0),
    project(TOTAL_MODULES, TOTAL_MODULES),
    project(0, TOTAL_MODULES),
  ];
  if (projected.some((point) => point === undefined)) return undefined;
  return projected as unknown as VisionQuad;
}

function opticalMetricsFor(
  markers: ReadonlyMap<FiducialId, MarkerCandidate>,
  clippedPixelFraction: number | undefined,
): VisionOpticalMetrics | undefined {
  if (FIDUCIALS.some(({ id }) => !markers.has(id))) return undefined;
  const frame = projectiveFrameQuad(markers);
  if (!frame) return undefined;
  const topEdge = pointDistance(frame[0], frame[1]);
  const rightEdge = pointDistance(frame[1], frame[2]);
  const bottomEdge = pointDistance(frame[3], frame[2]);
  const leftEdge = pointDistance(frame[0], frame[3]);
  const apparentFrameWidthPx = (topEdge + bottomEdge) / 2;
  const apparentFrameHeightPx = (leftEdge + rightEdge) / 2;
  const pixelsPerModuleX = apparentFrameWidthPx / TOTAL_MODULES;
  const pixelsPerModuleY = apparentFrameHeightPx / TOTAL_MODULES;
  const fiducialSizes = [...markers.values()].map((marker) => {
    const quad = orientedMarkerQuad(marker);
    return {
      width: (pointDistance(quad[0], quad[1]) + pointDistance(quad[3], quad[2])) / 2,
      height: (pointDistance(quad[0], quad[3]) + pointDistance(quad[1], quad[2])) / 2,
    };
  });
  const values: VisionOpticalMetrics = {
    apparentFrameWidthPx,
    apparentFrameHeightPx,
    pixelsPerModuleX,
    pixelsPerModuleY,
    minimumPixelsPerModule: Math.min(topEdge, rightEdge, bottomEdge, leftEdge) / TOTAL_MODULES,
    fiducialWidthPx: Math.min(...fiducialSizes.map(({ width }) => width)),
    fiducialHeightPx: Math.min(...fiducialSizes.map(({ height }) => height)),
    fiducialContrast: Math.min(...[...markers.values()].map(({ contrast }) => contrast)),
    blurMetric: Math.min(...[...markers.values()].map(({ blurMetric }) => blurMetric)),
    ...(clippedPixelFraction === undefined ? {} : { clippedPixelFraction }),
  };
  return Object.values(values).every(Number.isFinite) ? values : undefined;
}

function canonicalActiveClippedPixelFraction(warped: CvMat, scale: VisionCanonicalScale): number {
  const start = QUIET_MODULES * scale;
  const end = (QUIET_MODULES + ACTIVE_MODULES) * scale;
  let samples = 0;
  let clipped = 0;
  const isClipped = (value: number): boolean => value <= 1 || value >= 254;
  for (let y = start; y < end; y++) {
    for (let x = start; x < end; x++) {
      const offset = (y * warped.cols + x) * 4;
      const red = warped.data[offset];
      const green = warped.data[offset + 1];
      const blue = warped.data[offset + 2];
      if (red === undefined || green === undefined || blue === undefined) continue;
      samples++;
      if (isClipped(red) && isClipped(green) && isClipped(blue)) clipped++;
    }
  }
  return samples === 0 ? 0 : clipped / samples;
}

function effectiveConfig(
  width: number,
  height: number,
  canonicalScale: VisionCanonicalScale,
  maxDetectionDimension: VisionDetectionLimit,
  warpInterpolation: VisionWarpInterpolation,
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
    thresholdPasses: THRESHOLD_PASSES.map(({ id }) => id),
    warpInterpolation,
    minimumAreaFraction: MINIMUM_AREA_FRACTION,
    maximumAreaFraction: MAXIMUM_AREA_FRACTION,
    polygonEpsilonFraction: POLYGON_EPSILON_FRACTION,
    maximumContoursPerPass: MAXIMUM_CONTOURS_PER_PASS,
    maximumQuadProposals: MAXIMUM_QUAD_PROPOSALS,
    candidateBucketDivisions: CANDIDATE_BUCKET_DIVISIONS,
    maximumCandidatesPerBucket: MAXIMUM_CANDIDATES_PER_BUCKET,
    contourRetrievalMode: found.contourRetrievalMode,
    minimumFiducialContrast: MINIMUM_FIDUCIAL_CONTRAST,
    maximumFiducialErrors: COLOR4_MAX_FIDUCIAL_ERRORS,
  };
}

function diagnosticsFor(
  config: VisionEffectiveConfig,
  timings: MutableTimings,
  counters: MutableCounters,
  markers: ReadonlyMap<FiducialId, MarkerCandidate>,
  homography: MutableHomographyDiagnostics,
  warnings: readonly VisionWarning[],
  clippedPixelFraction: number | undefined,
): VisionDiagnostics {
  const fiducials: Partial<Record<FiducialId, VisionFiducialMatch>> = {};
  for (const [id, marker] of markers) {
    fiducials[id] = { id, errors: marker.errors, rotation: marker.rotation };
  }
  const optical = opticalMetricsFor(markers, clippedPixelFraction);
  return {
    config,
    timings: { ...timings } satisfies VisionStageTimings,
    counters: { ...counters } satisfies VisionContourCounters,
    warnings: [...warnings],
    ...(optical === undefined ? {} : { optical }),
    fiducials,
    homography: { ...homography },
  };
}

function debugArtifacts(
  enabled: boolean,
  config: VisionEffectiveConfig,
  found: DetectionResult,
  homography: MutableHomographyDiagnostics,
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
      warpInterpolation: config.warpInterpolation,
      homographyMethod: homography.method,
      warpedAvailable,
      traceLimit: TRACE_LIMIT,
      tracesTruncated: found.tracesTruncated,
    },
    traces: found.traces,
    planes,
  };
}

const ORDERED_FIDUCIAL_IDS: readonly FiducialId[] = Object.freeze(["TL", "TR", "BR", "BL"]);

/**
 * True when all four markers are present and each decoded with zero Hamming
 * errors. Only a bit-perfect set is treated as final: a marker carrying errors
 * may still be beaten by a later, better-scoring candidate for the same ID.
 */
function allFiducialsDecodedCleanly(
  markers: ReadonlyMap<FiducialId, MarkerCandidate>,
): boolean {
  return ORDERED_FIDUCIAL_IDS.every((id) => markers.get(id)?.errors === 0);
}

interface HomographySolution {
  readonly method: Exclude<VisionHomographyMethod, "none">;
  readonly sourcePoints: CvMat;
  readonly destinationPoints: CvMat;
  readonly destinationValues: readonly number[];
  readonly transform: CvMat;
  readonly residual?: Readonly<{ rmsModules: number; maxModules: number }>;
}

function interpolationFlag(cv: OpenCvRuntime, interpolation: VisionWarpInterpolation): number {
  if (interpolation === "nearest" && cv.INTER_NEAREST !== undefined) return cv.INTER_NEAREST;
  if (interpolation === "cubic" && cv.INTER_CUBIC !== undefined) return cv.INTER_CUBIC;
  return cv.INTER_LINEAR;
}

function orientedMarkerQuad(marker: MarkerCandidate): VisionQuad {
  return [0, 1, 2, 3].map(
    (corner) => marker.quad[(corner - marker.rotation + 4) % 4]!,
  ) as unknown as VisionQuad;
}

function canonicalMarkerQuad(id: FiducialId, scale: VisionCanonicalScale): VisionQuad {
  const marker = FIDUCIALS.find((candidate) => candidate.id === id)!;
  const left = (QUIET_MODULES + marker.x) * scale;
  const top = (QUIET_MODULES + marker.y) * scale;
  const right = (QUIET_MODULES + marker.x + marker.width) * scale - 1;
  const bottom = (QUIET_MODULES + marker.y + marker.height) * scale - 1;
  return [
    { x: left, y: top },
    { x: right, y: top },
    { x: right, y: bottom },
    { x: left, y: bottom },
  ];
}

function pointValues(points: readonly Point[]): number[] {
  return points.flatMap((point) => [point.x, point.y]);
}

function correspondenceResidual(
  markers: ReadonlyMap<FiducialId, MarkerCandidate>,
  scale: VisionCanonicalScale,
): Readonly<{ rmsModules: number; maxModules: number }> {
  let squared = 0;
  let maximum = 0;
  let count = 0;
  for (const id of ORDERED_FIDUCIAL_IDS) {
    const observed = orientedMarkerQuad(markers.get(id)!);
    const expected = canonicalMarkerQuad(id, scale);
    for (let corner = 0; corner < 4; corner++) {
      const distance = pointDistance(observed[corner]!, expected[corner]!) / scale;
      squared += distance * distance;
      maximum = Math.max(maximum, distance);
      count++;
    }
  }
  return { rmsModules: Math.sqrt(squared / count), maxModules: maximum };
}

function residualFor(
  cv: OpenCvRuntime,
  sourcePoints: CvMat,
  destinationValues: readonly number[],
  transform: CvMat,
  scale: VisionCanonicalScale,
): Readonly<{ rmsModules: number; maxModules: number }> | undefined {
  if (cv.perspectiveTransform === undefined) return undefined;
  const projected = new cv.Mat();
  try {
    cv.perspectiveTransform(sourcePoints, projected, transform);
    const values = (projected.data32F?.length ?? 0) >= destinationValues.length
      ? projected.data32F
      : (projected.data64F?.length ?? 0) >= destinationValues.length
        ? projected.data64F
        : undefined;
    if (values === undefined || values.length < destinationValues.length) return undefined;
    let squared = 0;
    let maximum = 0;
    const points = destinationValues.length / 2;
    for (let index = 0; index < points; index++) {
      const dx = values[index * 2]! - destinationValues[index * 2]!;
      const dy = values[index * 2 + 1]! - destinationValues[index * 2 + 1]!;
      const distance = Math.hypot(dx, dy) / scale;
      squared += distance * distance;
      maximum = Math.max(maximum, distance);
    }
    return { rmsModules: Math.sqrt(squared / points), maxModules: maximum };
  } finally {
    projected.delete();
  }
}

function homographyIsUsable(transform: CvMat): boolean {
  if (transform.rows !== 3 || transform.cols !== 3) return false;
  const coefficients = (transform.data64F?.length ?? 0) >= 9
    ? transform.data64F
    : (transform.data32F?.length ?? 0) >= 9
      ? transform.data32F
      : undefined;
  // Some small test/runtime adapters do not expose the typed coefficient view.
  // In that case OpenCV's 3x3 shape is the strongest available validation.
  if (coefficients === undefined) return true;
  const values = Array.from(coefficients.slice(0, 9));
  if (values.some((value) => !Number.isFinite(value))) return false;
  const magnitude = Math.max(...values.map(Math.abs));
  if (!(magnitude > 0)) return false;
  const [a, b, c, d, e, f, g, h, i] = values.map((value) => value / magnitude);
  const determinant = a! * (e! * i! - f! * h!) -
    b! * (d! * i! - f! * g!) +
    c! * (d! * h! - e! * g!);
  return Number.isFinite(determinant) && Math.abs(determinant) > 1e-12;
}

function residualIsUsable(
  residual: Readonly<{ rmsModules: number; maxModules: number }> | undefined,
): boolean {
  return residual === undefined ||
    (Number.isFinite(residual.rmsModules) && Number.isFinite(residual.maxModules));
}

function homographyFor(
  cv: OpenCvRuntime,
  markers: ReadonlyMap<FiducialId, MarkerCandidate>,
  scale: VisionCanonicalScale,
  allowCenterFallback: boolean,
): HomographySolution {
  if (cv.findHomography !== undefined) {
    let sourcePoints: CvMat | undefined;
    let destinationPoints: CvMat | undefined;
    let transform: CvMat | undefined;
    try {
      const sourceValues = ORDERED_FIDUCIAL_IDS.flatMap((id) =>
        pointValues(orientedMarkerQuad(markers.get(id)!)));
      const destinationValues = ORDERED_FIDUCIAL_IDS.flatMap((id) =>
        pointValues(canonicalMarkerQuad(id, scale)));
      sourcePoints = cv.matFromArray(16, 1, cv.CV_32FC2, sourceValues);
      destinationPoints = cv.matFromArray(16, 1, cv.CV_32FC2, destinationValues);
      transform = cv.findHomography(sourcePoints, destinationPoints, 0);
      if (!homographyIsUsable(transform)) throw new Error("Invalid 16-point homography.");
      const residual = residualFor(cv, sourcePoints, destinationValues, transform, scale);
      if (!residualIsUsable(residual)) throw new Error("Non-finite homography residual.");
      return {
        method: "corners-16",
        sourcePoints,
        destinationPoints,
        destinationValues,
        transform,
        residual,
      };
    } catch (error) {
      transform?.delete();
      destinationPoints?.delete();
      sourcePoints?.delete();
      if (!allowCenterFallback) throw error;
    }
  }
  if (!allowCenterFallback) throw new Error("16-point homography is unavailable.");
  const sourceValues = ORDERED_FIDUCIAL_IDS.flatMap((id) => {
    const center = markers.get(id)!.center;
    return [center.x, center.y];
  });
  const destinationValues = ORDERED_FIDUCIAL_IDS.flatMap((id) => {
    const quad = canonicalMarkerQuad(id, scale);
    const center = projectiveQuadCenter(quad);
    return [center.x, center.y];
  });
  let sourcePoints: CvMat | undefined;
  let destinationPoints: CvMat | undefined;
  let transform: CvMat | undefined;
  try {
    sourcePoints = cv.matFromArray(4, 1, cv.CV_32FC2, sourceValues);
    destinationPoints = cv.matFromArray(4, 1, cv.CV_32FC2, destinationValues);
    transform = cv.getPerspectiveTransform(sourcePoints, destinationPoints);
    if (!homographyIsUsable(transform)) throw new Error("Invalid four-centre homography.");
    const residual = residualFor(cv, sourcePoints, destinationValues, transform, scale);
    if (!residualIsUsable(residual)) throw new Error("Non-finite homography residual.");
    return {
      method: "centers-4",
      sourcePoints,
      destinationPoints,
      destinationValues,
      transform,
      residual,
    };
  } catch (error) {
    transform?.delete();
    destinationPoints?.delete();
    sourcePoints?.delete();
    throw error;
  }
}

function deleteHomography(solution: HomographySolution | undefined): void {
  solution?.transform.delete();
  solution?.destinationPoints.delete();
  solution?.sourcePoints.delete();
}

export function normalizeColor4WithOpenCv(
  cv: OpenCvRuntime,
  width: number,
  height: number,
  pixels: Uint8ClampedArray,
  options: VisionOptions = {},
): VisionResult {
  const canonicalScale: VisionCanonicalScale =
    options.canonicalScale ?? DEFAULT_COLOR4_CANONICAL_SCALE;
  const maxDetectionDimension: VisionDetectionLimit =
    options.maxDetectionDimension ?? DEFAULT_COLOR4_DETECTION_DIMENSION;
  const warpInterpolation: VisionWarpInterpolation = options.warpInterpolation ?? "cubic";
  const collectDebug = options.debug === true || options.snapshot === true;
  const now = options.now ?? (() => performance.now());
  const totalStarted = now();
  const timings = emptyTimings();
  const counters = emptyCounters();
  const homography: MutableHomographyDiagnostics = {
    method: "none",
    refinementAttempted: false,
    refinementApplied: false,
  };
  const planes: Partial<Record<VisionPlaneId, VisionPlane>> = {};
  let source: CvMat | undefined;
  let gray: CvMat | undefined;
  let solution: HomographySolution | undefined;
  let warped: CvMat | undefined;
  let clippedPixelFraction: number | undefined;
  let homographyStarted: number | undefined;
  let activeStage: "grayscale" | "detection" | "homography" = "grayscale";
  let found: DetectionResult = {
    markers: new Map(),
    candidates: 0,
    reason: "NO_CONTOUR_CANDIDATES",
    detectionWidth: width,
    detectionHeight: height,
    detectionScale: 1,
    contourRetrievalMode: cv.RETR_TREE === undefined ? "list" : "tree",
    warnings: [],
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
      warpInterpolation,
      found,
    );
    const diagnostics = diagnosticsFor(
      config,
      timings,
      counters,
      found.markers,
      homography,
      found.warnings,
      clippedPixelFraction,
    );
    const debug = debugArtifacts(
      collectDebug,
      config,
      found,
      homography,
      planes,
      warpedAvailable,
    );
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
    if (found.reason !== undefined || ORDERED_FIDUCIAL_IDS.some((id) => !found.markers.has(id))) {
      return {
        status: "rejected",
        reason: found.reason ?? "QUADS_FOUND_NO_MARKERS",
        candidates: found.candidates,
        ...finish(false),
      };
    }

    activeStage = "homography";
    homographyStarted = now();
    solution = homographyFor(cv, found.markers, canonicalScale, true);
    homography.method = solution.method;
    if (solution.residual !== undefined) {
      homography.residualRmsModules = solution.residual.rmsModules;
      homography.residualMaxModules = solution.residual.maxModules;
    }
    const canonicalSize = TOTAL_MODULES * canonicalScale;
    const interpolation = interpolationFlag(cv, warpInterpolation);
    warped = new cv.Mat();
    cv.warpPerspective(
      source,
      warped,
      solution.transform,
      new cv.Size(canonicalSize, canonicalSize),
      interpolation,
      cv.BORDER_CONSTANT,
      new cv.Scalar(255, 255, 255, 255),
    );
    timings.homographyMs = elapsed(now, homographyStarted);

    const initialResidual = solution.residual?.rmsModules;
    if (solution.method === "corners-16" && shouldRefineHomography(initialResidual)) {
      homography.refinementAttempted = true;
      const refinementStarted = now();
      let warpedGray: CvMat | undefined;
      let correction: HomographySolution | undefined;
      let refined: CvMat | undefined;
      try {
        warpedGray = new cv.Mat();
        cv.cvtColor(warped, warpedGray, cv.COLOR_RGBA2GRAY);
        const refinementFound = findMarkers(
          cv,
          warpedGray,
          "source",
          false,
          false,
          emptyTimings(),
          emptyCounters(),
          now,
        );
        if (ORDERED_FIDUCIAL_IDS.every((id) => refinementFound.markers.has(id))) {
          const before = correspondenceResidual(refinementFound.markers, canonicalScale);
          homography.refinementResidualBeforeRmsModules = before.rmsModules;
          homography.refinementResidualBeforeMaxModules = before.maxModules;
          if (shouldRefineHomography(before.rmsModules)) {
            correction = homographyFor(cv, refinementFound.markers, canonicalScale, false);
          }
          const after = correction?.residual;
          if (after !== undefined) {
            homography.refinementResidualAfterRmsModules = after.rmsModules;
            homography.refinementResidualAfterMaxModules = after.maxModules;
          }
          if (correction && refinementImprovesHomography(before.rmsModules, after?.rmsModules)) {
            refined = new cv.Mat();
            cv.warpPerspective(
              warped,
              refined,
              correction.transform,
              new cv.Size(canonicalSize, canonicalSize),
              interpolation,
              cv.BORDER_CONSTANT,
              new cv.Scalar(255, 255, 255, 255),
            );
            warped.delete();
            warped = refined;
            refined = undefined;
            homography.refinementApplied = true;
          }
        }
      } catch {
        // Refinement is opportunistic; the already valid first warp remains authoritative.
      } finally {
        refined?.delete();
        deleteHomography(correction);
        warpedGray?.delete();
        timings.refinementMs = elapsed(now, refinementStarted);
      }
    }

    clippedPixelFraction = canonicalActiveClippedPixelFraction(warped, canonicalScale);
    if (shouldCapturePlane(options, "warped")) planes.warped = planeFromMat(warped, 4);
    const canonicalPixels = Uint8ClampedArray.from(warped.data);
    return {
      status: "valid",
      candidates: found.candidates,
      image: { width: canonicalSize, height: canonicalSize, pixels: canonicalPixels },
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
      lowContrast: counters.lowContrast,
      ambiguous: counters.ambiguous,
      tooManyErrors: counters.tooManyErrors,
    }) ?? "QUADS_FOUND_NO_MARKERS";
    const reason: VisionRejectReason = activeStage === "homography"
      ? "HOMOGRAPHY_FAILED"
      : detectionReason;
    return {
      status: "rejected",
      reason,
      candidates: found.candidates,
      ...finish(false),
    };
  } finally {
    warped?.delete();
    deleteHomography(solution);
    gray?.delete();
    source?.delete();
  }
}
