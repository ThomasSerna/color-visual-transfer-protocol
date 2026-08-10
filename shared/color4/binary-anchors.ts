import {
  FIDUCIALS,
  QUIET_MODULES,
  type FiducialId,
} from "./physical";

export interface BinaryAnchors {
  readonly black: number;
  readonly white: number;
}

export type BinaryAnchorsByFiducial = Readonly<Record<FiducialId, BinaryAnchors>>;

export type BinaryAnchorChannels = readonly [red: number, green: number, blue: number];

export interface RgbBinaryAnchors {
  readonly black: BinaryAnchorChannels;
  readonly white: BinaryAnchorChannels;
}

export type RgbBinaryAnchorsByFiducial = Readonly<Record<FiducialId, RgbBinaryAnchors>>;

export interface SpatialBinaryAnchorModel {
  readonly byFiducial: BinaryAnchorsByFiducial;
  atActive(x: number, y: number): BinaryAnchors;
  atLogical(x: number, y: number): BinaryAnchors;
}

export interface SpatialRgbBinaryAnchorModel {
  readonly byFiducial: RgbBinaryAnchorsByFiducial;
  atActive(x: number, y: number): RgbBinaryAnchors;
  atLogical(x: number, y: number): RgbBinaryAnchors;
}

export const MINIMUM_BINARY_CONTRAST = 40;

const ORDERED_FIDUCIAL_IDS: readonly FiducialId[] = Object.freeze(["TL", "TR", "BR", "BL"]);

function fiducialCenter(id: FiducialId): Readonly<{ x: number; y: number }> {
  const marker = FIDUCIALS.find((candidate) => candidate.id === id);
  if (marker === undefined) throw new Error(`Missing COLOR_4 fiducial ${id}.`);
  return Object.freeze({
    x: marker.x + (marker.width - 1) / 2,
    y: marker.y + (marker.height - 1) / 2,
  });
}

const TOP_LEFT_CENTER = fiducialCenter("TL");
const TOP_RIGHT_CENTER = fiducialCenter("TR");
const BOTTOM_RIGHT_CENTER = fiducialCenter("BR");
const BOTTOM_LEFT_CENTER = fiducialCenter("BL");
const HORIZONTAL_SPAN = TOP_RIGHT_CENTER.x - TOP_LEFT_CENTER.x;
const VERTICAL_SPAN = BOTTOM_LEFT_CENTER.y - TOP_LEFT_CENTER.y;

function hasRectangularFiducialCenters(): boolean {
  return HORIZONTAL_SPAN > 0 &&
    VERTICAL_SPAN > 0 &&
    BOTTOM_RIGHT_CENTER.x - BOTTOM_LEFT_CENTER.x === HORIZONTAL_SPAN &&
    BOTTOM_RIGHT_CENTER.y - TOP_RIGHT_CENTER.y === VERTICAL_SPAN;
}

