import {
  COLOR4_PROFILES,
  getColor4Profile,
  type Color4Profile,
} from "./profiles";
import {
  ACTIVE_MODULES,
  BOOTSTRAP_COLUMNS,
  BOOTSTRAP_ROWS,
  FIDUCIALS,
  PHY_VERSION,
  QUIET_MODULES,
  TOTAL_MODULES,
  createPhysicalLayout,
  decodeBootstrap,
  decodePhasePilot,
  fiducialModule,
  getColor4Palette,
  type CalibrationPlacement,
  type CalibrationSwatchName,
  type Dibit,
  type ModuleRect,
  type PhysicalLayout,
} from "./physical";

export interface CanonicalRasterImage {
  readonly width: number;
  readonly height: number;
  /** Row-major RGBA bytes, as produced by ImageData. */
  readonly pixels: Uint8Array | Uint8ClampedArray;
}

export interface LabColor {
  readonly l: number;
  readonly a: number;
  readonly b: number;
}

type FloatRgb = readonly [red: number, green: number, blue: number];

export interface ClassifierThresholds {
  /** Minimum observed white/black luminance range on both calibration banks. */
  readonly minimumContrast: number;
  /** Minimum CIE76 distance between any two palette centroids. */
  readonly minimumPaletteDistance: number;
  /** Baseline maximum distance from a cell to its winning centroid. */
  readonly maximumDeltaE: number;
  /** Baseline gap between the closest and second-closest centroids. */
  readonly minimumDeltaEGap: number;
  /** Marker mismatches tolerated after canonical normalization. */
  readonly maximumFiducialErrors: number;
  /** Maximum fraction of timing-rail modules that may be wrong or uncertain. */
  readonly maximumTimingErrorRate: number;
}

export const DEFAULT_CLASSIFIER_THRESHOLDS: ClassifierThresholds = Object.freeze({
  minimumContrast: 40,
  minimumPaletteDistance: 12,
  maximumDeltaE: 24,
  minimumDeltaEGap: 6,
  maximumFiducialErrors: 8,
  maximumTimingErrorRate: 0.08,
});

export type CanonicalRasterRejectReason =
  | "invalid_dimensions"
  | "invalid_geometry"
  | "invalid_bootstrap"
  | "unsupported_version"
  | "unsupported_profile"
  | "unsupported_palette"
  | "phase_mismatch"
  | "calibration_failed";

export interface CanonicalRasterDiagnostics {
  readonly moduleScale: number;
  readonly fiducialErrors: number;
  readonly quietZoneErrors: number;
  readonly timingErrors: number;
  readonly timingModules: number;
  readonly calibrationMad: number;
  readonly observedContrast: number;
  readonly minimumPaletteDistance: number;
  readonly uncertainCells: number;
  readonly erasureBytes: number;
  readonly meanBestDeltaE: number;
  readonly maximumBestDeltaE: number;
}

export interface ValidCanonicalRaster {
  readonly status: "valid";
  readonly profile: Color4Profile;
  readonly paletteId: 0 | 1;
  readonly sequencePhase: 0 | 1 | 2 | 3;
  /** Whitened/interleaved coded stream, ready for unwrapColor4Frame(). */
  readonly codedBytes: Uint8Array;
  /** Global coded-stream byte indices; accepted directly by the core decoder. */
  readonly byteErasures: Uint16Array;
  readonly diagnostics: CanonicalRasterDiagnostics;
}

export interface RejectedCanonicalRaster {
  readonly status: "rejected";
  readonly reason: CanonicalRasterRejectReason;
  readonly diagnostics: CanonicalRasterDiagnostics;
}

export type CanonicalRasterResult = ValidCanonicalRaster | RejectedCanonicalRaster;

export interface DecodeCanonicalRasterOptions {
  /** Defaults to the normative COLOR4_PROFILES registry. */
  readonly profiles?: readonly Color4Profile[];
  readonly thresholds?: Partial<ClassifierThresholds>;
}

