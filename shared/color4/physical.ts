import type { Color4Profile } from "./profiles";
import { crc8Atm } from "./crc";

export { crc8Atm } from "./crc";

/**
 * COLOR_4/1 canonical geometry.
 *
 * Coordinates in this module are logical modules inside the 160 x 160 active
 * square. Rasterizers add QUIET_MODULES on every side. Keeping the geometry in
 * integer modules makes the normative raster deterministic and lets a camera
 * worker hand a homography-normalized ROI to the pure decoder.
 */
export const ACTIVE_MODULES = 160;
export const QUIET_MODULES = 6;
export const TOTAL_MODULES = ACTIVE_MODULES + 2 * QUIET_MODULES;
export const QUIET_ZONE_FRACTION = QUIET_MODULES / TOTAL_MODULES;

export const BOOTSTRAP_MAGIC = 0b110101;
export const PHY_VERSION = 1;
export const BOOTSTRAP_COLUMNS = 24;
export const BOOTSTRAP_ROWS = 3;

export type Rgb = readonly [red: number, green: number, blue: number];
export type PaletteId = 0 | 1;
export type Dibit = 0 | 1 | 2 | 3;

export interface Color4Palette {
  readonly id: PaletteId;
  readonly name: "KCMY" | "KRGB";
  /** Array index is the numeric value of the two transmitted bits. */
  readonly colors: readonly [Rgb, Rgb, Rgb, Rgb];
}

const K: Rgb = [0x10, 0x10, 0x10];
const C: Rgb = [0x00, 0xd8, 0xd8];
const M: Rgb = [0xd8, 0x00, 0xd8];
const Y: Rgb = [0xd8, 0xd8, 0x00];

/** Stable palette. Dibits are K, C, M, Y in wire order 00, 01, 10, 11. */
const KCMY_COLORS: readonly [Rgb, Rgb, Rgb, Rgb] = Object.freeze([K, C, M, Y]);
export const KCMY_PALETTE: Color4Palette = Object.freeze({
  id: 0,
  name: "KCMY",
  colors: KCMY_COLORS,
});

/** Experimental comparison palette. Blue is intentionally not the default. */
const KRGB_COLORS: readonly [Rgb, Rgb, Rgb, Rgb] = Object.freeze([
  K,
  [0xd8, 0x00, 0x00] as const,
  [0x00, 0xd8, 0x00] as const,
  [0x00, 0x00, 0xd8] as const,
]);
export const KRGB_PALETTE: Color4Palette = Object.freeze({
  id: 1,
  name: "KRGB",
  colors: KRGB_COLORS,
});

export const COLOR4_PALETTES: readonly Color4Palette[] = Object.freeze([
  KCMY_PALETTE,
  KRGB_PALETTE,
]);

export function getColor4Palette(id: number): Color4Palette | undefined {
  return COLOR4_PALETTES.find((palette) => palette.id === id);
}

export type CalibrationSwatchName = "K" | "W" | "C" | "M" | "Y" | "G50";

/**
 * Both palettes use the same references. RGB primaries are reconstructed from
 * W-C, W-M and W-Y by the classifier, so the experimental palette does not
 * need a second physical layout.
 */
export const CALIBRATION_SWATCHES: readonly Readonly<{
  name: CalibrationSwatchName;
  color: Rgb;
}>[] = Object.freeze([
  Object.freeze({ name: "K", color: K }),
  Object.freeze({ name: "W", color: [0xff, 0xff, 0xff] as const }),
  Object.freeze({ name: "C", color: C }),
  Object.freeze({ name: "M", color: M }),
  Object.freeze({ name: "Y", color: Y }),
  Object.freeze({ name: "G50", color: [0x80, 0x80, 0x80] as const }),
]);

export interface ModuleRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export type FiducialId = "TL" | "TR" | "BR" | "BL";

export interface FiducialPlacement extends ModuleRect {
  readonly id: FiducialId;
  readonly payload: readonly string[];
}

/**
 * Frozen 5 x 5 payload fixtures. Including every 90-degree rotation, the
 * minimum Hamming distance between different IDs is 10. Each payload is also
 * at least distance 10 from its own non-zero rotations, pinning orientation.
 */
export const FIDUCIAL_PAYLOADS: Readonly<Record<FiducialId, readonly string[]>> =
  Object.freeze({
    TL: Object.freeze(["10111", "01000", "11011", "11001", "01101"]),
    TR: Object.freeze(["11101", "11101", "11100", "10010", "01010"]),
    BR: Object.freeze(["00001", "11100", "11110", "01000", "01100"]),
    BL: Object.freeze(["11100", "00010", "00010", "10110", "00010"]),
  });

const FIDUCIAL_SIZE = 9;
const FIDUCIAL_NEAR = 7;
const FIDUCIAL_FAR = ACTIVE_MODULES - FIDUCIAL_NEAR - FIDUCIAL_SIZE;