function clampUnit(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function interpolate(left: number, right: number, position: number): number {
  return left + (right - left) * position;
}

function validAnchors(value: BinaryAnchors | undefined): value is BinaryAnchors {
  return value !== undefined &&
    Number.isFinite(value.black) &&
    Number.isFinite(value.white) &&
    value.white > value.black &&
    value.white - value.black >= MINIMUM_BINARY_CONTRAST;
}

function validRgbAnchors(value: RgbBinaryAnchors | undefined): value is RgbBinaryAnchors {
  if (value === undefined) return false;
  for (const channel of [0, 1, 2] as const) {
    const black = value.black[channel];
    const white = value.white[channel];
    if (!Number.isFinite(black) || !Number.isFinite(white) || !(white > black)) return false;
  }
  return true;
}

function interpolationPosition(
  x: number,
  y: number,
): Readonly<{ horizontal: number; vertical: number }> {
  return {
    horizontal: clampUnit((x - TOP_LEFT_CENTER.x) / HORIZONTAL_SPAN),
    vertical: clampUnit((y - TOP_LEFT_CENTER.y) / VERTICAL_SPAN),
  };
}

function interpolateCorners(
  topLeft: number,
  topRight: number,
  bottomRight: number,
  bottomLeft: number,
  horizontal: number,
  vertical: number,
): number {
  const top = interpolate(topLeft, topRight, horizontal);
  const bottom = interpolate(bottomLeft, bottomRight, horizontal);
  return interpolate(top, bottom, vertical);
}

/**
 * Build the strict binary photometric field used after canonical warping.
 * Every corner must provide its own trustworthy black/white pair; there is no
 * global or permissive fallback when a local pair is degenerate.
 */
export function createSpatialBinaryAnchorModel(
  input: BinaryAnchorsByFiducial,
): SpatialBinaryAnchorModel | null {
  const byFiducial = {} as Record<FiducialId, BinaryAnchors>;
  for (const id of ORDERED_FIDUCIAL_IDS) {
    const anchors = input[id];
    if (!validAnchors(anchors)) return null;
    byFiducial[id] = Object.freeze({ black: anchors.black, white: anchors.white });
  }
  const frozenByFiducial = Object.freeze(byFiducial);
  if (!hasRectangularFiducialCenters()) return null;

  const atActive = (x: number, y: number): BinaryAnchors => {
    const { horizontal, vertical } = interpolationPosition(x, y);
    const black = interpolateCorners(
      frozenByFiducial.TL.black,
      frozenByFiducial.TR.black,
      frozenByFiducial.BR.black,
      frozenByFiducial.BL.black,
      horizontal,
      vertical,
    );
    const white = interpolateCorners(
      frozenByFiducial.TL.white,
      frozenByFiducial.TR.white,
      frozenByFiducial.BR.white,
      frozenByFiducial.BL.white,
      horizontal,
      vertical,
    );
    return {
      black,
      white,
    };
  };

  return Object.freeze({
    byFiducial: frozenByFiducial,
    atActive,
    atLogical: (x: number, y: number) => atActive(x - QUIET_MODULES, y - QUIET_MODULES),
  });
}

/**
 * Per-channel companion used to decide whether a quiet-zone module is locally
 * white rather than merely bright. Luminance contrast remains the geometry
 * gate; each RGB channel must still provide an ordered finite local response.
 */
export function createSpatialRgbBinaryAnchorModel(
  input: RgbBinaryAnchorsByFiducial,
): SpatialRgbBinaryAnchorModel | null {
  const byFiducial = {} as Record<FiducialId, RgbBinaryAnchors>;
  for (const id of ORDERED_FIDUCIAL_IDS) {
    const anchors = input[id];
    if (!validRgbAnchors(anchors)) return null;
    byFiducial[id] = Object.freeze({
      black: Object.freeze(
        [anchors.black[0], anchors.black[1], anchors.black[2]] as BinaryAnchorChannels,
      ),
      white: Object.freeze(
        [anchors.white[0], anchors.white[1], anchors.white[2]] as BinaryAnchorChannels,
      ),
    });
  }
  const frozenByFiducial = Object.freeze(byFiducial);
  if (!hasRectangularFiducialCenters()) return null;

  const atActive = (x: number, y: number): RgbBinaryAnchors => {
    const { horizontal, vertical } = interpolationPosition(x, y);
    const interpolateChannel = (
      field: keyof RgbBinaryAnchors,
      channel: 0 | 1 | 2,
    ): number => interpolateCorners(
      frozenByFiducial.TL[field][channel],
      frozenByFiducial.TR[field][channel],
      frozenByFiducial.BR[field][channel],
      frozenByFiducial.BL[field][channel],
      horizontal,
      vertical,
    );
    const interpolateChannels = (field: keyof RgbBinaryAnchors): BinaryAnchorChannels =>
      Object.freeze([
        interpolateChannel(field, 0),
        interpolateChannel(field, 1),
        interpolateChannel(field, 2),
      ]);
    return Object.freeze({
      black: interpolateChannels("black"),
      white: interpolateChannels("white"),
    });
  };

  return Object.freeze({
    byFiducial: frozenByFiducial,
    atActive,
    atLogical: (x: number, y: number) => atActive(x - QUIET_MODULES, y - QUIET_MODULES),
  });
}