interface MutableDiagnostics {
  moduleScale: number;
  fiducialErrors: number;
  quietZoneErrors: number;
  timingErrors: number;
  timingModules: number;
  calibrationMad: number;
  observedContrast: number;
  minimumPaletteDistance: number;
  uncertainCells: number;
  erasureBytes: number;
  meanBestDeltaE: number;
  maximumBestDeltaE: number;
}

interface BankSamples {
  readonly K: FloatRgb;
  readonly W: FloatRgb;
  readonly C: FloatRgb;
  readonly M: FloatRgb;
  readonly Y: FloatRgb;
  readonly G50: FloatRgb;
  readonly modules: Readonly<Record<CalibrationSwatchName, readonly FloatRgb[]>>;
}

interface CalibrationModel {
  readonly left: BankSamples;
  readonly right: BankSamples;
  readonly mad: number;
  readonly contrast: number;
  readonly minimumPaletteDistance: number;
}

function diagnostics(initial?: Partial<MutableDiagnostics>): MutableDiagnostics {
  return {
    moduleScale: 0,
    fiducialErrors: 0,
    quietZoneErrors: 0,
    timingErrors: 0,
    timingModules: 0,
    calibrationMad: 0,
    observedContrast: 0,
    minimumPaletteDistance: 0,
    uncertainCells: 0,
    erasureBytes: 0,
    meanBestDeltaE: 0,
    maximumBestDeltaE: 0,
    ...initial,
  };
}

function freezeDiagnostics(value: MutableDiagnostics): CanonicalRasterDiagnostics {
  return Object.freeze({ ...value });
}

function rejected(
  reason: CanonicalRasterRejectReason,
  value: MutableDiagnostics,
): RejectedCanonicalRaster {
  return Object.freeze({ status: "rejected", reason, diagnostics: freezeDiagnostics(value) });
}