export const FIDUCIALS: readonly FiducialPlacement[] = Object.freeze([
  Object.freeze({
    id: "TL",
    x: FIDUCIAL_NEAR,
    y: FIDUCIAL_NEAR,
    width: FIDUCIAL_SIZE,
    height: FIDUCIAL_SIZE,
    payload: FIDUCIAL_PAYLOADS.TL,
  }),
  Object.freeze({
    id: "TR",
    x: FIDUCIAL_FAR,
    y: FIDUCIAL_NEAR,
    width: FIDUCIAL_SIZE,
    height: FIDUCIAL_SIZE,
    payload: FIDUCIAL_PAYLOADS.TR,
  }),
  Object.freeze({
    id: "BR",
    x: FIDUCIAL_FAR,
    y: FIDUCIAL_FAR,
    width: FIDUCIAL_SIZE,
    height: FIDUCIAL_SIZE,
    payload: FIDUCIAL_PAYLOADS.BR,
  }),
  Object.freeze({
    id: "BL",
    x: FIDUCIAL_NEAR,
    y: FIDUCIAL_FAR,
    width: FIDUCIAL_SIZE,
    height: FIDUCIAL_SIZE,
    payload: FIDUCIAL_PAYLOADS.BL,
  }),
]);

export interface CalibrationPlacement extends ModuleRect {
  readonly name: CalibrationSwatchName;
  readonly color: Rgb;
}

export interface PhysicalLayout {
  readonly activeModules: number;
  readonly quietModules: number;
  readonly totalModules: number;
  readonly data: ModuleRect;
  readonly bootstrap: ModuleRect;
  readonly timing: Readonly<{
    top: ModuleRect;
    right: ModuleRect;
    bottom: ModuleRect;
    left: ModuleRect;
  }>;
  readonly phasePilots: Readonly<{ top: ModuleRect; bottom: ModuleRect }>;
  readonly calibration: Readonly<{
    left: readonly CalibrationPlacement[];
    right: readonly CalibrationPlacement[];
  }>;
  readonly fiducials: readonly FiducialPlacement[];
}

const BOOTSTRAP_RECT: ModuleRect = Object.freeze({
  x: (ACTIVE_MODULES - BOOTSTRAP_COLUMNS) / 2,
  y: 14,
  width: BOOTSTRAP_COLUMNS,
  height: BOOTSTRAP_ROWS,
});

function calibrationBank(x: number, data: ModuleRect): readonly CalibrationPlacement[] {
  return Object.freeze(
    CALIBRATION_SWATCHES.map((swatch, index) => {
      const center = data.y + Math.floor(((index + 0.5) * data.height) / 6);
      return Object.freeze({
        name: swatch.name,
        color: swatch.color,
        x,
        y: center - 1,
        width: 2,
        height: 2,
      });
    }),
  );
}

export function createPhysicalLayout(
  profile: Pick<Color4Profile, "columns" | "rows">,
): PhysicalLayout {
  const { columns, rows } = profile;
  if (!Number.isInteger(columns) || !Number.isInteger(rows) || columns <= 0 || rows <= 0) {
    throw new RangeError("COLOR_4 grid dimensions must be positive integers.");
  }
  if (columns > 120 || rows > 119 || (columns * rows) % 4 !== 0) {
    throw new RangeError("COLOR_4 grid does not fit the canonical physical frame.");
  }

  const data: ModuleRect = Object.freeze({
    x: Math.floor((ACTIVE_MODULES - columns) / 2),
    y: Math.floor((ACTIVE_MODULES - rows) / 2),
    width: columns,
    height: rows,
  });
  const pilotX = data.x + Math.floor(data.width / 2) - 2;
  const timing = Object.freeze({
    top: Object.freeze({ x: data.x, y: data.y - 1, width: data.width, height: 1 }),
    right: Object.freeze({ x: data.x + data.width, y: data.y, width: 1, height: data.height }),
    bottom: Object.freeze({ x: data.x, y: data.y + data.height, width: data.width, height: 1 }),
    left: Object.freeze({ x: data.x - 1, y: data.y, width: 1, height: data.height }),
  });
  const phasePilots = Object.freeze({
    top: Object.freeze({ x: pilotX, y: data.y - 3, width: 4, height: 1 }),
    bottom: Object.freeze({ x: pilotX, y: data.y + data.height + 2, width: 4, height: 1 }),
  });
  const calibration = Object.freeze({
    left: calibrationBank(data.x - 5, data),
    right: calibrationBank(data.x + data.width + 3, data),
  });

  return Object.freeze({
    activeModules: ACTIVE_MODULES,
    quietModules: QUIET_MODULES,
    totalModules: TOTAL_MODULES,
    data,
    bootstrap: BOOTSTRAP_RECT,
    timing,
    phasePilots,
    calibration,
    fiducials: FIDUCIALS,
  });
}

/** 9 x 9 marker: black border, white ring, then the frozen 5 x 5 ID. */
export function fiducialModule(id: FiducialId, x: number, y: number): 0 | 1 {
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || x >= 9 || y < 0 || y >= 9) {
    throw new RangeError("Fiducial coordinates must be inside a 9 x 9 marker.");
  }
  if (x === 0 || y === 0 || x === 8 || y === 8) return 1;
  if (x === 1 || y === 1 || x === 7 || y === 7) return 0;
  return FIDUCIAL_PAYLOADS[id][y - 2]![x - 2] === "1" ? 1 : 0;
}

