import {
  FIDUCIALS,
  QUIET_MODULES,
  TOTAL_MODULES,
  fiducialModule,
  type FiducialId,
} from "../shared/color4/physical";
import type { CanonicalRasterImage } from "../shared/color4/classifier";

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

interface Point {
  x: number;
  y: number;
}

interface MarkerCandidate {
  id: FiducialId;
  center: Point;
  errors: number;
}

export type VisionResult =
  | { status: "valid"; image: CanonicalRasterImage; candidates: number }
  | { status: "rejected"; reason: "fiducials_not_found" | "homography_failed"; candidates: number };

const MARKER_SAMPLE = 90;
const CANONICAL_SCALE = 4;
const MAX_DETECTION_DIMENSION = 960;

function deleteMat(value: CvMat | undefined): void {
  value?.delete();
}

function orderQuad(points: Point[]): Point[] {
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
  return [...ordered.slice(topLeft), ...ordered.slice(0, topLeft)];
}

function pointsFromContour(contour: CvMat): Point[] {
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
  let best: { id: FiducialId; errors: number } | null = null;
  let tiedAcrossIds = false;
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
      if (best === null || errors < best.errors) {
        best = { id: marker.id, errors };
        tiedAcrossIds = false;
      } else if (errors === best.errors && marker.id !== best.id) tiedAcrossIds = true;
    }
  }
  // dmin=10 across the frozen marker family: floor((dmin-1)/2)=4.
  return best !== null && best.errors <= 4 && !tiedAcrossIds ? best : null;
}

function decodeCandidate(cv: OpenCvRuntime, gray: CvMat, quad: Point[]): { id: FiducialId; errors: number } | null {
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
    return identifyFiducialModules(sampleMarker(binary));
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

function findMarkers(cv: OpenCvRuntime, gray: CvMat): { markers: Map<FiducialId, MarkerCandidate>; candidates: number } {
  let detection = gray;
  let resized: CvMat | undefined;
  let binary: CvMat | undefined;
  let contours: CvMatVector | undefined;
  let hierarchy: CvMat | undefined;
  const scale = Math.min(1, MAX_DETECTION_DIMENSION / Math.max(gray.cols, gray.rows));
  try {
    if (scale < 1) {
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
    }
    binary = new cv.Mat();
    cv.adaptiveThreshold(
      detection,
      binary,
      255,
      cv.ADAPTIVE_THRESH_GAUSSIAN_C,
      cv.THRESH_BINARY_INV,
      31,
      7,
    );
    contours = new cv.MatVector();
    hierarchy = new cv.Mat();
    cv.findContours(binary, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);
    const imageArea = detection.rows * detection.cols;
    const markers = new Map<FiducialId, MarkerCandidate>();
    let candidates = 0;
    for (let index = 0; index < contours.size(); index++) {
      const contour = contours.get(index);
      let approximation: CvMat | undefined;
      try {
        const area = Math.abs(cv.contourArea(contour));
        if (area < imageArea * 0.00008 || area > imageArea * 0.08) continue;
        const perimeter = cv.arcLength(contour, true);
        approximation = new cv.Mat();
        cv.approxPolyDP(contour, approximation, perimeter * 0.045, true);
        if (approximation.rows !== 4 || !cv.isContourConvex(approximation)) continue;
        candidates++;
        const quad = pointsFromContour(approximation);
        const identity = decodeCandidate(cv, detection, quad);
        if (!identity) continue;
        const projectedCenter = projectiveQuadCenter(quad);
        const center = { x: projectedCenter.x / scale, y: projectedCenter.y / scale };
        const candidate = { ...identity, center };
        const existing = markers.get(identity.id);
        if (!existing || candidate.errors < existing.errors) markers.set(identity.id, candidate);
      } finally {
        deleteMat(approximation);
        contour.delete();
      }
    }
    return { markers, candidates };
  } finally {
    hierarchy?.delete();
    contours?.delete();
    binary?.delete();
    resized?.delete();
  }
}

export function normalizeColor4WithOpenCv(
  cv: OpenCvRuntime,
  width: number,
  height: number,
  pixels: Uint8ClampedArray,
): VisionResult {
  let source: CvMat | undefined;
  let gray: CvMat | undefined;
  let sourcePoints: CvMat | undefined;
  let destinationPoints: CvMat | undefined;
  let transform: CvMat | undefined;
  let warped: CvMat | undefined;
  try {
    const imagePixels: Uint8ClampedArray<ArrayBuffer> = pixels.buffer instanceof ArrayBuffer
      ? new Uint8ClampedArray(pixels.buffer, pixels.byteOffset, pixels.byteLength)
      : Uint8ClampedArray.from(pixels);
    source = cv.matFromImageData(new ImageData(imagePixels, width, height));
    gray = new cv.Mat();
    cv.cvtColor(source, gray, cv.COLOR_RGBA2GRAY);
    const found = findMarkers(cv, gray);
    const orderedIds: FiducialId[] = ["TL", "TR", "BR", "BL"];
    if (orderedIds.some((id) => !found.markers.has(id))) {
      return { status: "rejected", reason: "fiducials_not_found", candidates: found.candidates };
    }
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
        (QUIET_MODULES + marker.x + marker.width / 2) * CANONICAL_SCALE - 0.5,
        (QUIET_MODULES + marker.y + marker.height / 2) * CANONICAL_SCALE - 0.5,
      ];
    });
    sourcePoints = cv.matFromArray(4, 1, cv.CV_32FC2, sourceValues);
    destinationPoints = cv.matFromArray(4, 1, cv.CV_32FC2, destinationValues);
    transform = cv.getPerspectiveTransform(sourcePoints, destinationPoints);
    warped = new cv.Mat();
    const canonicalSize = TOTAL_MODULES * CANONICAL_SCALE;
    cv.warpPerspective(
      source,
      warped,
      transform,
      new cv.Size(canonicalSize, canonicalSize),
      cv.INTER_LINEAR,
      cv.BORDER_CONSTANT,
      new cv.Scalar(255, 255, 255, 255),
    );
    return {
      status: "valid",
      candidates: found.candidates,
      image: {
        width: canonicalSize,
        height: canonicalSize,
        pixels: Uint8ClampedArray.from(warped.data),
      },
    };
  } catch {
    return { status: "rejected", reason: "homography_failed", candidates: 0 };
  } finally {
    warped?.delete();
    transform?.delete();
    destinationPoints?.delete();
    sourcePoints?.delete();
    gray?.delete();
    source?.delete();
  }
}