function median(values: readonly number[]): number {
  if (values.length === 0) throw new RangeError("Cannot take the median of an empty sample.");
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >>> 1;
  return sorted.length & 1
    ? sorted[middle]!
    : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function medianRgb(values: readonly FloatRgb[]): FloatRgb {
  return [
    median(values.map((value) => value[0])),
    median(values.map((value) => value[1])),
    median(values.map((value) => value[2])),
  ];
}

function luminance(rgb: FloatRgb): number {
  return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function mix(left: number, right: number, position: number): number {
  return left + (right - left) * position;
}

function mixRgb(left: FloatRgb, right: FloatRgb, position: number): FloatRgb {
  return [
    mix(left[0], right[0], position),
    mix(left[1], right[1], position),
    mix(left[2], right[2], position),
  ];
}

/** Convert normalized sRGB (0..1 per channel) to CIE Lab using a D65 white. */
export function normalizedRgbToLab(rgb: FloatRgb): LabColor {
  const linear = rgb.map((channel) =>
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
  );
  const x = linear[0]! * 0.4124564 + linear[1]! * 0.3575761 + linear[2]! * 0.1804375;
  const y = linear[0]! * 0.2126729 + linear[1]! * 0.7151522 + linear[2]! * 0.072175;
  const z = linear[0]! * 0.0193339 + linear[1]! * 0.119192 + linear[2]! * 0.9503041;
  const transform = (component: number): number =>
    component > 216 / 24389
      ? Math.cbrt(component)
      : (841 / 108) * component + 4 / 29;
  const fx = transform(x / 0.95047);
  const fy = transform(y);
  const fz = transform(z / 1.08883);
  return { l: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) };
}

export function deltaE76(left: LabColor, right: LabColor): number {
  return Math.hypot(left.l - right.l, left.a - right.a, left.b - right.b);
}

interface ModuleSampler {
  readonly scale: number;
  sampleActive(x: number, y: number): FloatRgb;
  sampleLogical(x: number, y: number): FloatRgb;
}

function createSampler(image: CanonicalRasterImage, scale: number): ModuleSampler {
  const sampleLogical = (logicalX: number, logicalY: number): FloatRgb => {
    const inset = Math.floor(scale / 4);
    const span = Math.max(1, scale - 2 * inset);
    const reds: number[] = [];
    const greens: number[] = [];
    const blues: number[] = [];
    const startX = logicalX * scale + inset;
    const startY = logicalY * scale + inset;
    for (let y = 0; y < span; y++) {
      for (let x = 0; x < span; x++) {
        const offset = ((startY + y) * image.width + startX + x) * 4;
        reds.push(image.pixels[offset]!);
        greens.push(image.pixels[offset + 1]!);
        blues.push(image.pixels[offset + 2]!);
      }
    }
    return [median(reds), median(greens), median(blues)];
  };
  return {
    scale,
    sampleLogical,
    sampleActive: (x, y) => sampleLogical(x + QUIET_MODULES, y + QUIET_MODULES),
  };
}

function collectBinaryAnchors(sampler: ModuleSampler): { black: number; white: number } {
  const dark: number[] = [];
  const light: number[] = [];
  for (const marker of FIDUCIALS) {
    for (let y = 0; y < 9; y++) {
      for (let x = 0; x < 9; x++) {
        const isBorder = x === 0 || y === 0 || x === 8 || y === 8;
        const isRing = !isBorder && (x === 1 || y === 1 || x === 7 || y === 7);
        if (!isBorder && !isRing) continue;
        const value = luminance(sampler.sampleActive(marker.x + x, marker.y + y));
        (isBorder ? dark : light).push(value);
      }
    }
  }
  return { black: median(dark), white: median(light) };
}

function binaryModule(rgb: FloatRgb, anchors: { black: number; white: number }): 0 | 1 | -1 {
  const range = anchors.white - anchors.black;
  if (range <= 0) return -1;
  const normalized = (luminance(rgb) - anchors.black) / range;
  if (normalized <= 0.35) return 1;
  if (normalized >= 0.65) return 0;
  return -1;
}

function sampleBinaryRect(
  sampler: ModuleSampler,
  rect: ModuleRect,
  anchors: { black: number; white: number },
): Int8Array {
  const out = new Int8Array(rect.width * rect.height);
  for (let y = 0; y < rect.height; y++) {
    for (let x = 0; x < rect.width; x++) {
      out[y * rect.width + x] = binaryModule(
        sampler.sampleActive(rect.x + x, rect.y + y),
        anchors,
      );
    }
  }
  return out;
}

function countFiducialErrors(
  sampler: ModuleSampler,
  anchors: { black: number; white: number },
): number {
  let errors = 0;
  for (const marker of FIDUCIALS) {
    for (let y = 0; y < 9; y++) {
      for (let x = 0; x < 9; x++) {
        const sampled = binaryModule(sampler.sampleActive(marker.x + x, marker.y + y), anchors);
        if (sampled !== fiducialModule(marker.id, x, y)) errors++;
      }
    }
  }
  return errors;
}

function countQuietZoneErrors(
  sampler: ModuleSampler,
  anchors: { black: number; white: number },
): number {
  const points = [
    [0, 0],
    [TOTAL_MODULES - 1, 0],
    [TOTAL_MODULES - 1, TOTAL_MODULES - 1],
    [0, TOTAL_MODULES - 1],
    [Math.floor(TOTAL_MODULES / 2), 0],
    [TOTAL_MODULES - 1, Math.floor(TOTAL_MODULES / 2)],
    [Math.floor(TOTAL_MODULES / 2), TOTAL_MODULES - 1],
    [0, Math.floor(TOTAL_MODULES / 2)],
  ] as const;
  return points.reduce(
    (total, point) =>
      total + (binaryModule(sampler.sampleLogical(point[0], point[1]), anchors) === 0 ? 0 : 1),
    0,
  );
}

function countTimingErrors(
  sampler: ModuleSampler,
  layout: PhysicalLayout,
  anchors: { black: number; white: number },
): { errors: number; modules: number } {
  let errors = 0;
  let modules = 0;
  const check = (x: number, y: number, expected: 0 | 1): void => {
    modules++;
    if (binaryModule(sampler.sampleActive(x, y), anchors) !== expected) errors++;
  };
  for (let x = 0; x < layout.data.width; x++) {
    const top = (x & 1) === 0 ? 1 : 0;
    check(layout.timing.top.x + x, layout.timing.top.y, top);
    check(layout.timing.bottom.x + x, layout.timing.bottom.y, top === 1 ? 0 : 1);
  }
  for (let y = 0; y < layout.data.height; y++) {
    const left = (y & 1) === 0 ? 1 : 0;
    check(layout.timing.left.x, layout.timing.left.y + y, left);
    check(layout.timing.right.x, layout.timing.right.y + y, left === 1 ? 0 : 1);
  }
  return { errors, modules };
}

function samplesForPlacement(
  sampler: ModuleSampler,
  placement: CalibrationPlacement,
): readonly FloatRgb[] {
  const out: FloatRgb[] = [];
  for (let y = 0; y < placement.height; y++) {
    for (let x = 0; x < placement.width; x++) {
      out.push(sampler.sampleActive(placement.x + x, placement.y + y));
    }
  }
  return out;
}

function sampleBank(
  sampler: ModuleSampler,
  placements: readonly CalibrationPlacement[],
): BankSamples {
  const modules = {} as Record<CalibrationSwatchName, readonly FloatRgb[]>;
  const centers = {} as Record<CalibrationSwatchName, FloatRgb>;
  for (const placement of placements) {
    const values = samplesForPlacement(sampler, placement);
    modules[placement.name] = values;
    centers[placement.name] = medianRgb(values);
  }
  return {
    K: centers.K,
    W: centers.W,
    C: centers.C,
    M: centers.M,
    Y: centers.Y,
    G50: centers.G50,
    modules,
  };
}

function normalizedWithAnchors(sample: FloatRgb, black: FloatRgb, white: FloatRgb): FloatRgb {
  return [
    clamp01((sample[0] - black[0]) / Math.max(1, white[0] - black[0])),
    clamp01((sample[1] - black[1]) / Math.max(1, white[1] - black[1])),
    clamp01((sample[2] - black[2]) / Math.max(1, white[2] - black[2])),
  ];
}

function normalizedBankColor(bank: BankSamples, name: CalibrationSwatchName): FloatRgb {
  return normalizedWithAnchors(bank[name], bank.K, bank.W);
}

function paletteTargets(bank: BankSamples, paletteId: 0 | 1): readonly FloatRgb[] {
  const black: FloatRgb = [0, 0, 0];
  const cyan = normalizedBankColor(bank, "C");
  const magenta = normalizedBankColor(bank, "M");
  const yellow = normalizedBankColor(bank, "Y");
  if (paletteId === 0) return [black, cyan, magenta, yellow];
  return [
    black,
    [1 - cyan[0], 1 - cyan[1], 1 - cyan[2]],
    [1 - magenta[0], 1 - magenta[1], 1 - magenta[2]],
    [1 - yellow[0], 1 - yellow[1], 1 - yellow[2]],
  ];
}

function targetAt(model: CalibrationModel, paletteId: 0 | 1, dibit: number, x: number): FloatRgb {
  const left = paletteTargets(model.left, paletteId)[dibit]!;
  const right = paletteTargets(model.right, paletteId)[dibit]!;
  return mixRgb(left, right, x);
}

function minimumTargetDistance(
  left: BankSamples,
  right: BankSamples,
  paletteId: 0 | 1,
): number {
  let minimum = Number.POSITIVE_INFINITY;
  const placeholder: CalibrationModel = {
    left,
    right,
    mad: 0,
    contrast: 0,
    minimumPaletteDistance: 0,
  };
  for (const position of [0, 0.5, 1]) {
    const labs = [0, 1, 2, 3].map((dibit) =>
      normalizedRgbToLab(targetAt(placeholder, paletteId, dibit, position)),
    );
    for (let first = 0; first < labs.length; first++) {
      for (let second = first + 1; second < labs.length; second++) {
        minimum = Math.min(minimum, deltaE76(labs[first]!, labs[second]!));
      }
    }
  }
  return minimum;
}

function bankMad(bank: BankSamples): number {
  const distances: number[] = [];
  for (const name of ["K", "W", "C", "M", "Y", "G50"] as const) {
    const center = normalizedBankColor(bank, name);
    const centerLab = normalizedRgbToLab(center);
    for (const sample of bank.modules[name]) {
      const normalized = normalizedWithAnchors(sample, bank.K, bank.W);
      distances.push(deltaE76(normalizedRgbToLab(normalized), centerLab));
    }
  }
  const center = median(distances);
  return median(distances.map((distance) => Math.abs(distance - center)));
}

function buildCalibration(
  sampler: ModuleSampler,
  layout: PhysicalLayout,
  paletteId: 0 | 1,
): CalibrationModel {
  const left = sampleBank(sampler, layout.calibration.left);
  const right = sampleBank(sampler, layout.calibration.right);
  return {
    left,
    right,
    mad: Math.max(bankMad(left), bankMad(right)),
    contrast: Math.min(luminance(left.W) - luminance(left.K), luminance(right.W) - luminance(right.K)),
    minimumPaletteDistance: minimumTargetDistance(left, right, paletteId),
  };
}

export interface LabClassification {
  readonly dibit: Dibit;
  readonly erased: boolean;
  readonly bestDeltaE: number;
  readonly secondDeltaE: number;
}

/** Classify one normalized RGB cell against four normalized RGB centroids. */
export function classifyLabCell(
  sample: FloatRgb,
  centroids: readonly FloatRgb[],
  maximumDeltaE: number,
  minimumGap: number,
): LabClassification {
  if (centroids.length !== 4) throw new RangeError("COLOR_4 needs exactly four centroids.");
  const sampleLab = normalizedRgbToLab(sample);
  const ranked = centroids
    .map((centroid, dibit) => ({
      dibit: dibit as Dibit,
      distance: deltaE76(sampleLab, normalizedRgbToLab(centroid)),
    }))
    .sort((left, right) => left.distance - right.distance);
  const best = ranked[0]!;
  const second = ranked[1]!;
  return {
    dibit: best.dibit,
    erased: best.distance > maximumDeltaE || second.distance - best.distance < minimumGap,
    bestDeltaE: best.distance,
    secondDeltaE: second.distance,
  };
}

function interpolatedAnchors(model: CalibrationModel, position: number): {
  black: FloatRgb;
  white: FloatRgb;
} {
  return {
    black: mixRgb(model.left.K, model.right.K, position),
    white: mixRgb(model.left.W, model.right.W, position),
  };
}

function resolveProfile(
  id: number,
  profiles: readonly Color4Profile[] | undefined,
): Color4Profile | undefined {
  if (profiles === undefined || profiles === COLOR4_PROFILES) return getColor4Profile(id);
  return profiles.find((profile) => profile.id === id);
}

/**
 * Decode a square, orientation-correct, homography-normalized COLOR_4 raster.
 * Camera location and perspective recovery intentionally live outside this
 * pure routine. The returned erasure indices feed unwrapColor4Frame directly.
 */
export function decodeCanonicalColor4Raster(
  image: CanonicalRasterImage,
  options: DecodeCanonicalRasterOptions = {},
): CanonicalRasterResult {
  const values = diagnostics();
  if (
    !Number.isInteger(image.width) ||
    !Number.isInteger(image.height) ||
    image.width <= 0 ||
    image.width !== image.height ||
    image.width % TOTAL_MODULES !== 0 ||
    image.pixels.length < image.width * image.height * 4
  ) {
    return rejected("invalid_dimensions", values);
  }
  const scale = image.width / TOTAL_MODULES;
  values.moduleScale = scale;
  const sampler = createSampler(image, scale);
  const anchors = collectBinaryAnchors(sampler);
  if (anchors.white - anchors.black < 40) return rejected("invalid_geometry", values);

  const thresholds: ClassifierThresholds = {
    ...DEFAULT_CLASSIFIER_THRESHOLDS,
    ...options.thresholds,
  };
  values.fiducialErrors = countFiducialErrors(sampler, anchors);
  values.quietZoneErrors = countQuietZoneErrors(sampler, anchors);
  if (values.fiducialErrors > thresholds.maximumFiducialErrors || values.quietZoneErrors > 2) {
    return rejected("invalid_geometry", values);
  }

  const bootstrapRect: ModuleRect = {
    x: (ACTIVE_MODULES - BOOTSTRAP_COLUMNS) / 2,
    y: 14,
    width: BOOTSTRAP_COLUMNS,
    height: BOOTSTRAP_ROWS,
  };
  const bootstrap = decodeBootstrap(sampleBinaryRect(sampler, bootstrapRect, anchors));
  if (bootstrap === null) return rejected("invalid_bootstrap", values);
  if (bootstrap.version !== PHY_VERSION) return rejected("unsupported_version", values);
  const profile = resolveProfile(bootstrap.profileId, options.profiles);
  if (profile === undefined) return rejected("unsupported_profile", values);
  const palette = getColor4Palette(bootstrap.paletteId);
  if (palette === undefined) return rejected("unsupported_palette", values);
  const paletteId = palette.id;
  const layout = createPhysicalLayout(profile);

  const timing = countTimingErrors(sampler, layout, anchors);
  values.timingErrors = timing.errors;
  values.timingModules = timing.modules;
  if (timing.errors / timing.modules > thresholds.maximumTimingErrorRate) {
    return rejected("invalid_geometry", values);
  }

  const topPhase = decodePhasePilot(sampleBinaryRect(sampler, layout.phasePilots.top, anchors));
  const bottomPhase = decodePhasePilot(
    sampleBinaryRect(sampler, layout.phasePilots.bottom, anchors),
  );
  if (
    topPhase === null ||
    bottomPhase === null ||
    topPhase !== bottomPhase ||
    topPhase !== bootstrap.sequencePhase
  ) {
    return rejected("phase_mismatch", values);
  }

  const model = buildCalibration(sampler, layout, paletteId);
  values.calibrationMad = model.mad;
  values.observedContrast = model.contrast;
  values.minimumPaletteDistance = model.minimumPaletteDistance;
  if (
    model.contrast < thresholds.minimumContrast ||
    model.minimumPaletteDistance < thresholds.minimumPaletteDistance
  ) {
    return rejected("calibration_failed", values);
  }

  const dynamicMaximumDeltaE = Math.min(
    45,
    Math.max(thresholds.maximumDeltaE, thresholds.maximumDeltaE + model.mad * 6),
  );
  const dynamicMinimumGap = Math.max(thresholds.minimumDeltaEGap, model.mad * 2 + 4);
  const codedBytes = new Uint8Array(profile.codedBytes);
  const erasures: number[] = [];
  let cell = 0;
  let totalBestDeltaE = 0;

  for (let byteIndex = 0; byteIndex < codedBytes.length; byteIndex++) {
    let byte = 0;
    let byteErased = false;
    for (let dibitIndex = 0; dibitIndex < 4; dibitIndex++) {
      const column = cell % profile.columns;
      const row = Math.floor(cell / profile.columns);
      const position = profile.columns === 1 ? 0.5 : column / (profile.columns - 1);
      const raw = sampler.sampleActive(layout.data.x + column, layout.data.y + row);
      const cellAnchors = interpolatedAnchors(model, position);
      const normalized = normalizedWithAnchors(raw, cellAnchors.black, cellAnchors.white);
      const centroids = [0, 1, 2, 3].map((candidate) =>
        targetAt(model, paletteId, candidate, position),
      );
      const classified = classifyLabCell(
        normalized,
        centroids,
        dynamicMaximumDeltaE,
        dynamicMinimumGap,
      );
      byte = (byte << 2) | classified.dibit;
      if (classified.erased) {
        byteErased = true;
        values.uncertainCells++;
      }
      totalBestDeltaE += classified.bestDeltaE;
      values.maximumBestDeltaE = Math.max(values.maximumBestDeltaE, classified.bestDeltaE);
      cell++;
    }
    codedBytes[byteIndex] = byte;
    if (byteErased) erasures.push(byteIndex);
  }

  values.erasureBytes = erasures.length;
  values.meanBestDeltaE = totalBestDeltaE / (profile.columns * profile.rows);
  return Object.freeze({
    status: "valid",
    profile,
    paletteId,
    sequencePhase: bootstrap.sequencePhase,
    codedBytes,
    byteErasures: Uint16Array.from(erasures),
    diagnostics: freezeDiagnostics(values),
  });
}
