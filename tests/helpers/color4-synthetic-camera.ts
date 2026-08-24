/**
 * A deterministic synthetic camera view of one COLOR_4 frame at a chosen
 * optical resolution.
 *
 * The OpenCV corpus owns the exhaustive degradation matrix. This helper answers
 * a narrower question that the corpus deliberately does not parameterize: how
 * the pipeline behaves as a function of *pixels per module*, which the physical
 * exports identify as the dominant optical constraint. Everything else is held
 * still so a sweep isolates that one variable.
 *
 * `pixelsPerModule` is stated against the 172-module canonical frame, matching
 * `VisionOpticalMetrics.pixelsPerModuleX` in the receiver, so a sweep value and
 * a measured field value mean the same thing.
 */

import { packFrame } from "../../shared/protocol.ts";
import {
  TOTAL_MODULES,
  rasterizeColor4,
  wrapColor4Frame,
  type Color4PaletteId,
  type Color4Profile,
} from "../../shared/color4/index.ts";

/** The pixel-per-module bands named in the COLOR_4 vision specification. */
export const PIXELS_PER_MODULE_BANDS = Object.freeze({
  veryPoor: 3.5,
  risky: 4.5,
  borderline: 5.5,
  preferred: 7,
});

interface SyntheticCameraMat {
  rows: number;
  cols: number;
  data: Uint8Array;
  delete(): void;
}

export interface SyntheticCameraCv {
  Mat: new () => SyntheticCameraMat;
  Size: new (width: number, height: number) => unknown;
  Scalar: new (...values: number[]) => unknown;
  CV_32FC2: unknown;
  INTER_LINEAR: number;
  BORDER_CONSTANT: number;
  BORDER_DEFAULT: number;
  matFromImageData(image: ImageData): SyntheticCameraMat;
  matFromArray(rows: number, cols: number, type: unknown, values: number[]): SyntheticCameraMat;
  getPerspectiveTransform(
    source: SyntheticCameraMat,
    destination: SyntheticCameraMat,
  ): SyntheticCameraMat;
  warpPerspective(
    source: SyntheticCameraMat,
    destination: SyntheticCameraMat,
    transform: SyntheticCameraMat,
    size: unknown,
    flags?: number,
    borderMode?: number,
    borderValue?: unknown,
  ): void;
  GaussianBlur(
    source: SyntheticCameraMat,
    destination: SyntheticCameraMat,
    size: unknown,
    sigmaX: number,
    sigmaY?: number,
    borderType?: number,
  ): void;
}

export interface SyntheticCameraOptions {
  readonly profile: Color4Profile;
  readonly paletteId: Color4PaletteId;
  readonly sequence: number;
  /** Camera pixels per logical module of the 172-module canonical frame. */
  readonly pixelsPerModule: number;
  readonly cameraWidth?: number;
  readonly cameraHeight?: number;
  /** Odd Gaussian kernel applied after projection; omitted means perfectly sharp. */
  readonly blurKernel?: 3 | 5 | 7;
  /** Horizontal tilt in degrees, applied as a symmetric trapezoid. */
  readonly angleDeg?: number;
}

export interface SyntheticCameraFrame {
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint8ClampedArray<ArrayBuffer>;
  readonly innerFrame: Uint8Array;
  /** The optical resolution actually projected, after integer pixel rounding. */
  readonly pixelsPerModule: number;
}

/** Deterministic, incompressible block bytes for one sequence. */
export function syntheticInnerFrame(profile: Color4Profile, sequence: number): Uint8Array {
  const block = new Uint8Array(profile.blockBytes);
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

function destinationQuad(
  centreX: number,
  centreY: number,
  span: number,
  angleDeg: number,
): readonly { x: number; y: number }[] {
  const half = span / 2;
  // A symmetric trapezoid is enough: the receiver's homography does not care
  // which way the foreshortening runs, only how strong it is.
  const shrink = Math.cos((angleDeg * Math.PI) / 180);
  const rightHalf = half * shrink;
  return [
    { x: centreX - half, y: centreY - half },
    { x: centreX + rightHalf, y: centreY - half * shrink },
    { x: centreX + rightHalf, y: centreY + half * shrink },
    { x: centreX - half, y: centreY + half },
  ];
}

/**
 * Project one rasterized COLOR_4 frame into a camera-sized image whose code
 * occupies exactly `pixelsPerModule * 172` pixels.
 */
export function renderSyntheticCameraFrame(
  cv: SyntheticCameraCv,
  options: SyntheticCameraOptions,
): SyntheticCameraFrame {
  const innerFrame = syntheticInnerFrame(options.profile, options.sequence);
  const encoded = wrapColor4Frame(innerFrame, {
    profileId: options.profile.id,
    paletteId: options.paletteId,
  });
  // Rasterize well above the target optical scale so the projection is a
  // downsample; upsampling a 1 px/module raster would invent sharpness the
  // sweep is trying to measure the absence of.
  const raster = rasterizeColor4(encoded.codedBytes, {
    profile: options.profile,
    paletteId: options.paletteId,
    sequence: options.sequence,
    moduleScale: 8,
  });
  const span = Math.round(options.pixelsPerModule * TOTAL_MODULES);
  // Leave a realistic margin of scene around the code rather than filling the
  // frame edge to edge.
  const width = options.cameraWidth ?? Math.max(640, Math.round(span * 1.45));
  const height = options.cameraHeight ?? Math.max(480, Math.round(span * 1.2));
  if (span + 8 > Math.min(width, height)) {
    throw new RangeError(
      `A ${options.pixelsPerModule} px/module frame needs a camera larger than ${width}x${height}.`,
    );
  }
  const quad = destinationQuad(width / 2, height / 2, span, options.angleDeg ?? 0);

  const source = cv.matFromImageData(
    new ImageData(Uint8ClampedArray.from(raster.pixels), raster.width, raster.height),
  );
  const sourcePoints = cv.matFromArray(4, 1, cv.CV_32FC2, [
    0, 0,
    raster.width - 1, 0,
    raster.width - 1, raster.height - 1,
    0, raster.height - 1,
  ]);
  const destinationPoints = cv.matFromArray(
    4,
    1,
    cv.CV_32FC2,
    quad.flatMap((point) => [point.x, point.y]),
  );
  const transform = cv.getPerspectiveTransform(sourcePoints, destinationPoints);
  const projected = new cv.Mat();
  let blurred: SyntheticCameraMat | undefined;
  try {
    cv.warpPerspective(
      source,
      projected,
      transform,
      new cv.Size(width, height),
      cv.INTER_LINEAR,
      cv.BORDER_CONSTANT,
      // A mid-grey surround, not white: a white border would merge with the
      // quiet zone and hand the detector a cleaner edge than a real scene does.
      new cv.Scalar(168, 168, 168, 255),
    );
    let selected = projected;
    if (options.blurKernel !== undefined) {
      blurred = new cv.Mat();
      cv.GaussianBlur(
        projected,
        blurred,
        new cv.Size(options.blurKernel, options.blurKernel),
        0,
        0,
        cv.BORDER_DEFAULT,
      );
      selected = blurred;
    }
    return {
      width,
      height,
      pixels: Uint8ClampedArray.from(selected.data),
      innerFrame,
      pixelsPerModule: span / TOTAL_MODULES,
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