export interface BootstrapFields {
  readonly version: number;
  readonly profileId: number;
  readonly paletteId: number;
  readonly sequencePhase: 0 | 1 | 2 | 3;
}

function grayPhase(phase: number): number {
  return phase ^ (phase >>> 1);
}

function phaseFromGray(gray: number): 0 | 1 | 2 | 3 {
  return [0, 1, 3, 2][gray]! as 0 | 1 | 2 | 3;
}

/**
 * Returns the normative 24 x 3 row-major bootstrap modules. Rows are
 * word/complement/word; bytes and bits are transmitted most-significant first.
 */
export function encodeBootstrap(fields: BootstrapFields): Uint8Array {
  const { version, profileId, paletteId, sequencePhase } = fields;
  if (!Number.isInteger(version) || version < 0 || version > 3) {
    throw new RangeError("Bootstrap version must fit two bits.");
  }
  if (!Number.isInteger(profileId) || profileId < 0 || profileId > 7) {
    throw new RangeError("Bootstrap profile id must fit three bits.");
  }
  if (!Number.isInteger(paletteId) || paletteId < 0 || paletteId > 3) {
    throw new RangeError("Bootstrap palette id must fit two bits.");
  }
  if (!Number.isInteger(sequencePhase) || sequencePhase < 0 || sequencePhase > 3) {
    throw new RangeError("Bootstrap sequence phase must fit two bits.");
  }

  const word =
    (BOOTSTRAP_MAGIC << 10) |
    (version << 8) |
    (profileId << 5) |
    (paletteId << 3) |
    (grayPhase(sequencePhase) << 1);
  const bytes = new Uint8Array([word >>> 8, word & 0xff, 0]);
  bytes[2] = crc8Atm(bytes.subarray(0, 2));

  const out = new Uint8Array(BOOTSTRAP_COLUMNS * BOOTSTRAP_ROWS);
  for (let column = 0; column < BOOTSTRAP_COLUMNS; column++) {
    const bit = (bytes[column >>> 3]! >>> (7 - (column & 7))) & 1;
    out[column] = bit;
    out[BOOTSTRAP_COLUMNS + column] = bit ^ 1;
    out[2 * BOOTSTRAP_COLUMNS + column] = bit;
  }
  return out;
}

/**
 * Decodes row-major bootstrap samples. A value other than 0 or 1 is treated as
 * uncertain; at least two agreeing rows are required for every bit.
 */
export function decodeBootstrap(modules: ArrayLike<number>): BootstrapFields | null {
  if (modules.length !== BOOTSTRAP_COLUMNS * BOOTSTRAP_ROWS) return null;
  const bytes = new Uint8Array(3);
  for (let column = 0; column < BOOTSTRAP_COLUMNS; column++) {
    let zeros = 0;
    let ones = 0;
    for (let row = 0; row < BOOTSTRAP_ROWS; row++) {
      const sampled = modules[row * BOOTSTRAP_COLUMNS + column];
      if (sampled !== 0 && sampled !== 1) continue;
      const bit = row === 1 ? sampled ^ 1 : sampled;
      if (bit === 0) zeros++;
      else ones++;
    }
    if (zeros < 2 && ones < 2) return null;
    const bit = ones > zeros ? 1 : 0;
    const byteIndex = column >>> 3;
    bytes[byteIndex] = bytes[byteIndex]! | (bit << (7 - (column & 7)));
  }
  if (crc8Atm(bytes.subarray(0, 2)) !== bytes[2]) return null;

  const word = (bytes[0]! << 8) | bytes[1]!;
  if ((word >>> 10) !== BOOTSTRAP_MAGIC || (word & 1) !== 0) return null;
  const gray = (word >>> 1) & 0x03;
  return Object.freeze({
    version: (word >>> 8) & 0x03,
    profileId: (word >>> 5) & 0x07,
    paletteId: (word >>> 3) & 0x03,
    sequencePhase: phaseFromGray(gray),
  });
}

/** Four black/white modules: Gray-code bits repeated twice. */
export function encodePhasePilot(sequencePhase: number): Uint8Array {
  if (!Number.isInteger(sequencePhase) || sequencePhase < 0 || sequencePhase > 3) {
    throw new RangeError("Phase pilot must fit two bits.");
  }
  const gray = grayPhase(sequencePhase);
  return new Uint8Array([(gray >>> 1) & 1, gray & 1, (gray >>> 1) & 1, gray & 1]);
}

export function decodePhasePilot(modules: ArrayLike<number>): 0 | 1 | 2 | 3 | null {
  if (modules.length !== 4) return null;
  const high = modules[0] === modules[2] ? modules[0] : -1;
  const low = modules[1] === modules[3] ? modules[1] : -1;
  if ((high !== 0 && high !== 1) || (low !== 0 && low !== 1)) return null;
  return phaseFromGray((high << 1) | low);
}
